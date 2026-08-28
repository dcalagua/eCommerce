-- =============================================================================
-- P09-SaaS · 1/3 — El dominio de PAGOS: modelo, guardas y aislamiento
--
-- ## Que problema resuelve esta migracion
--
-- Hasta P08 el pedido nacia con `payment_status = 'pending'` y ahi se quedaba
-- hasta que una persona lo movia a mano desde el backoffice. El gancho
-- `noPaymentGateway` del pipeline (P07) devolvia `not_required`, que era la
-- verdad: no habia con que cobrar. Aqui aparece el dominio que falta, y la
-- decision de diseno que lo gobierna todo cabe en una frase:
--
--   **El dominio de pedidos no puede enterarse de que existe una pasarela.**
--
-- Por eso ni `orders` ni `order_items` cambian en esta fase. Un pago apunta al
-- pedido; el pedido no apunta al pago. Añadir un proveedor real es escribir un
-- adaptador y sembrar una fila en `integration_providers` — cero migraciones
-- sobre el pedido, que es literalmente la Definition of Done de P09.
--
-- ## Las siete piezas y por que son siete y no una
--
--   payment_methods       QUE puede usar el comprador. Config PUBLICA del
--                         tenant: nombre, tipo, orden, si captura sola. Ningun
--                         secreto: las credenciales son `secret_ref` de
--                         `tenant_integrations`, que ya existe desde P12.
--   payment_intents       LA INTENCION de cobrar un importe. Nace ANTES que el
--                         pedido —el checkout autoriza en la etapa 8 y crea el
--                         pedido en la 9— y por eso `order_id` es nullable y se
--                         ata despues. Es tambien el ancla de idempotencia.
--   payment_attempts      CADA llamada al proveedor, con su resultado. Un
--                         intento con tres reintentos son tres filas: sin esto
--                         "¿por que se cobro dos veces?" no tiene respuesta.
--   payments              EL DINERO QUE SE COBRO. Separado del intento porque
--                         un intento puede capturar en dos veces y porque una
--                         devolucion se hace contra el cobro, no contra la
--                         intencion.
--   refunds               LA DEVOLUCION, con su propia idempotencia. Nunca un
--                         `UPDATE payments SET amount = amount - x`: eso borra
--                         la historia que la conciliacion necesita.
--   payment_events        LA BITACORA append-only del dominio: que dijo el
--                         proveedor, cuando, y si la firma valido.
--   reconciliation_records  LO QUE EL PROVEEDOR DICE QUE LIQUIDO. Se importa y
--                         se cruza contra `payments` por referencia externa.
--
-- ## Las tres reglas que aqui se vuelven imposibles de romper
--
-- 1. **Nunca un PAN ni un CVV.** No es una convencion de revision de codigo: es
--    un CHECK con Luhn (`ebim.jsonb_is_card_safe`). Un payload con un numero de
--    tarjeta valido dentro NO ENTRA en la base, aunque lo inserte
--    `service_role`. Esto es lo que hace que "PCI por delegacion" sea una
--    propiedad verificable y no una promesa.
-- 2. **Los secretos son referencias.** `provider_token_ref` tiene el mismo
--    formato que `tenant_integrations.secret_ref` (`^[A-Z][A-Z0-9_]{2,80}$`):
--    un nombre de variable del vault, no un valor.
-- 3. **El estado del pago NO lo escribe nadie con sesion.** Ni `anon` ni
--    `authenticated` tienen INSERT/UPDATE/DELETE sobre intentos, intentos de
--    cobro, cobros, devoluciones ni eventos. Se lee, y punto. Escribir es
--    llamar a un comando de la migracion 120100. Es la misma decision que P08
--    tomo con los ejes del pedido, por la misma razon y con la misma forma.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0 · Las guardas de datos sensibles.
--
-- Viven en `ebim` y son IMMUTABLE porque un CHECK no admite otra cosa. Ninguna
-- consulta una tabla: son funciones puras sobre el valor que se intenta
-- escribir.
-- ---------------------------------------------------------------------------

-- Claves que jamas pueden aparecer en un jsonb de este dominio, a ningun nivel.
-- Dos familias: datos de tarjeta (PCI) y credenciales (lo que ya prohibia
-- `tenant_integrations_no_secrets`, aqui recursivo en vez de solo en la raiz).
create or replace function ebim.sensitive_json_keys()
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select array[
    -- Datos de tarjeta. Ninguno de estos entra en esta base NUNCA.
    'pan', 'card_number', 'cardnumber', 'card_no', 'account_number',
    'cvv', 'cvc', 'cvn', 'cvv2', 'csc', 'security_code', 'card_security_code',
    'expiry', 'expiration', 'exp_month', 'exp_year', 'card_expiry',
    'track1', 'track2', 'track_data', 'magstripe', 'pin', 'pin_block',
    'cardholder_name',
    -- Credenciales. Lo que se guarda es la REFERENCIA al secreto, no el valor.
    'password', 'secret', 'api_key', 'apikey', 'token', 'access_token',
    'refresh_token', 'client_secret', 'private_key', 'signature_key'
  ]::text[];
$fn$;

-- ¿Este texto parece un numero de tarjeta?
--
-- Tres filtros en cascada, y el tercero es el que evita el falso positivo: 13 a
-- 19 digitos, forma plausible, y **Luhn valido**. Una marca de tiempo en
-- milisegundos tiene 13 digitos y casi nunca pasa Luhn; un PAN real siempre lo
-- pasa, porque es como se genera. Sin Luhn esta funcion rechazaria referencias
-- legitimas del proveedor y alguien acabaria apagando el CHECK.
create or replace function ebim.looks_like_pan(p_value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_digits text;
  v_sum    integer := 0;
  v_i      integer;
  v_d      integer;
  v_alt    boolean := false;
begin
  if p_value is null then
    return false;
  end if;
  -- Empieza por digito, y solo digitos, espacios o guiones. Un identificador
  -- del proveedor con letras o guiones bajos queda fuera desde aqui.
  if p_value !~ '^[0-9][0-9 -]{11,24}$' then
    return false;
  end if;

  v_digits := regexp_replace(p_value, '[^0-9]', '', 'g');
  if char_length(v_digits) < 13 or char_length(v_digits) > 19 then
    return false;
  end if;

  for v_i in reverse char_length(v_digits)..1 loop
    v_d := substr(v_digits, v_i, 1)::integer;
    if v_alt then
      v_d := v_d * 2;
      if v_d > 9 then
        v_d := v_d - 9;
      end if;
    end if;
    v_sum := v_sum + v_d;
    v_alt := not v_alt;
  end loop;

  return v_sum % 10 = 0;
end;
$fn$;

-- ¿Este jsonb esta limpio? Recorre objeto y array a cualquier profundidad y
-- dice que no si encuentra una clave prohibida o un valor con pinta de PAN.
--
-- Se usa como CHECK. Que la comprobacion viva en la BASE y no en la Edge
-- Function es deliberado: la funcion se puede desplegar mal, invocarse desde
-- otro sitio o saltarse con un insert directo de `service_role`; un CHECK, no.
create or replace function ebim.jsonb_is_card_safe(p_payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  with recursive nodes(k, v) as (
    select null::text, coalesce(p_payload, '{}'::jsonb)
    union all
    select c.k, c.v
    from nodes n
    cross join lateral (
      select je.key as k, je.value as v
      from jsonb_each(case when jsonb_typeof(n.v) = 'object' then n.v else '{}'::jsonb end) je
      union all
      select n.k as k, ae.value as v
      from jsonb_array_elements(case when jsonb_typeof(n.v) = 'array' then n.v else '[]'::jsonb end) ae
    ) c
  )
  select not exists (
    select 1
    from nodes
    where (nodes.k is not null and lower(nodes.k) = any (ebim.sensitive_json_keys()))
       or (jsonb_typeof(nodes.v) = 'string' and ebim.looks_like_pan(nodes.v #>> '{}'))
  );
$fn$;

-- Deja el jsonb limpio en vez de rechazarlo. Lo usa el ingestor de webhooks
-- antes de guardar el sobre crudo: el cuerpo que manda una pasarela no lo
-- controlamos nosotros, y rechazarlo entero perderia el evento — que es peor
-- que guardarlo redactado.
create or replace function ebim.redact_sensitive(p_payload jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_out jsonb;
  v_key text;
  v_val jsonb;
begin
  if p_payload is null then
    return null;
  end if;

  if jsonb_typeof(p_payload) = 'object' then
    v_out := '{}'::jsonb;
    for v_key, v_val in select key, value from jsonb_each(p_payload) loop
      if lower(v_key) = any (ebim.sensitive_json_keys()) then
        v_out := v_out || jsonb_build_object(v_key, '[redactado]');
      else
        v_out := v_out || jsonb_build_object(v_key, ebim.redact_sensitive(v_val));
      end if;
    end loop;
    return v_out;
  end if;

  if jsonb_typeof(p_payload) = 'array' then
    return coalesce(
      (select jsonb_agg(ebim.redact_sensitive(e)) from jsonb_array_elements(p_payload) e),
      '[]'::jsonb);
  end if;

  if jsonb_typeof(p_payload) = 'string' and ebim.looks_like_pan(p_payload #>> '{}') then
    return to_jsonb('[redactado]'::text);
  end if;

  return p_payload;
end;
$fn$;

revoke execute on function
  ebim.sensitive_json_keys(), ebim.looks_like_pan(text),
  ebim.jsonb_is_card_safe(jsonb), ebim.redact_sensitive(jsonb)
from public;

-- Las cuatro las evaluan CHECKs y funciones que corren como el llamante, asi
-- que el permiso lo necesita quien escribe, no el owner.
grant execute on function
  ebim.sensitive_json_keys(), ebim.looks_like_pan(text),
  ebim.jsonb_is_card_safe(jsonb), ebim.redact_sensitive(jsonb)
to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1 · El vocabulario. Enums y no texto libre, misma razon que P08: un estado
-- que se puede escribir mal es un estado que alguien escribira mal.
-- ---------------------------------------------------------------------------

-- Familia del medio de pago. NO es el proveedor: `card` lo sirven tres
-- pasarelas distintas y `bank_transfer` no lo sirve ninguna.
create type public.payment_method_kind as enum (
  'card',
  'wallet',
  'bank_transfer',
  'cash',
  'credit',        -- credito del cliente B2B: lo cobra el comercio, no una pasarela
  'other'
);

-- Autorizar y capturar en un paso o en dos. Es una propiedad del MEDIO, no del
-- proveedor: la misma pasarela puede configurarse de las dos formas.
create type public.payment_capture_mode as enum ('automatic', 'manual');

-- Ciclo de la INTENCION de cobro. `requires_action` es 3DS, redireccion o
-- cualquier paso que exige al comprador salir de la tienda.
create type public.payment_intent_status as enum (
  'open',
  'processing',
  'requires_action',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'expired'
);

-- Resultado de UNA llamada al proveedor. `timeout` es de primera clase y no un
-- `failed` con texto: un tiempo agotado NO dice que no se cobro, dice que no se
-- sabe, y esa diferencia decide si se reintenta o si se consulta el estado.
create type public.payment_attempt_status as enum (
  'pending',
  'succeeded',
  'declined',
  'failed',
  'timeout'
);

-- Estado del DINERO ya cobrado.
create type public.payment_record_status as enum (
  'captured',
  'partially_refunded',
  'refunded'
);

create type public.refund_status as enum (
  'requested',
  'processing',
  'succeeded',
  'failed',
  'cancelled'
);

-- De donde salio el hecho. `provider_webhook` es lo unico que puede mover
-- dinero sin que nadie lo pida; `browser_return` existe para poder registrar la
-- vuelta del comprador SIN que decida nada (regla 6 de la fase).
create type public.payment_event_source as enum (
  'provider_response',
  'provider_webhook',
  'browser_return',
  'operator',
  'system'
);

create type public.reconciliation_status as enum (
  'unmatched',
  'matched',
  'discrepancy',
  'ignored'
);

-- ---------------------------------------------------------------------------
-- 2 · Clave de apoyo sobre el catalogo de conectores.
--
-- Permite que `payment_methods` exija con una FK —no con un trigger— que su
-- proveedor sea de familia `payment`. Es el mismo truco del PIM (P03):
-- columna denormalizada + CHECK + FK a una clave de apoyo del padre.
-- ---------------------------------------------------------------------------
alter table public.integration_providers
  add constraint integration_providers_code_kind_key unique (code, kind);

-- ---------------------------------------------------------------------------
-- 3 · payment_methods — lo que el comprador puede elegir.
--
-- `provider_code` es NULLABLE a proposito: transferencia bancaria y contra
-- entrega son medios de pago reales que no tienen pasarela detras y que un
-- comercio de esta region usa mas que la tarjeta. Sin proveedor, la captura la
-- confirma una persona (`capture_mode = 'manual'`), que es exactamente lo que
-- pasa cuando el dinero entra por el banco.
-- ---------------------------------------------------------------------------
create table public.payment_methods (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  -- Codigo del TENANT, no del producto: "transferencia", "tarjeta", "billetera".
  code            text        not null,
  kind            public.payment_method_kind not null default 'other',
  display_name    text        not null,
  -- Proveedor del catalogo global. NULL = medio offline sin pasarela.
  provider_code   text,
  -- Denormalizada para que la FK compuesta pueda exigir familia `payment`.
  provider_kind   public.integration_kind not null default 'payment',
  capture_mode    public.payment_capture_mode not null default 'automatic',
  is_active       boolean     not null default false,
  position        integer     not null default 100,
  -- Config PUBLICA: lo que el storefront puede pintar y lo que el adaptador
  -- necesita que no sea secreto (moneda soportada, importe minimo, textos).
  -- El CHECK rechaza credenciales y datos de tarjeta a cualquier profundidad.
  public_config   jsonb       not null default '{}'::jsonb,
  -- Instrucciones para el comprador de un medio offline ("transfiere a...").
  instructions    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint payment_methods_code_fmt check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint payment_methods_name_len check (char_length(btrim(display_name)) between 1 and 120),
  constraint payment_methods_instructions_len
    check (instructions is null or char_length(instructions) <= 2000),
  constraint payment_methods_position check (position between 0 and 9999),
  constraint payment_methods_provider_kind check (provider_kind = 'payment'),
  -- Sin pasarela no hay a quien pedirle una captura automatica: la confirma
  -- una persona cuando ve el dinero. Permitir `automatic` aqui seria dar por
  -- cobrado un pedido que nadie ha cobrado.
  constraint payment_methods_offline_is_manual
    check (provider_code is not null or capture_mode = 'manual'),
  constraint payment_methods_config_safe check (ebim.jsonb_is_card_safe(public_config)),
  constraint payment_methods_code_unique unique (store_id, code),
  -- Clave de apoyo para las FK compuestas de los hijos.
  constraint payment_methods_store_key unique (id, store_id),
  constraint payment_methods_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint payment_methods_provider_fk foreign key (provider_code, provider_kind)
    references public.integration_providers (code, kind) on delete restrict
);

create index payment_methods_tenant on public.payment_methods (organization_id, company_id);
create index payment_methods_store_active
  on public.payment_methods (store_id, position) where is_active;

-- ---------------------------------------------------------------------------
-- 4 · payment_intents — la intencion de cobrar.
--
-- Nace SIN pedido y se ata despues, porque el checkout autoriza en la etapa 8 y
-- crea el pedido en la 9 (P07). Invertirlo —crear el pedido y luego cobrar—
-- produce el pedido fantasma que nadie pago, que es peor que la autorizacion
-- huerfana: la autorizacion se anula sola, el pedido no.
--
-- `idempotency_key` unica por tienda: es la MISMA clave que ancla el intento de
-- checkout, asi que un reintento del navegador encuentra su intento de pago y
-- no abre uno nuevo. Es la regla 5 de la fase (un callback repetido no duplica
-- nada) aplicada tambien a la ida, no solo a la vuelta.
-- ---------------------------------------------------------------------------
create table public.payment_intents (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,
  company_id        uuid        not null,
  store_id          uuid        not null,
  -- Se rellena cuando el pedido existe. El pedido NO apunta al intento: el
  -- dominio de pedidos no sabe que esto existe.
  order_id          uuid,
  payment_method_id uuid        not null,
  -- Copia del proveedor del medio en el momento del intento. Si mañana el
  -- tenant cambia de pasarela, este intento sigue diciendo por donde se cobro.
  provider_code     text,
  currency          char(3)     not null,
  amount            numeric(14,2) not null,
  amount_authorized numeric(14,2) not null default 0,
  amount_captured   numeric(14,2) not null default 0,
  amount_refunded   numeric(14,2) not null default 0,
  status            public.payment_intent_status not null default 'open',
  capture_mode      public.payment_capture_mode  not null default 'automatic',
  idempotency_key   text        not null,
  -- Como se llama esto del lado del proveedor. Es lo que se cita al conciliar.
  provider_reference text,
  -- REFERENCIA al token del proveedor en el vault, nunca el token. Mismo
  -- formato que `tenant_integrations.secret_ref` para que sea evidente que es
  -- un nombre de variable y no un valor.
  provider_token_ref text,
  -- Codigo del proveedor tal cual, SIN traducir: se guarda para conciliar y
  -- diagnosticar. El texto que ve el comprador sale de i18n.
  last_error_code   text,
  last_error_detail text,
  expires_at        timestamptz,
  authorized_at     timestamptz,
  captured_at       timestamptz,
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint payment_intents_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint payment_intents_amount_positive check (amount > 0),
  constraint payment_intents_amounts_non_negative
    check (amount_authorized >= 0 and amount_captured >= 0 and amount_refunded >= 0),
  -- Ni se captura mas de lo autorizado ni se devuelve mas de lo capturado. La
  -- aritmetica del dinero se defiende en la base: un adaptador con un bug no
  -- puede dejar la cifra imposible escrita.
  constraint payment_intents_capture_le_amount check (amount_captured <= amount),
  constraint payment_intents_refund_le_capture check (amount_refunded <= amount_captured),
  constraint payment_intents_idem_fmt check (char_length(idempotency_key) between 8 and 200),
  constraint payment_intents_token_ref_fmt
    check (provider_token_ref is null or provider_token_ref ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  constraint payment_intents_reference_len
    check (provider_reference is null or char_length(provider_reference) between 1 and 200),
  constraint payment_intents_error_len
    check (last_error_detail is null or char_length(last_error_detail) <= 2000),
  -- Una referencia del proveedor NO puede parecer un numero de tarjeta.
  constraint payment_intents_reference_safe
    check (provider_reference is null or not ebim.looks_like_pan(provider_reference)),
  constraint payment_intents_idem_unique unique (store_id, idempotency_key),
  constraint payment_intents_store_key unique (id, store_id),
  constraint payment_intents_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint payment_intents_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete set null,
  constraint payment_intents_method_fk foreign key (payment_method_id, store_id)
    references public.payment_methods (id, store_id) on delete restrict
);

create index payment_intents_tenant on public.payment_intents (organization_id, company_id);
create index payment_intents_order  on public.payment_intents (order_id) where order_id is not null;
create index payment_intents_store_status
  on public.payment_intents (store_id, status, created_at desc);
-- La ruta caliente del webhook: "¿de quien es esta referencia?". Unica, porque
-- una referencia del proveedor que apuntara a dos intentos haria imposible
-- decidir cual cobrar.
create unique index payment_intents_provider_ref
  on public.payment_intents (provider_code, provider_reference)
  where provider_reference is not null;

-- ---------------------------------------------------------------------------
-- 5 · payment_attempts — cada llamada, con su resultado.
--
-- Append-only. Es la respuesta a "¿por que este cobro fallo?" y a "¿esto se
-- intento dos veces o una?", y es la mitad del criterio de aceptacion de la
-- fase: la UI de admin tiene que poder enseñar intentos y fallos.
-- ---------------------------------------------------------------------------
create table public.payment_attempts (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,
  company_id        uuid        not null,
  store_id          uuid        not null,
  payment_intent_id uuid        not null,
  attempt_no        integer     not null,
  -- Operacion CANONICA, el mismo vocabulario que `integration_outbox`.
  operation         text        not null,
  status            public.payment_attempt_status not null default 'pending',
  provider_code     text,
  provider_reference text,
  -- El codigo del proveedor SIN traducir. Ni se interpreta ni se normaliza:
  -- es lo que se cita cuando hay que llamar al banco.
  provider_result_code text,
  error_code        text,
  error_detail      text,
  latency_ms        integer,
  -- La clave con la que se llamo al proveedor. Repetirla no vuelve a llamar.
  idempotency_key   text        not null,
  created_at        timestamptz not null default now(),
  constraint payment_attempts_operation_fmt
    check (operation ~ '^payment\.[a-z][a-z0-9_]*$'),
  constraint payment_attempts_attempt_no check (attempt_no between 1 and 1000),
  constraint payment_attempts_latency check (latency_ms is null or latency_ms >= 0),
  constraint payment_attempts_idem_fmt check (char_length(idempotency_key) between 8 and 200),
  constraint payment_attempts_error_len
    check (error_detail is null or char_length(error_detail) <= 2000),
  constraint payment_attempts_reference_safe
    check (provider_reference is null or not ebim.looks_like_pan(provider_reference)),
  constraint payment_attempts_no_unique unique (payment_intent_id, attempt_no),
  -- Idempotencia real: la misma operacion con la misma clave es UNA fila.
  constraint payment_attempts_idem_unique
    unique (payment_intent_id, operation, idempotency_key),
  constraint payment_attempts_intent_fk foreign key (payment_intent_id, store_id)
    references public.payment_intents (id, store_id) on delete cascade,
  constraint payment_attempts_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index payment_attempts_tenant on public.payment_attempts (organization_id, company_id);
create index payment_attempts_intent
  on public.payment_attempts (payment_intent_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 6 · payments — el dinero que si se cobro.
--
-- Tabla aparte del intento porque una captura parcial, una segunda captura o un
-- cobro que llega por webhook horas despues son filas distintas del mismo
-- intento. Y porque una devolucion se hace contra UN cobro: sin esta tabla,
-- "devuelveme el segundo pago" no se puede expresar.
-- ---------------------------------------------------------------------------
create table public.payments (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,
  company_id        uuid        not null,
  store_id          uuid        not null,
  payment_intent_id uuid        not null,
  order_id          uuid,
  amount            numeric(14,2) not null,
  amount_refunded   numeric(14,2) not null default 0,
  currency          char(3)     not null,
  status            public.payment_record_status not null default 'captured',
  provider_code     text,
  provider_reference text,
  captured_at       timestamptz not null default now(),
  -- Conciliacion: se rellenan cuando el proveedor liquida. Sin nombre de banco
  -- por ningun lado — es una referencia de liquidacion, y punto.
  settlement_reference text,
  settled_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint payments_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint payments_amount_positive check (amount > 0),
  constraint payments_refund_bounds check (amount_refunded >= 0 and amount_refunded <= amount),
  -- El estado y la cifra no se pueden contradecir: un cobro "devuelto entero"
  -- con la mitad devuelta es una fila que miente.
  constraint payments_status_matches_amount check (
    (status = 'captured'           and amount_refunded = 0) or
    (status = 'partially_refunded' and amount_refunded > 0 and amount_refunded < amount) or
    (status = 'refunded'           and amount_refunded = amount)
  ),
  constraint payments_reference_safe
    check (provider_reference is null or not ebim.looks_like_pan(provider_reference)),
  constraint payments_settlement_safe
    check (settlement_reference is null or not ebim.looks_like_pan(settlement_reference)),
  constraint payments_store_key unique (id, store_id),
  constraint payments_intent_fk foreign key (payment_intent_id, store_id)
    references public.payment_intents (id, store_id) on delete cascade,
  constraint payments_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete set null,
  constraint payments_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index payments_tenant on public.payments (organization_id, company_id);
create index payments_order  on public.payments (order_id) where order_id is not null;
create index payments_store_captured on public.payments (store_id, captured_at desc);
-- Un cobro por referencia del proveedor. Es lo que hace que un webhook
-- repetido no cree un segundo cobro: el indice lo impide, no un `if`.
create unique index payments_provider_ref
  on public.payments (provider_code, provider_reference)
  where provider_reference is not null;
create index payments_settlement
  on public.payments (settlement_reference) where settlement_reference is not null;

-- ---------------------------------------------------------------------------
-- 7 · refunds — la devolucion, con su idempotencia propia.
-- ---------------------------------------------------------------------------
create table public.refunds (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  payment_id      uuid        not null,
  order_id        uuid,
  amount          numeric(14,2) not null,
  currency        char(3)     not null,
  reason          text,
  status          public.refund_status not null default 'requested',
  idempotency_key text        not null,
  provider_code   text,
  provider_reference text,
  -- Quien la AUTORIZO. Una devolucion es dinero saliendo: sin actor no hay
  -- trazabilidad y el criterio de la fase pide "refund autorizado".
  requested_by    uuid,
  requested_email text,
  error_code      text,
  error_detail    text,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint refunds_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint refunds_amount_positive check (amount > 0),
  constraint refunds_reason_len check (reason is null or char_length(reason) <= 1000),
  constraint refunds_email_len check (requested_email is null or char_length(requested_email) <= 320),
  constraint refunds_idem_fmt check (char_length(idempotency_key) between 8 and 200),
  constraint refunds_error_len check (error_detail is null or char_length(error_detail) <= 2000),
  constraint refunds_reference_safe
    check (provider_reference is null or not ebim.looks_like_pan(provider_reference)),
  constraint refunds_idem_unique unique (store_id, idempotency_key),
  constraint refunds_store_key unique (id, store_id),
  constraint refunds_payment_fk foreign key (payment_id, store_id)
    references public.payments (id, store_id) on delete cascade,
  constraint refunds_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete set null,
  constraint refunds_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index refunds_tenant on public.refunds (organization_id, company_id);
create index refunds_payment on public.refunds (payment_id, created_at desc);
create index refunds_store_status on public.refunds (store_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- 8 · payment_events — la bitacora del dominio, append-only.
--
-- NO sustituye a `integration_inbox` (P12): esa es la deduplicacion del
-- TRANSPORTE —el sobre crudo que llego, con su unicidad por
-- (proveedor, id externo)—, y esta es la linea de tiempo del DOMINIO, tipada y
-- redactada. Un webhook escribe las dos en la misma transaccion y la autoridad
-- de "ya lo vi" sigue siendo la del transporte. Dos tablas, dos preguntas
-- distintas, una sola arquitectura.
-- ---------------------------------------------------------------------------
create table public.payment_events (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,
  company_id        uuid        not null,
  store_id          uuid        not null,
  payment_intent_id uuid,
  payment_id        uuid,
  refund_id         uuid,
  -- Mismo formato que `domain_events.event_type`: son el mismo vocabulario.
  event_type        text        not null,
  source            public.payment_event_source not null,
  provider_code     text,
  external_event_id text,
  -- ¿Venia firmado y la firma validaba? Un evento de pasarela con esto en
  -- `false` NO puede mover dinero, y hay una funcion que lo impone.
  signature_verified boolean    not null default false,
  payload           jsonb       not null default '{}'::jsonb,
  note              text,
  created_at        timestamptz not null default now(),
  constraint payment_events_type_fmt
    check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint payment_events_note_len check (note is null or char_length(note) <= 1000),
  constraint payment_events_payload_safe check (ebim.jsonb_is_card_safe(payload)),
  constraint payment_events_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint payment_events_intent_fk foreign key (payment_intent_id, store_id)
    references public.payment_intents (id, store_id) on delete cascade,
  constraint payment_events_payment_fk foreign key (payment_id, store_id)
    references public.payments (id, store_id) on delete cascade,
  constraint payment_events_refund_fk foreign key (refund_id, store_id)
    references public.refunds (id, store_id) on delete cascade
);

create index payment_events_tenant on public.payment_events (organization_id, company_id);
create index payment_events_intent
  on public.payment_events (payment_intent_id, created_at desc)
  where payment_intent_id is not null;
create unique index payment_events_external
  on public.payment_events (provider_code, external_event_id)
  where external_event_id is not null;

-- ---------------------------------------------------------------------------
-- 9 · reconciliation_records — lo que el proveedor dice que liquido.
--
-- Sin `store_id`: una liquidacion es de la SOCIEDAD y de su cuenta de comercio,
-- no de una tienda — igual que `warehouses` en P06. El vinculo con la tienda
-- llega por el cobro con el que casa.
--
-- Nada aqui nombra a un banco concreto: `external_reference` y
-- `settlement_date` son el minimo comun de cualquier liquidacion, y `raw`
-- guarda la fila del extracto tal cual la mando quien sea.
-- ---------------------------------------------------------------------------
create table public.reconciliation_records (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  provider_code   text        not null,
  settlement_date date        not null,
  -- Como llama el proveedor a la operacion. Es la unica llave del cruce.
  external_reference text     not null,
  gross_amount    numeric(14,2) not null,
  fee_amount      numeric(14,2) not null default 0,
  net_amount      numeric(14,2) not null,
  currency        char(3)     not null,
  status          public.reconciliation_status not null default 'unmatched',
  payment_id      uuid        references public.payments (id) on delete set null,
  matched_at      timestamptz,
  discrepancy_reason text,
  -- Identificador del lote/extracto de origen. Texto: cada proveedor lo llama
  -- de una manera y cerrarlo en un enum obligaria a migrar por cada uno.
  source_batch    text,
  raw             jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint reconciliation_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint reconciliation_reference_len
    check (char_length(btrim(external_reference)) between 1 and 200),
  constraint reconciliation_reference_safe
    check (not ebim.looks_like_pan(external_reference)),
  constraint reconciliation_amounts check (gross_amount >= 0 and fee_amount >= 0),
  constraint reconciliation_discrepancy_len
    check (discrepancy_reason is null or char_length(discrepancy_reason) <= 1000),
  constraint reconciliation_raw_safe check (ebim.jsonb_is_card_safe(raw)),
  -- Reimportar el mismo extracto no duplica filas. Es la idempotencia de la
  -- conciliacion, y sin ella el segundo intento de una carga cuadra el doble.
  constraint reconciliation_unique
    unique (organization_id, company_id, provider_code, external_reference),
  constraint reconciliation_provider_fk foreign key (provider_code)
    references public.integration_providers (code) on delete restrict
);

create index reconciliation_tenant on public.reconciliation_records (organization_id, company_id);
create index reconciliation_pending
  on public.reconciliation_records (provider_code, settlement_date)
  where status = 'unmatched';
create index reconciliation_payment
  on public.reconciliation_records (payment_id) where payment_id is not null;

-- ---------------------------------------------------------------------------
-- 10 · updated_at
-- ---------------------------------------------------------------------------
create trigger payment_methods_updated_at before update on public.payment_methods
  for each row execute function ebim.set_updated_at();
create trigger payment_intents_updated_at before update on public.payment_intents
  for each row execute function ebim.set_updated_at();
create trigger payments_updated_at before update on public.payments
  for each row execute function ebim.set_updated_at();
create trigger refunds_updated_at before update on public.refunds
  for each row execute function ebim.set_updated_at();
create trigger reconciliation_records_updated_at before update on public.reconciliation_records
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 11 · La maquina de estados del intento.
--
-- Misma forma que `ebim.assert_order_axes` (P08) y por la misma razon: la
-- autoridad tiene que estar donde nadie la pueda rodear. El adaptador de una
-- pasarela puede tener un bug; el trigger, no.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_payment_intent_transition()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_allowed text[];
begin
  if new.status is distinct from old.status then
    v_allowed := case old.status
      when 'open'            then array['processing','requires_action','authorized','captured','failed','cancelled','expired']
      when 'processing'      then array['requires_action','authorized','captured','failed','cancelled','expired']
      when 'requires_action' then array['processing','authorized','captured','failed','cancelled','expired']
      -- Autorizado sin capturar: o se captura, o se anula, o caduca. Ese es el
      -- valor de separar los dos pasos (regla 7 de la fase). `processing`
      -- vuelve a ser destino porque una captura contra pasarela se ENCOLA: el
      -- intento queda en vuelo hasta que el trabajador del outbox conteste.
      when 'authorized'      then array['processing','captured','cancelled','failed','expired']
      -- Capturado es TERMINAL para el intento. Una devolucion no lo mueve: vive
      -- en `payments` y en `refunds`, que es donde esta el dinero.
      when 'captured'        then array[]::text[]
      when 'failed'          then array['processing','cancelled']
      else array[]::text[]
    end;
    if not (new.status::text = any (v_allowed)) then
      raise exception 'PAGO_INTENTO_TRANSICION_INVALIDA: % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  -- El importe de un intento NO se reescribe. Cobrar otra cifra es otro
  -- intento: si se pudiera editar, el importe autorizado y el capturado
  -- dejarian de poder compararse con nada.
  if new.amount is distinct from old.amount then
    raise exception 'PAGO_IMPORTE_INMUTABLE: el importe de un intento no se cambia'
      using errcode = '23514';
  end if;
  if new.currency is distinct from old.currency then
    raise exception 'PAGO_MONEDA_INMUTABLE: la moneda de un intento no se cambia'
      using errcode = '23514';
  end if;

  if new.status = 'authorized' and new.authorized_at is null then
    new.authorized_at := now();
  end if;
  if new.status = 'captured' and new.captured_at is null then
    new.captured_at := now();
    if new.authorized_at is null then
      new.authorized_at := now();
    end if;
  end if;
  if new.status in ('cancelled', 'expired') and new.cancelled_at is null then
    new.cancelled_at := now();
  end if;

  return new;
end;
$fn$;

create trigger payment_intents_transition before update on public.payment_intents
  for each row execute function ebim.assert_payment_intent_transition();

-- ---------------------------------------------------------------------------
-- 12 · La bitacora es append-only, tambien para `service_role`.
--
-- Misma decision que el snapshot del pedido en P08: `force row level security`
-- no basta porque `service_role` tiene BYPASSRLS. Un trigger si le alcanza.
-- ---------------------------------------------------------------------------
create or replace function ebim.reject_payment_log_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'BITACORA_INMUTABLE: los eventos e intentos de pago no se modifican ni se borran'
    using errcode = '42501';
end;
$fn$;

create trigger payment_events_append_only
  before update or delete on public.payment_events
  for each row execute function ebim.reject_payment_log_rewrite();

create trigger payment_attempts_append_only
  before update or delete on public.payment_attempts
  for each row execute function ebim.reject_payment_log_rewrite();

-- ---------------------------------------------------------------------------
-- 13 · RLS. Default deny, `force`, y NADIE con sesion escribe dinero.
--
-- `payment_methods` es la unica que el backoffice escribe directamente: es
-- configuracion, no dinero. Todo lo demas se lee y se mueve con los comandos de
-- la migracion 120100.
-- ---------------------------------------------------------------------------
alter table public.payment_methods         enable row level security;
alter table public.payment_methods         force  row level security;
alter table public.payment_intents         enable row level security;
alter table public.payment_intents         force  row level security;
alter table public.payment_attempts        enable row level security;
alter table public.payment_attempts        force  row level security;
alter table public.payments                enable row level security;
alter table public.payments                force  row level security;
alter table public.refunds                 enable row level security;
alter table public.refunds                 force  row level security;
alter table public.payment_events          enable row level security;
alter table public.payment_events          force  row level security;
alter table public.reconciliation_records  enable row level security;
alter table public.reconciliation_records  force  row level security;

revoke all on public.payment_methods, public.payment_intents, public.payment_attempts,
              public.payments, public.refunds, public.payment_events,
              public.reconciliation_records
  from public, anon, authenticated;

grant all on public.payment_methods, public.payment_intents, public.payment_attempts,
             public.payments, public.refunds, public.payment_events,
             public.reconciliation_records
  to service_role;

-- El backoffice MIRA todo el dominio y CONFIGURA solo los medios.
grant select on public.payment_intents, public.payment_attempts, public.payments,
                public.refunds, public.payment_events, public.reconciliation_records
  to authenticated;
grant select, insert, update, delete on public.payment_methods to authenticated;

-- El comprador anonimo ve UNICAMENTE que medios hay y como se llaman. Ni el
-- proveedor, ni la config, ni el modo de captura: eso es informacion del
-- comercio, no de la compra.
grant select (id, store_id, code, kind, display_name, position, instructions)
  on public.payment_methods to anon;

create policy payment_methods_select_member on public.payment_methods
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy payment_methods_select_public on public.payment_methods
  for select to anon
  using (
    is_active
    and exists (
      select 1 from public.stores s
      where s.id = payment_methods.store_id and s.status = 'active'
    )
  );

create policy payment_methods_insert_admin on public.payment_methods
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy payment_methods_update_admin on public.payment_methods
  for update to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy payment_methods_delete_admin on public.payment_methods
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy payment_intents_select_member on public.payment_intents
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy payment_attempts_select_member on public.payment_attempts
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy payments_select_member on public.payments
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy refunds_select_member on public.refunds
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy payment_events_select_member on public.payment_events
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy reconciliation_select_member on public.reconciliation_records
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- ---------------------------------------------------------------------------
-- 14 · La vista publica de medios de pago.
--
-- `security_invoker`: no amplia ni un permiso, se apoya en la policy `to anon`
-- y en el GRANT por columna de arriba. El comprador ve que puede elegir; que
-- pasarela hay detras y como esta configurada no sale de aqui.
-- ---------------------------------------------------------------------------
create view public.public_payment_methods
with (security_invoker = on) as
select
  m.id       as payment_method_id,
  m.store_id,
  m.code,
  m.kind,
  m.display_name,
  m.position,
  m.instructions
from public.payment_methods m;

revoke all on public.public_payment_methods from public;
grant select on public.public_payment_methods to anon, authenticated, service_role;

comment on view public.public_payment_methods is
  'Medios de pago publicables de una tienda activa. Sin proveedor, sin config y sin modo de captura.';

-- ---------------------------------------------------------------------------
-- 15 · Comentarios: la parte del contrato que se lee desde psql.
-- ---------------------------------------------------------------------------
comment on table public.payment_methods is
  'Config PUBLICA de los medios de pago del tenant. Las credenciales son secret_ref de tenant_integrations, nunca estan aqui.';
comment on column public.payment_methods.provider_code is
  'NULL = medio offline (transferencia, contra entrega): sin pasarela y con captura confirmada por una persona.';
comment on table public.payment_intents is
  'La intencion de cobrar. Nace antes que el pedido y se ata despues: el dominio de pedidos no sabe que esto existe.';
comment on column public.payment_intents.provider_token_ref is
  'REFERENCIA al token del proveedor en el vault, nunca el token. Mismo formato que tenant_integrations.secret_ref.';
comment on table public.payment_attempts is
  'Cada llamada al proveedor con su resultado. Append-only incluso para service_role: es la respuesta a por que se cobro dos veces.';
comment on column public.payment_attempts.status is
  'timeout es de primera clase: no dice que no se cobro, dice que no se sabe. Esa diferencia decide si se reintenta o se consulta.';
comment on table public.payments is
  'El dinero cobrado. Tabla aparte del intento porque una captura parcial o un segundo cobro son filas distintas del mismo intento.';
comment on table public.refunds is
  'La devolucion, con idempotencia propia. Nunca un UPDATE payments SET amount: eso borra la historia que la conciliacion necesita.';
comment on table public.payment_events is
  'Linea de tiempo del dominio de pagos. La deduplicacion del transporte sigue siendo de integration_inbox: dos preguntas, una arquitectura.';
comment on table public.reconciliation_records is
  'Lo que el proveedor dice que liquido. Se cruza con payments por referencia externa; ningun banco concreto aparece en el modelo.';
