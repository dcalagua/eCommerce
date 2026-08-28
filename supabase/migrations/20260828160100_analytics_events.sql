-- =============================================================================
-- P13-SaaS · 2/6 — Los NUEVE hechos canonicos de analitica comercial
--
-- ## La linea que separa esta tabla de `domain_events`
--
-- `domain_events` (P07) es un OUTBOX: cada fila es un aviso que alguien tiene
-- que ENTREGAR, con estado, reintentos y cola muerta. Vaciarla es lo correcto.
-- `analytics_events` no se entrega a nadie y no se vacia: es la serie temporal
-- sobre la que se calculan los indicadores, y una fila procesada sigue valiendo
-- igual dentro de un año. Meterlas en la misma tabla obligaria a elegir entre
-- perder el historico o llevar una cola con millones de filas «procesadas».
--
-- Y la separacion que la fase exige explicitamente —«sin acoplar analitica
-- comercial a logs tecnicos»— es la otra: los logs tecnicos y los incidentes
-- viven en `ops_events` (migracion 160400) y no aqui. Un fallo de integracion
-- no es un hecho comercial y no puede ensuciar una tasa de conversion.
--
-- ## Quien emite cada hecho, y por que no es el navegador quien emite todos
--
-- Solo TRES de los nueve los emite la vitrina, y son los tres que unicamente
-- existen en la pantalla:
--
--   product_view · search · add_to_cart
--
-- Los otros seis los emite un TRIGGER del servidor sobre el hecho que ya se
-- escribe hoy:
--
--   checkout_started    insert en `checkout_intents`
--   checkout_completed  `checkout_intents.status` -> 'succeeded'
--   order_created       insert en `orders`
--   order_completed     `orders.fulfillment_status` -> 'fulfilled'
--   cart_abandoned      `carts.status` -> 'abandoned'  (ya lo hace `ebim.expire_due_carts`)
--   promotion_used      insert en `promotion_redemptions`
--
-- Dos consecuencias, y las dos son el motivo:
--
--   1. **Un embudo que el navegador no puede falsear.** Si el ratio de
--      conversion dependiera de un `checkout_completed` que manda el cliente,
--      cualquiera con la consola abierta podria moverlo, y —mucho mas comun—
--      un adblocker o una pestaña cerrada a destiempo lo perderia. El
--      denominador y el numerador salen del MISMO sitio del que sale el pedido.
--   2. **Ni una linea de `create_order`, `checkout_place_order` ni
--      `redeem_promotions` cambia.** Los seis hechos se derivan de escrituras
--      que ya ocurren. Es la regla 4 del contrato de ejecucion aplicada al pie
--      de la letra.
--
-- La puerta publica (`public.track_events_for_slug`) RECHAZA los seis hechos de
-- servidor: pedirlos desde el navegador es un error explicito, no un evento
-- duplicado en silencio.
--
-- ## PII
--
-- Esta tabla NO tiene `customer_email`, ni `customer_name`, ni `customer_id`, y
-- hay un test que falla si alguna aparece. Lo que identifica una visita es
-- `session_hash`: el resumen sha256 del identificador opaco que manda la
-- vitrina, nunca el identificador. Sirve para saber que dos vistas son la misma
-- sesion, que es todo lo que un embudo necesita, y no sirve para saber quien es.
--
-- `props` y `search_term` pasan por `ebim.redact_pii` en la puerta Y por un
-- CHECK en la tabla. Dos veces a proposito: la puerta se puede rodear con un
-- insert de `service_role`; el CHECK, no.
-- =============================================================================

create type public.analytics_event_type as enum (
  'product_view',
  'search',
  'add_to_cart',
  'checkout_started',
  'checkout_completed',
  'cart_abandoned',
  'order_created',
  'order_completed',
  'promotion_used'
);

/** Quien escribio el hecho. No es decorativo: decide cuanto se puede confiar en el. */
create type public.analytics_source as enum ('storefront', 'server');

-- ---------------------------------------------------------------------------
-- analytics_events
--
-- Sin FK hacia producto, pedido, carrito ni campana —solo hacia `stores` y
-- `channels`—, y es deliberado: la analitica tiene que sobrevivir al borrado de
-- un producto. Es la misma decision, y por el mismo motivo, que
-- `price_change_events` (P04): una bitacora con FK en cascada es una bitacora
-- que se borra sola justo cuando hace falta.
--
-- La contrapartida —que un id declarado por el navegador podria no ser de esta
-- tienda— la cubre la puerta publica, que valida producto y variante contra el
-- catalogo de la tienda antes de escribir. Sin FK, pero no sin comprobacion.
-- ---------------------------------------------------------------------------
create table public.analytics_events (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  channel_id      uuid,
  event_type      public.analytics_event_type not null,
  source          public.analytics_source     not null,
  occurred_at     timestamptz not null default now(),
  -- sha256 del identificador opaco de la visita. NUNCA el identificador.
  session_hash    text,
  -- El sujeto del hecho. Cada tipo exige el suyo (ver `analytics_events_shape`).
  product_id      uuid,
  variant_id      uuid,
  cart_id         uuid,
  order_id        uuid,
  promotion_id    uuid,
  -- Solo para `search`. Redactado si trae dentro un correo o una tarjeta.
  search_term     text,
  result_count    integer,
  quantity        integer,
  currency        char(3),
  -- Importe del hecho, cuando lo tiene. `numeric`, jamas float (decision P02).
  value           numeric(14,2),
  correlation_id  text        default ebim.correlation_id(),
  -- Idempotencia de los hechos de SERVIDOR: reprocesar una fila no cuenta dos
  -- pedidos. Los de vitrina no la llevan — dos vistas de la misma ficha son
  -- dos hechos, no uno repetido.
  event_key       text,
  props           jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),

  constraint analytics_events_session_fmt
    check (session_hash is null or session_hash ~ '^[a-f0-9]{64}$'),
  constraint analytics_events_correlation_fmt
    check (correlation_id is null or correlation_id ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  constraint analytics_events_key_len
    check (event_key is null or char_length(event_key) between 8 and 200),
  constraint analytics_events_currency_fmt check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint analytics_events_value_sign   check (value is null or value >= 0),
  constraint analytics_events_quantity     check (quantity is null or quantity > 0),
  constraint analytics_events_result_count check (result_count is null or result_count >= 0),
  constraint analytics_events_term_len
    check (search_term is null or char_length(search_term) between 1 and 200),
  -- Las dos guardas de PII, como CHECK y no solo en la puerta.
  constraint analytics_events_term_clean
    check (search_term is null
           or (not ebim.looks_like_email(search_term) and not ebim.looks_like_pan(search_term))),
  constraint analytics_events_props_object check (jsonb_typeof(props) = 'object'),
  constraint analytics_events_props_clean  check (ebim.jsonb_is_pii_free(props)),
  -- Cada tipo trae su sujeto. Un `product_view` sin producto no es un hecho,
  -- es una fila que alguien tendra que interpretar dentro de un año.
  constraint analytics_events_shape check (
    case event_type
      when 'product_view'       then product_id  is not null
      when 'search'             then search_term is not null
      when 'add_to_cart'        then product_id  is not null
      when 'checkout_started'   then true
      when 'checkout_completed' then order_id    is not null
      when 'cart_abandoned'     then cart_id     is not null
      when 'order_created'      then order_id    is not null
      when 'order_completed'    then order_id    is not null
      when 'promotion_used'     then promotion_id is not null
    end
  ),
  constraint analytics_events_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint analytics_events_channel_fk foreign key (channel_id, store_id)
    references public.channels (id, store_id) on delete set null (channel_id)
);

create index analytics_events_tenant_idx on public.analytics_events (organization_id, company_id);
create index analytics_events_store_time_idx
  on public.analytics_events (store_id, occurred_at desc);
create index analytics_events_store_type_idx
  on public.analytics_events (store_id, event_type, occurred_at desc);
create index analytics_events_session_idx
  on public.analytics_events (store_id, session_hash) where session_hash is not null;
create index analytics_events_product_idx
  on public.analytics_events (store_id, product_id, occurred_at desc) where product_id is not null;
create index analytics_events_correlation_idx
  on public.analytics_events (correlation_id) where correlation_id is not null;
-- La idempotencia de los hechos de servidor es el INDICE, no una comprobacion
-- previa: entre comprobar y escribir cabe otro proceso (misma regla que
-- `domain_events.dedupe_key`).
create unique index analytics_events_key_unique
  on public.analytics_events (store_id, event_key) where event_key is not null;

-- ---------------------------------------------------------------------------
-- ebim.record_analytics_event — la UNICA escritura.
--
-- SECURITY DEFINER porque la tabla esta en default deny y no tiene ni una
-- policy de INSERT: ni el comercio ni el comprador escriben aqui directamente.
-- Los triggers de servidor la llaman, y la puerta publica tambien.
--
-- Idempotente por `event_key` cuando lo trae: `on conflict do nothing`. Un
-- reproceso no infla las ventas.
-- ---------------------------------------------------------------------------
create or replace function ebim.record_analytics_event(
  p_organization_id uuid,
  p_company_id      uuid,
  p_store_id        uuid,
  p_event_type      public.analytics_event_type,
  p_source          public.analytics_source,
  p_channel_id      uuid    default null,
  p_session_hash    text    default null,
  p_product_id      uuid    default null,
  p_variant_id      uuid    default null,
  p_cart_id         uuid    default null,
  p_order_id        uuid    default null,
  p_promotion_id    uuid    default null,
  p_search_term     text    default null,
  p_result_count    integer default null,
  p_quantity        integer default null,
  p_currency        text    default null,
  p_value           numeric default null,
  p_props           jsonb   default '{}'::jsonb,
  p_event_key       text    default null,
  p_occurred_at     timestamptz default null,
  p_correlation_id  text    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id text;
begin
  insert into public.analytics_events (
    organization_id, company_id, store_id, channel_id, event_type, source,
    occurred_at, session_hash, product_id, variant_id, cart_id, order_id,
    promotion_id, search_term, result_count, quantity, currency, value,
    props, event_key, correlation_id
  ) values (
    p_organization_id, p_company_id, p_store_id, p_channel_id, p_event_type, p_source,
    coalesce(p_occurred_at, now()),
    p_session_hash, p_product_id, p_variant_id, p_cart_id, p_order_id,
    p_promotion_id,
    ebim.redact_text(p_search_term, 200),
    p_result_count, p_quantity,
    upper(nullif(btrim(coalesce(p_currency, '')), '')),
    p_value,
    ebim.redact_pii(coalesce(p_props, '{}'::jsonb)),
    p_event_key,
    coalesce(p_correlation_id, ebim.correlation_id())
  )
  on conflict do nothing
  returning id::text into v_id;

  return ebim.safe_uuid(v_id);
end;
$fn$;

revoke execute on function ebim.record_analytics_event(
  uuid, uuid, uuid, public.analytics_event_type, public.analytics_source, uuid, text,
  uuid, uuid, uuid, uuid, uuid, text, integer, integer, text, numeric, jsonb, text,
  timestamptz, text
) from public, anon, authenticated;

grant execute on function ebim.record_analytics_event(
  uuid, uuid, uuid, public.analytics_event_type, public.analytics_source, uuid, text,
  uuid, uuid, uuid, uuid, uuid, text, integer, integer, text, numeric, jsonb, text,
  timestamptz, text
) to service_role;

-- =============================================================================
-- Los SEIS hechos de servidor. Triggers sobre lo que ya se escribe.
-- =============================================================================

-- checkout_started / checkout_completed --------------------------------------
--
-- El denominador de la conversion es el numero de intentos, y el numerador el
-- de intentos que acabaron en pedido. Los dos salen de `checkout_intents`, o
-- sea de la MISMA fila: no hay forma de que se desincronicen.
create or replace function ebim.analytics_on_checkout_intent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    perform ebim.record_analytics_event(
      p_organization_id => new.organization_id,
      p_company_id      => new.company_id,
      p_store_id        => new.store_id,
      p_event_type      => 'checkout_started',
      p_source          => 'server',
      p_cart_id         => new.cart_id,
      p_event_key       => 'checkout_started:' || new.id::text,
      p_occurred_at     => new.created_at,
      p_correlation_id  => new.correlation_id);
    return null;
  end if;

  if new.status = 'succeeded' and old.status is distinct from 'succeeded'
     and new.order_id is not null then
    perform ebim.record_analytics_event(
      p_organization_id => new.organization_id,
      p_company_id      => new.company_id,
      p_store_id        => new.store_id,
      p_event_type      => 'checkout_completed',
      p_source          => 'server',
      p_cart_id         => new.cart_id,
      p_order_id        => new.order_id,
      p_event_key       => 'checkout_completed:' || new.id::text,
      p_correlation_id  => new.correlation_id);
  end if;

  return null;
end;
$fn$;

create trigger checkout_intents_analytics_insert
  after insert on public.checkout_intents
  for each row execute function ebim.analytics_on_checkout_intent();

create trigger checkout_intents_analytics_update
  after update of status on public.checkout_intents
  for each row execute function ebim.analytics_on_checkout_intent();

-- order_created / order_completed --------------------------------------------
--
-- `order_completed` es el eje de ENTREGA llegando a `fulfilled`, no el de
-- cobro. Son dos hechos distintos y colapsarlos haria imposible la pregunta que
-- de verdad se hace un comercio —«¿cuanto vendi?» frente a «¿cuanto entregue?»—.
-- El dinero cobrado tiene su propio indicador (`sales`, sobre `payment_status`)
-- y no necesita un evento para calcularse: esta en la fila del pedido.
create or replace function ebim.analytics_on_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    perform ebim.record_analytics_event(
      p_organization_id => new.organization_id,
      p_company_id      => new.company_id,
      p_store_id        => new.store_id,
      p_channel_id      => new.channel_id,
      p_event_type      => 'order_created',
      p_source          => 'server',
      p_order_id        => new.id,
      p_currency        => new.currency,
      p_value           => new.grand_total,
      p_props           => jsonb_build_object('source_channel', new.source_channel::text),
      p_event_key       => 'order_created:' || new.id::text,
      p_occurred_at     => new.placed_at,
      p_correlation_id  => new.correlation_id);
    return null;
  end if;

  if new.fulfillment_status = 'fulfilled'
     and old.fulfillment_status is distinct from 'fulfilled' then
    perform ebim.record_analytics_event(
      p_organization_id => new.organization_id,
      p_company_id      => new.company_id,
      p_store_id        => new.store_id,
      p_channel_id      => new.channel_id,
      p_event_type      => 'order_completed',
      p_source          => 'server',
      p_order_id        => new.id,
      p_currency        => new.currency,
      p_value           => new.grand_total,
      p_event_key       => 'order_completed:' || new.id::text,
      p_correlation_id  => new.correlation_id);
  end if;

  return null;
end;
$fn$;

create trigger orders_analytics_insert
  after insert on public.orders
  for each row execute function ebim.analytics_on_order();

create trigger orders_analytics_update
  after update of fulfillment_status on public.orders
  for each row execute function ebim.analytics_on_order();

-- cart_abandoned --------------------------------------------------------------
--
-- «cuando sea inferible» es literal: el hecho se emite cuando el carrito ya
-- esta marcado `abandoned`, cosa que hace `ebim.expire_due_carts` al vencer su
-- caducidad o `public.cart_abandon` cuando el comprador lo suelta. Esta fase no
-- inventa un criterio nuevo de abandono ni toca el que existe.
--
-- Un carrito VACIO no se cuenta: nunca hubo intencion de compra que abandonar,
-- y meterlo en el denominador hincharia la tasa sin que significara nada.
create or replace function ebim.analytics_on_cart()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_lines integer;
  v_value numeric(14,2);
begin
  if new.status <> 'abandoned' or old.status is not distinct from 'abandoned' then
    return null;
  end if;

  select count(*)::integer,
         -- `unit_price_snapshot` puede ser NULL (linea nunca cotizada): el
         -- importe abandonado es entonces incompleto, y decirlo con NULL es
         -- mas honesto que decir cero. `sum` ya ignora los nulos; lo que se
         -- vigila es que no salga un importe que finge ser el total.
         sum(ci.quantity * ci.unit_price_snapshot)::numeric(14,2)
    into v_lines, v_value
    from public.cart_items ci
   where ci.cart_id = new.id;

  if coalesce(v_lines, 0) = 0 then
    return null;
  end if;

  perform ebim.record_analytics_event(
    p_organization_id => new.organization_id,
    p_company_id      => new.company_id,
    p_store_id        => new.store_id,
    p_channel_id      => new.channel_id,
    p_event_type      => 'cart_abandoned',
    p_source          => 'server',
    p_cart_id         => new.id,
    p_currency        => new.currency,
    p_value           => v_value,
    p_props           => jsonb_build_object('line_count', v_lines),
    p_event_key       => 'cart_abandoned:' || new.id::text);

  return null;
end;
$fn$;

create trigger carts_analytics_abandoned
  after update of status on public.carts
  for each row execute function ebim.analytics_on_cart();

-- promotion_used ---------------------------------------------------------------
--
-- `promotion_redemptions` tiene `customer_email` y `customer_id`. NO se copian.
-- Lo que la analitica necesita saber de un canje es que campana fue, cuanto
-- descontó y si vino de un cupon; a quien se le aplico ya esta en el dominio de
-- promociones, con su propia RLS y su propio motivo para existir.
create or replace function ebim.analytics_on_promotion_redemption()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform ebim.record_analytics_event(
    p_organization_id => new.organization_id,
    p_company_id      => new.company_id,
    p_store_id        => new.store_id,
    p_event_type      => 'promotion_used',
    p_source          => 'server',
    p_order_id        => new.order_id,
    p_promotion_id    => new.promotion_id,
    p_currency        => new.currency,
    p_value           => new.discount_amount,
    p_props           => jsonb_build_object('from_coupon', new.coupon_id is not null),
    p_event_key       => 'promotion_used:' || new.id::text,
    p_occurred_at     => new.redeemed_at);
  return null;
end;
$fn$;

create trigger promotion_redemptions_analytics
  after insert on public.promotion_redemptions
  for each row execute function ebim.analytics_on_promotion_redemption();

-- =============================================================================
-- La puerta de la VITRINA. Tres hechos, y ni uno mas.
-- =============================================================================

/**
 * Cast defensivo de entero, hermano de `ebim.safe_uuid` (P02) y por la misma
 * razon: lo que llega es JSON de fuera. Un `"quantity": "muchas"` tiene que
 * quedar en NULL, no tumbar la llamada con un error de cast que ademas no
 * explica nada al que lo lee.
 */
create or replace function ebim.safe_int(p_value text)
returns integer
language sql
immutable
set search_path = ''
as $fn$
  select case
    when btrim(coalesce(p_value, '')) ~ '^-?[0-9]{1,9}$' then btrim(p_value)::integer
  end;
$fn$;

revoke execute on function ebim.safe_int(text) from public;
grant  execute on function ebim.safe_int(text) to anon, authenticated, service_role;

/** Los unicos tipos que un navegador puede declarar. */
create or replace function ebim.storefront_event_types()
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select array['product_view', 'search', 'add_to_cart']::text[];
$fn$;

-- ---------------------------------------------------------------------------
-- public.track_events_for_slug — hermana de `price_quote_for_slug`.
--
-- Cinco reglas, y ninguna es opcional:
--
--  1. **El tenant sale del SLUG**, nunca del cuerpo. Es la misma resolucion que
--     usa toda la vitrina desde P02 (`ebim.active_store_by_slug`).
--  2. **Solo tres tipos.** Pedir `order_created` desde el navegador es
--     `ANALYTICS_EVENTO_NO_PERMITIDO`, no un evento aceptado en silencio: un
--     pedido inventado en la serie temporal es un KPI que miente.
--  3. **Producto y variante se comprueban contra el catalogo de ESTA tienda.**
--     Sin FK que lo garantice (la tabla no las tiene, a proposito), la
--     comprobacion la hace la puerta.
--  4. **El identificador de sesion se hashea aqui dentro.** Lo que entra no es
--     lo que se guarda.
--  5. **Como mucho 20 hechos por llamada.** Un lote sin techo es una forma
--     barata de llenar la tabla de otro.
--
-- Devuelve cuantos entro, no los ids: la vitrina no tiene nada que hacer con el
-- id de un evento de analitica, y devolverselo le daria un asa para intentar
-- corregirlo.
-- ---------------------------------------------------------------------------
create or replace function public.track_events_for_slug(
  p_store_slug text,
  p_session    text,
  p_events     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store    public.stores%rowtype;
  v_channel  public.channels%rowtype;
  v_session  text;
  v_event    jsonb;
  v_type     text;
  v_product  uuid;
  v_variant  uuid;
  v_written  integer := 0;
begin
  v_store   := ebim.active_store_by_slug(p_store_slug);
  v_channel := ebim.public_channel(v_store.id);

  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'ANALYTICS_LOTE_INVALIDO: se espera una lista de hechos'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_events) = 0 then
    return jsonb_build_object('recorded', 0);
  end if;

  if jsonb_array_length(p_events) > 20 then
    raise exception 'ANALYTICS_LOTE_EXCESIVO: como mucho 20 hechos por llamada'
      using errcode = '22023';
  end if;

  -- El identificador de visita entra crudo y NO se guarda crudo. Si no tiene la
  -- forma esperada se descarta entero: media sesion mal formada no vale mas que
  -- ninguna, y admitir cualquier texto convierte el campo en un cajon.
  v_session := nullif(btrim(coalesce(p_session, '')), '');
  if v_session is not null and v_session ~ '^[A-Za-z0-9_-]{16,128}$' then
    v_session := ebim.hash_token(v_session);
  else
    v_session := null;
  end if;

  for v_event in select value from jsonb_array_elements(p_events) loop
    v_type := lower(btrim(coalesce(v_event ->> 'type', '')));

    if not (v_type = any (ebim.storefront_event_types())) then
      raise exception 'ANALYTICS_EVENTO_NO_PERMITIDO: la vitrina no puede declarar el hecho %', v_type
        using errcode = '22023';
    end if;

    v_product := ebim.safe_uuid(v_event ->> 'product_id');
    v_variant := ebim.safe_uuid(v_event ->> 'variant_id');

    if v_product is not null
       and not exists (select 1 from public.products p
                        where p.id = v_product and p.store_id = v_store.id) then
      raise exception 'ANALYTICS_REFERENCIA_INVALIDA: ese producto no es de esta tienda'
        using errcode = '22023';
    end if;

    if v_variant is not null
       and not exists (select 1 from public.product_variants pv
                        where pv.id = v_variant and pv.store_id = v_store.id) then
      raise exception 'ANALYTICS_REFERENCIA_INVALIDA: esa variante no es de esta tienda'
        using errcode = '22023';
    end if;

    perform ebim.record_analytics_event(
      p_organization_id => v_store.organization_id,
      p_company_id      => v_store.company_id,
      p_store_id        => v_store.id,
      p_event_type      => v_type::public.analytics_event_type,
      p_source          => 'storefront',
      p_channel_id      => v_channel.id,
      p_session_hash    => v_session,
      p_product_id      => v_product,
      p_variant_id      => v_variant,
      p_search_term     => nullif(btrim(coalesce(v_event ->> 'term', '')), ''),
      p_result_count    => ebim.safe_int(v_event ->> 'result_count'),
      p_quantity        => ebim.safe_int(v_event ->> 'quantity'),
      p_props           => case when jsonb_typeof(v_event -> 'props') = 'object'
                                then v_event -> 'props' else '{}'::jsonb end);

    v_written := v_written + 1;
  end loop;

  return jsonb_build_object('recorded', v_written);
end;
$fn$;

revoke execute on function public.track_events_for_slug(text, text, jsonb) from public;
grant  execute on function public.track_events_for_slug(text, text, jsonb)
  to anon, authenticated, service_role;

revoke execute on function ebim.storefront_event_types() from public;
grant  execute on function ebim.storefront_event_types()
  to anon, authenticated, service_role;

-- =============================================================================
-- RLS — el comercio LEE su serie; nadie la escribe con un INSERT
-- =============================================================================
alter table public.analytics_events enable row level security;
alter table public.analytics_events force  row level security;

revoke all on public.analytics_events from public, anon, authenticated;
grant  all on public.analytics_events to service_role;
grant  select on public.analytics_events to authenticated;

create policy analytics_events_select_member on public.analytics_events
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- Nadie corrige un hecho. No es rigor decorativo: un embudo cuyo pasado se
-- puede editar no sirve para decidir nada, y la primera vez que un numero no
-- cuadre alguien intentara «arreglarlo» aqui. Misma forma que
-- `tracking_events` (P12) y `payment_events` (P09).
create or replace function ebim.reject_analytics_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'ANALITICA_INMUTABLE: un hecho de analitica no se modifica ni se borra'
    using errcode = '42501';
end;
$fn$;

create trigger analytics_events_append_only
  before update or delete on public.analytics_events
  for each row execute function ebim.reject_analytics_rewrite();

comment on table public.analytics_events is
  'Serie temporal de los nueve hechos canonicos de comercio. Sin PII: lo que identifica una visita es el sha256 de su identificador opaco. Append-only incluso para service_role.';
comment on column public.analytics_events.session_hash is
  'sha256 del identificador opaco de la visita. Sirve para agrupar, no para identificar: el valor crudo no entra nunca en esta base.';
comment on column public.analytics_events.event_key is
  'Idempotencia de los hechos de servidor. Reprocesar no cuenta dos pedidos. Los hechos de vitrina no la llevan: dos vistas son dos hechos.';
comment on function public.track_events_for_slug(text, text, jsonb) is
  'Puerta ANONIMA de la vitrina. Solo product_view, search y add_to_cart; el tenant sale del slug y el identificador de sesion se hashea aqui dentro.';
