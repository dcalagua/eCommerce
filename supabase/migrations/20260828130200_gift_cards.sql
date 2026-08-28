-- =============================================================================
-- P10-SaaS · 3/5 — Tarjetas regalo: saldo, movimientos, caducidad y trazabilidad
--
-- ## Por que NO es una promocion, y por que eso decide todo el diseno
--
-- Una promocion cambia el PRECIO: baja la base imponible, baja el impuesto y
-- baja el ingreso. Una tarjeta regalo no cambia el precio de nada: es un MEDIO
-- DE PAGO con saldo, como pagar la mitad en efectivo. Tratarla como descuento
-- —que es el atajo habitual— falsea tres cosas a la vez: el ingreso (la venta
-- SI se produjo por su importe completo), el impuesto (que se devengo entero) y
-- la deuda (el saldo emitido es un pasivo del comercio hasta que se gasta).
--
-- De ahi salen las decisiones de este archivo:
--
--  · el saldo NO toca `orders.discount_total` ni `order_items.discount_amount`;
--  · el canje se apunta contra el PEDIDO, no contra la linea;
--  · y el modulo vive aparte del motor de `20260828130100`, que no la conoce.
--
-- ## El codigo es un instrumento al portador
--
-- Quien tiene el codigo tiene el dinero. Por eso:
--
--  · `code` **no tiene GRANT de lectura para nadie** —ni `authenticated`—; el
--    backoffice ve `code_last4` y quien la emite recibe el codigo UNA vez, en
--    la respuesta del comando. Es el mismo GRANT POR COLUMNA con el que P02
--    saco `stock` de la vitrina y P06 los tokens de reserva.
--  · son 96 bits de entropia (24 caracteres hexadecimales en mayusculas), del
--    mismo `gen_random_uuid()` que ya usan `order_tokens` y `carts`: nucleo de
--    Postgres, sin depender de que `pgcrypto` este habilitada.
--  · se busca por la MISMA normalizacion que los cupones
--    (`ebim.normalize_promo_code`), asi que teclearlo con guiones o en
--    minusculas encuentra la misma tarjeta.
--
-- ## El saldo no se escribe, se mueve
--
-- Ningun rol tiene GRANT de escritura sobre `gift_cards`. Todo pasa por un
-- comando `SECURITY DEFINER` que bloquea la fila (`for update`), comprueba, y
-- escribe el movimiento Y el saldo en la MISMA sentencia. Es exactamente la
-- decision de P06 con la existencia y la de P09 con el dinero: dos comandos
-- simultaneos no pueden gastar el mismo ultimo sol.
--
-- `gift_card_transactions` es el libro mayor: append-only, con el saldo
-- resultante en cada asiento. Sin el, "el saldo es 40" es una afirmacion que
-- nadie puede auditar.
-- =============================================================================

create type public.gift_card_status as enum ('active', 'depleted', 'expired', 'cancelled');

-- `expire` y `cancel` son movimientos y no solo estados: llevar el saldo a cero
-- por caducidad mueve dinero (deja de ser un pasivo) y eso tiene que estar en
-- el libro mayor como cualquier otro asiento.
create type public.gift_card_movement as enum
  ('issue', 'redeem', 'refund', 'adjust', 'expire', 'cancel');

-- ---------------------------------------------------------------------------
-- ebim.new_gift_card_code — 96 bits en hexadecimal, seguro para teclear.
--
-- Mayusculas y solo alfanumerico: es lo que devuelve
-- `ebim.normalize_promo_code`, asi que la tarjeta se encuentra escriba el
-- comprador lo que escriba.
-- ---------------------------------------------------------------------------
create or replace function ebim.new_gift_card_code()
returns text
language sql
volatile
set search_path = ''
as $fn$
  select upper(
    substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) ||
    substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
$fn$;

revoke execute on function ebim.new_gift_card_code() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- gift_cards — el saldo.
-- ---------------------------------------------------------------------------
create table public.gift_cards (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  -- SIN GRANT de lectura para nadie. Ver el bloque de GRANT mas abajo.
  code            text        not null default ebim.new_gift_card_code(),
  -- Lo unico que se puede enseñar: los cuatro ultimos, para reconocerla.
  code_last4      text generated always as (right(code, 4)) stored,
  currency        char(3)     not null,
  initial_amount  numeric(14,2) not null,
  balance         numeric(14,2) not null,
  status          public.gift_card_status not null default 'active',
  -- A quien se emitio. Opcional: una tarjeta de regalo fisica no tiene dueno
  -- conocido hasta que alguien la usa, y exigirlo impediria venderlas en caja.
  issued_to_email text,
  -- La caducidad es OBLIGATORIA. Un saldo sin fecha es un pasivo eterno en el
  -- balance del comercio, y en casi toda jurisdiccion tiene plazo legal. Que la
  -- fecha exista no significa que sea corta: el comercio la elige.
  expires_at      timestamptz not null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint gift_cards_code_fmt   check (code ~ '^[A-Z0-9]{12,40}$'),
  constraint gift_cards_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint gift_cards_initial_positive check (initial_amount > 0),
  -- El saldo nunca es negativo: no se fia contra una tarjeta regalo.
  constraint gift_cards_balance_signs check (balance >= 0),
  constraint gift_cards_email_fmt
    check (issued_to_email is null or position('@' in issued_to_email) > 1),
  constraint gift_cards_notes_len check (notes is null or char_length(notes) <= 1000),
  -- Una tarjeta agotada con saldo, o una activa sin el, son dos formas de
  -- mentir sobre el pasivo. Se impiden aqui y no en el comando.
  constraint gift_cards_status_matches_balance check (
    (status = 'depleted' and balance = 0)
    or (status = 'active' and balance > 0)
    or status in ('expired', 'cancelled')
  ),
  constraint gift_cards_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint gift_cards_code_unique unique (store_id, code),
  constraint gift_cards_store_key   unique (id, store_id),
  constraint gift_cards_tenant_key  unique (id, organization_id, company_id)
);

create index gift_cards_tenant_idx on public.gift_cards (organization_id, company_id);
create index gift_cards_store_idx  on public.gift_cards (store_id, status, created_at desc);
create index gift_cards_email_idx
  on public.gift_cards (store_id, lower(issued_to_email)) where issued_to_email is not null;
create index gift_cards_expiry_idx
  on public.gift_cards (expires_at) where status = 'active';

-- ---------------------------------------------------------------------------
-- gift_card_transactions — el libro mayor.
--
-- Mismo patron que `inventory_movements` (P06): delta CON SIGNO y saldo
-- resultante en cada asiento. El saldo de la tarjeta y el ultimo
-- `balance_after` tienen que coincidir siempre, y coinciden porque los escribe
-- la misma sentencia.
--
-- `reference` es la IDEMPOTENCIA de negocio: el checkout pasa su clave de
-- idempotencia, asi que un reintento de la misma compra no gasta el saldo dos
-- veces. Es la misma idea que `inventory_reservations.reference_key` y que
-- `payments.provider_reference`.
-- ---------------------------------------------------------------------------
create table public.gift_card_transactions (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  gift_card_id    uuid        not null,
  kind            public.gift_card_movement not null,
  -- Con signo: emitir y devolver suman, canjear y caducar restan.
  amount          numeric(14,2) not null,
  balance_after   numeric(14,2) not null,
  -- Contra que pedido. Se rellena DESPUES de crear el pedido, igual que P09
  -- ata el cobro: en el checkout se canjea antes de que el pedido exista.
  order_id        uuid,
  reference       text,
  actor_id        uuid,
  actor_email     text,
  created_at      timestamptz not null default now(),

  constraint gift_card_transactions_amount_nonzero check (amount <> 0),
  constraint gift_card_transactions_balance_signs check (balance_after >= 0),
  constraint gift_card_transactions_reference_len
    check (reference is null or char_length(btrim(reference)) between 1 and 200),
  -- El signo lo impone el tipo de movimiento, no quien escribe.
  constraint gift_card_transactions_sign_matches_kind check (
    (kind in ('issue', 'refund') and amount > 0)
    or (kind in ('redeem', 'expire', 'cancel') and amount < 0)
    or kind = 'adjust'
  ),
  constraint gift_card_transactions_card_fk foreign key (gift_card_id, store_id)
    references public.gift_cards (id, store_id) on delete cascade,
  constraint gift_card_transactions_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete set null (order_id),
  constraint gift_card_transactions_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index gift_card_transactions_tenant_idx
  on public.gift_card_transactions (organization_id, company_id);
create index gift_card_transactions_card_idx
  on public.gift_card_transactions (gift_card_id, created_at desc);
create index gift_card_transactions_order_idx
  on public.gift_card_transactions (order_id) where order_id is not null;
-- La idempotencia de negocio: dos canjes con la misma referencia son uno.
create unique index gift_card_transactions_reference_key
  on public.gift_card_transactions (gift_card_id, reference) where reference is not null;

create trigger gift_cards_set_updated_at before update on public.gift_cards
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- ebim.gift_card_move — EL unico sitio donde el saldo cambia.
--
-- Bloquea la fila, comprueba lo que hay que comprobar y escribe el asiento y el
-- saldo juntos. Todos los comandos publicos de abajo delegan aqui, para que no
-- exista una segunda regla de saldo que se olvide de la caducidad.
--
-- Devuelve el asiento como jsonb; cuando la referencia ya existia devuelve el
-- ANTERIOR con `replay: true` y no mueve nada.
-- ---------------------------------------------------------------------------
create or replace function ebim.gift_card_move(
  p_gift_card_id uuid,
  p_kind         public.gift_card_movement,
  p_amount       numeric,
  p_reference    text default null,
  p_order_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_card    public.gift_cards%rowtype;
  v_ref     text := nullif(btrim(coalesce(p_reference, '')), '');
  v_prev    public.gift_card_transactions%rowtype;
  v_amount  numeric(14,2) := round(coalesce(p_amount, 0), 2);
  v_balance numeric(14,2);
  v_status  public.gift_card_status;
  v_tx      uuid;
begin
  select * into v_card from public.gift_cards g where g.id = p_gift_card_id for update;
  if not found then
    raise exception 'TARJETA_NO_ENCONTRADA: esa tarjeta regalo no existe'
      using errcode = '22023';
  end if;

  -- Idempotencia ANTES de cualquier comprobacion: un reintento de algo que ya
  -- se hizo tiene que devolver lo mismo aunque la tarjeta ya este agotada.
  if v_ref is not null then
    select * into v_prev
    from public.gift_card_transactions t
    where t.gift_card_id = v_card.id and t.reference = v_ref;
    if found then
      return jsonb_build_object(
        'transaction_id', v_prev.id,
        'gift_card_id',   v_card.id,
        'kind',           v_prev.kind,
        'amount',         v_prev.amount::text,
        'balance',        v_card.balance::text,
        'currency',       v_card.currency,
        'replay',         true);
    end if;
  end if;

  if v_amount = 0 then
    raise exception 'IMPORTE_INVALIDO: un movimiento de cero no es un movimiento'
      using errcode = '22023';
  end if;

  -- La caducidad se comprueba AL MOVER y no por un proceso periodico: este
  -- proyecto no tiene cron garantizado, y una tarjeta que caduco ayer no puede
  -- pagar hoy porque nadie paso a marcarla. Es la misma decision que P06 tomo
  -- con las reservas.
  if p_kind = 'redeem' then
    if v_card.status <> 'active' then
      raise exception 'TARJETA_NO_DISPONIBLE: la tarjeta esta %', v_card.status
        using errcode = '22023';
    end if;
    if v_card.expires_at <= now() then
      raise exception 'TARJETA_CADUCADA: esa tarjeta regalo caduco el %',
        to_char(v_card.expires_at, 'YYYY-MM-DD')
        using errcode = '22023';
    end if;
    if v_card.balance + v_amount < 0 then
      raise exception 'SALDO_INSUFICIENTE: la tarjeta tiene % y se pidieron %',
        v_card.balance, abs(v_amount)
        using errcode = '22023';
    end if;
  elsif p_kind in ('refund', 'adjust') then
    if v_card.status = 'cancelled' then
      raise exception 'TARJETA_NO_DISPONIBLE: la tarjeta esta cancelada'
        using errcode = '22023';
    end if;
    if v_card.balance + v_amount < 0 then
      raise exception 'SALDO_INSUFICIENTE: el ajuste dejaria la tarjeta en negativo'
        using errcode = '22023';
    end if;
  end if;

  v_balance := v_card.balance + v_amount;

  v_status := case
    when p_kind = 'cancel' then 'cancelled'::public.gift_card_status
    when p_kind = 'expire' then 'expired'::public.gift_card_status
    when v_card.status in ('cancelled', 'expired') then v_card.status
    when v_balance = 0 then 'depleted'::public.gift_card_status
    else 'active'::public.gift_card_status
  end;

  insert into public.gift_card_transactions (
    organization_id, company_id, store_id, gift_card_id,
    kind, amount, balance_after, order_id, reference, actor_id, actor_email
  ) values (
    v_card.organization_id, v_card.company_id, v_card.store_id, v_card.id,
    p_kind, v_amount, v_balance, p_order_id, v_ref, ebim.user_id(), ebim.email()
  )
  returning id into v_tx;

  update public.gift_cards
     set balance = v_balance, status = v_status
   where id = v_card.id;

  return jsonb_build_object(
    'transaction_id', v_tx,
    'gift_card_id',   v_card.id,
    'kind',           p_kind,
    'amount',         v_amount::text,
    'balance',        v_balance::text,
    'currency',       v_card.currency,
    'status',         v_status,
    'replay',         false);
end;
$fn$;

revoke execute on function
  ebim.gift_card_move(uuid, public.gift_card_movement, numeric, text, uuid)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.gift_card_issue — emitir. Backoffice, con rol Y capacidad.
--
-- Devuelve el CODIGO en la respuesta y esa es la unica vez que sale de la base:
-- despues ya no hay forma de leerlo, ni siquiera con el rol mas alto, porque el
-- GRANT por columna no lo incluye. Si se pierde, se anula y se emite otra —que
-- es lo que hace cualquier emisor serio de instrumentos al portador—.
-- ---------------------------------------------------------------------------
create or replace function public.gift_card_issue(
  p_store_id   uuid,
  p_amount     numeric,
  p_expires_at timestamptz default null,
  p_email      text        default null,
  p_notes      text        default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store  public.stores%rowtype;
  v_amount numeric(14,2) := round(coalesce(p_amount, 0), 2);
  v_expiry timestamptz := coalesce(p_expires_at, now() + interval '1 year');
  v_card   public.gift_cards%rowtype;
begin
  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    raise exception 'TIENDA_NO_ENCONTRADA: la tienda no existe' using errcode = '22023';
  end if;

  -- Autorizacion DENTRO (leccion esupplier-030): rol y capacidad, los dos.
  if not ebim.has_role(v_store.organization_id, v_store.company_id,
                       array['owner','admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: tu rol no puede emitir tarjetas regalo'
      using errcode = '42501';
  end if;
  if not ebim.has_capability(v_store.organization_id, v_store.company_id, 'promotions') then
    raise exception 'MODULO_NO_CONTRATADO: promociones no esta en el plan de esta sociedad'
      using errcode = '42501';
  end if;

  if v_amount <= 0 then
    raise exception 'IMPORTE_INVALIDO: el importe tiene que ser mayor que cero'
      using errcode = '22023';
  end if;
  if v_expiry <= now() then
    raise exception 'CADUCIDAD_INVALIDA: una tarjeta que nace caducada no sirve a nadie'
      using errcode = '22023';
  end if;

  insert into public.gift_cards (
    organization_id, company_id, store_id, currency,
    initial_amount, balance, issued_to_email, expires_at, notes
  ) values (
    v_store.organization_id, v_store.company_id, v_store.id, v_store.currency,
    v_amount, v_amount, lower(nullif(btrim(coalesce(p_email, '')), '')), v_expiry,
    nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning * into v_card;

  insert into public.gift_card_transactions (
    organization_id, company_id, store_id, gift_card_id,
    kind, amount, balance_after, actor_id, actor_email
  ) values (
    v_card.organization_id, v_card.company_id, v_card.store_id, v_card.id,
    'issue', v_amount, v_amount, ebim.user_id(), ebim.email()
  );

  return jsonb_build_object(
    'gift_card_id', v_card.id,
    -- La UNICA vez que el codigo sale de la base.
    'code',         v_card.code,
    'last4',        v_card.code_last4,
    'balance',      v_card.balance::text,
    'currency',     v_card.currency,
    'expires_at',   v_card.expires_at);
end;
$fn$;

revoke execute on function
  public.gift_card_issue(uuid, numeric, timestamptz, text, text)
from public, anon;
grant execute on function
  public.gift_card_issue(uuid, numeric, timestamptz, text, text)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.gift_card_redeem — gastar saldo. SOLO servidor.
--
-- Revocada a `anon` y a `authenticated`: quien la llama es el checkout, que ya
-- sabe cuanto hay que cobrar. Si la pudiera llamar el navegador, el importe a
-- descontar lo decidiria el navegador — que es exactamente lo que el contrato
-- prohibe en cada fase de este repo.
--
-- La tarjeta se busca por CODIGO y por TIENDA: un codigo de otra tienda no
-- existe aqui, y el error no distingue entre "no existe" y "no es de esta
-- tienda" para no convertir la funcion en un detector de codigos ajenos.
-- ---------------------------------------------------------------------------
create or replace function public.gift_card_redeem(
  p_store_slug text,
  p_code       text,
  p_amount     numeric,
  p_reference  text,
  p_order_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_card  public.gift_cards%rowtype;
  v_want  numeric(14,2) := round(coalesce(p_amount, 0), 2);
  v_take  numeric(14,2);
  v_moved jsonb;
begin
  select * into v_store
  from public.stores s
  where lower(s.slug) = lower(btrim(coalesce(p_store_slug, ''))) and s.status = 'active';
  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda no existe o no esta activa'
      using errcode = '22023';
  end if;

  if v_want <= 0 then
    raise exception 'IMPORTE_INVALIDO: no se puede canjear cero'
      using errcode = '22023';
  end if;

  select * into v_card
  from public.gift_cards g
  where g.store_id = v_store.id
    and g.code = ebim.normalize_promo_code(p_code)
  for update;

  if not found then
    raise exception 'TARJETA_NO_ENCONTRADA: esa tarjeta regalo no existe'
      using errcode = '22023';
  end if;

  -- El ESTADO se comprueba antes que el saldo, y el orden importa: una tarjeta
  -- anulada tiene saldo cero, asi que mirar primero el saldo contestaria
  -- "sin saldo" a lo que en realidad es "esta tarjeta ya no vale". Son dos
  -- respuestas distintas para quien la tiene en la mano.
  if v_card.status <> 'active' then
    raise exception 'TARJETA_NO_DISPONIBLE: la tarjeta esta %', v_card.status
      using errcode = '22023';
  end if;
  if v_card.expires_at <= now() then
    raise exception 'TARJETA_CADUCADA: esa tarjeta regalo caduco el %',
      to_char(v_card.expires_at, 'YYYY-MM-DD')
      using errcode = '22023';
  end if;

  -- Nunca se toma mas que el saldo: pagar 100 con una tarjeta de 40 son 40 de
  -- tarjeta y 60 por la pasarela, no un error.
  v_take := least(v_want, v_card.balance);
  if v_take <= 0 then
    raise exception 'SALDO_INSUFICIENTE: la tarjeta no tiene saldo'
      using errcode = '22023';
  end if;

  v_moved := ebim.gift_card_move(v_card.id, 'redeem', -v_take, p_reference, p_order_id);

  return v_moved || jsonb_build_object(
    'applied',   (-1 * (v_moved ->> 'amount')::numeric)::text,
    'requested', v_want::text,
    'last4',     v_card.code_last4);
end;
$fn$;

revoke execute on function
  public.gift_card_redeem(text, text, numeric, text, uuid)
from public, anon, authenticated;
grant execute on function
  public.gift_card_redeem(text, text, numeric, text, uuid)
to service_role;

-- ---------------------------------------------------------------------------
-- public.gift_card_release — la COMPENSACION del checkout. Solo servidor.
--
-- La etapa 8 canjea antes de que el pedido exista. Si lo que viene despues
-- falla, el saldo hay que devolverlo: saldo gastado sin pedido detras es dinero
-- del comprador que se quedo el comercio. Es la misma pila de compensaciones
-- que suelta la reserva de existencia y anula el cobro.
--
-- `p_reference` es la del canje mas un sufijo, para que la devolucion sea
-- idempotente por su cuenta: reintentar la compensacion no abona dos veces.
-- ---------------------------------------------------------------------------
create or replace function public.gift_card_release(
  p_gift_card_id uuid,
  p_amount       numeric,
  p_reference    text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return ebim.gift_card_move(p_gift_card_id, 'refund', abs(round(coalesce(p_amount, 0), 2)),
                             p_reference, null);
end;
$fn$;

revoke execute on function public.gift_card_release(uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function public.gift_card_release(uuid, numeric, text) to service_role;

-- ---------------------------------------------------------------------------
-- public.gift_card_attach_order — atar el canje al pedido, DESPUES.
--
-- Mismo patron que `payment_intent_attach_order` de P09 y por la misma razon:
-- el orden real es canjear (etapa 8) y crear el pedido (etapa 9), asi que el
-- enlace solo se puede escribir al final. Es la UNICA escritura permitida sobre
-- un asiento del libro mayor, y solo sobre `order_id`.
--
-- Vive en `public` y no en `ebim` porque la llama el ADAPTADOR del checkout por
-- PostgREST, y PostgREST solo expone `public`. Una funcion de servidor en un
-- esquema que el borde no puede alcanzar es una funcion que nadie llama.
-- ---------------------------------------------------------------------------
create or replace function public.gift_card_attach_order(
  p_gift_card_id uuid,
  p_reference    text,
  p_order_id     uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_updated integer;
begin
  update public.gift_card_transactions t
     set order_id = p_order_id
   where t.gift_card_id = p_gift_card_id
     and t.reference    = nullif(btrim(coalesce(p_reference, '')), '')
     and t.order_id is null
     and exists (select 1 from public.orders o
                 where o.id = p_order_id and o.store_id = t.store_id);
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$fn$;

revoke execute on function public.gift_card_attach_order(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.gift_card_attach_order(uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- public.gift_card_adjust — corregir el saldo desde el backoffice.
--
-- Con signo: sirve para abonar una devolucion y para retirar un saldo emitido
-- por error. El motivo es OBLIGATORIO: un movimiento de dinero sin explicacion
-- es lo que convierte una bitacora en ruido.
-- ---------------------------------------------------------------------------
create or replace function public.gift_card_adjust(
  p_gift_card_id uuid,
  p_amount       numeric,
  p_reason       text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_card public.gift_cards%rowtype;
begin
  select * into v_card from public.gift_cards g where g.id = p_gift_card_id;
  if not found then
    raise exception 'TARJETA_NO_ENCONTRADA: esa tarjeta regalo no existe'
      using errcode = '22023';
  end if;

  if not ebim.has_role(v_card.organization_id, v_card.company_id,
                       array['owner','admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: tu rol no puede mover el saldo de una tarjeta regalo'
      using errcode = '42501';
  end if;
  if not ebim.has_capability(v_card.organization_id, v_card.company_id, 'promotions') then
    raise exception 'MODULO_NO_CONTRATADO: promociones no esta en el plan de esta sociedad'
      using errcode = '42501';
  end if;

  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'MOTIVO_REQUERIDO: un movimiento de saldo sin motivo no es auditable'
      using errcode = '22023';
  end if;

  return ebim.gift_card_move(
    v_card.id, 'adjust', round(coalesce(p_amount, 0), 2),
    'adjust:' || left(btrim(p_reason), 100) || ':' || gen_random_uuid()::text, null);
end;
$fn$;

revoke execute on function public.gift_card_adjust(uuid, numeric, text) from public, anon;
grant  execute on function public.gift_card_adjust(uuid, numeric, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.gift_card_cancel — anular. El saldo se retira y queda escrito.
-- ---------------------------------------------------------------------------
create or replace function public.gift_card_cancel(
  p_gift_card_id uuid,
  p_reason       text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_card public.gift_cards%rowtype;
begin
  select * into v_card from public.gift_cards g where g.id = p_gift_card_id;
  if not found then
    raise exception 'TARJETA_NO_ENCONTRADA: esa tarjeta regalo no existe'
      using errcode = '22023';
  end if;

  if not ebim.has_role(v_card.organization_id, v_card.company_id,
                       array['owner','admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: tu rol no puede anular una tarjeta regalo'
      using errcode = '42501';
  end if;

  if v_card.status = 'cancelled' then
    raise exception 'TARJETA_NO_DISPONIBLE: la tarjeta ya estaba cancelada'
      using errcode = '22023';
  end if;

  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'MOTIVO_REQUERIDO: anular un saldo sin motivo no es auditable'
      using errcode = '22023';
  end if;

  -- Con saldo cero no hay importe que mover y el asiento seria de cero, que el
  -- CHECK prohibe: se cancela la fila y se anota con el minimo movible.
  if v_card.balance = 0 then
    update public.gift_cards set status = 'cancelled' where id = v_card.id;
    return jsonb_build_object(
      'gift_card_id', v_card.id, 'balance', '0.00', 'status', 'cancelled', 'replay', false);
  end if;

  return ebim.gift_card_move(
    v_card.id, 'cancel', -v_card.balance,
    'cancel:' || left(btrim(p_reason), 100) || ':' || gen_random_uuid()::text, null);
end;
$fn$;

revoke execute on function public.gift_card_cancel(uuid, text) from public, anon;
grant  execute on function public.gift_card_cancel(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.expire_gift_cards — cerrar las caducadas y dejarlo escrito.
--
-- Se llama desde el servidor cuando haga falta; NO es la garantia de que una
-- tarjeta caducada no pague —esa la da `ebim.gift_card_move`, que comprueba la
-- fecha en cada canje—. Esto es contabilidad: pasar el saldo caducado de pasivo
-- a ingreso, con su asiento.
-- ---------------------------------------------------------------------------
create or replace function public.expire_gift_cards(p_store_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_card  record;
  v_count integer := 0;
begin
  for v_card in
    select g.id, g.balance
    from public.gift_cards g
    where g.status = 'active'
      and g.expires_at <= now()
      and (p_store_id is null or g.store_id = p_store_id)
    order by g.id
    for update
  loop
    if v_card.balance > 0 then
      perform ebim.gift_card_move(v_card.id, 'expire', -v_card.balance, null, null);
    else
      update public.gift_cards set status = 'expired' where id = v_card.id;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$fn$;

revoke execute on function public.expire_gift_cards(uuid) from public, anon, authenticated;
grant  execute on function public.expire_gift_cards(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- public.gift_card_balance_for_slug — "¿cuanto me queda?"
--
-- La unica puerta del comprador, y devuelve SALDO, no codigo. Con 96 bits de
-- entropia adivinar una tarjeta no es un ataque practico; lo que si seria un
-- fallo es distinguir "no existe" de "existe pero es de otra tienda", asi que
-- las dos respuestas son la misma: `found: false`.
--
-- No mueve nada y no bloquea nada: consultar el saldo no puede impedirle a
-- nadie gastarlo.
-- ---------------------------------------------------------------------------
create or replace function public.gift_card_balance_for_slug(
  p_store_slug text,
  p_code       text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_card  public.gift_cards%rowtype;
begin
  select * into v_store
  from public.stores s
  where lower(s.slug) = lower(btrim(coalesce(p_store_slug, ''))) and s.status = 'active';
  if not found then
    return jsonb_build_object('found', false);
  end if;

  select * into v_card
  from public.gift_cards g
  where g.store_id = v_store.id and g.code = ebim.normalize_promo_code(p_code);

  if not found then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found',      true,
    'last4',      v_card.code_last4,
    'balance',    v_card.balance::text,
    'currency',   v_card.currency,
    'status',     case when v_card.status = 'active' and v_card.expires_at <= now()
                       then 'expired' else v_card.status end,
    'expires_at', v_card.expires_at);
end;
$fn$;

revoke execute on function public.gift_card_balance_for_slug(text, text) from public;
grant  execute on function public.gift_card_balance_for_slug(text, text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS · default deny en las dos tablas.
--
-- **Ni un GRANT de escritura para nadie.** Ni `insert`, ni `update`, ni
-- `delete`, ni para `authenticated` con rol `owner`. Mover saldo es un comando,
-- exactamente igual que en P06 con la existencia y en P09 con el dinero. Sin
-- policy de escritura Y sin GRANT: las dos mitades.
--
-- **`code` fuera del GRANT de lectura.** Es un GRANT POR COLUMNA: la RLS filtra
-- filas y nunca columnas, asi que esconder el codigo tiene que hacerse aqui.
-- ---------------------------------------------------------------------------
alter table public.gift_cards             enable row level security;
alter table public.gift_cards             force  row level security;
alter table public.gift_card_transactions enable row level security;
alter table public.gift_card_transactions force  row level security;

revoke all on public.gift_cards             from public, anon, authenticated;
revoke all on public.gift_card_transactions from public, anon, authenticated;

grant select (
  id, organization_id, company_id, store_id, code_last4, currency,
  initial_amount, balance, status, issued_to_email, expires_at, notes,
  created_at, updated_at
) on public.gift_cards to authenticated;

grant select on public.gift_card_transactions to authenticated;

grant all on public.gift_cards, public.gift_card_transactions to service_role;

create policy gift_cards_select_member on public.gift_cards
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy gift_card_transactions_select_member on public.gift_card_transactions
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- ---------------------------------------------------------------------------
comment on table public.gift_cards is
  'Tarjeta regalo: saldo, moneda y caducidad. NO es un descuento sino un MEDIO DE PAGO: no toca subtotal, impuesto ni discount_total del pedido.';
comment on column public.gift_cards.code is
  'Instrumento al portador: 96 bits, SIN GRANT de lectura para nadie. Sale de la base una sola vez, en la respuesta de gift_card_issue.';
comment on column public.gift_cards.expires_at is
  'Obligatoria: un saldo sin fecha es un pasivo eterno. Quien elige el plazo es el comercio, no el modelo.';
comment on table public.gift_card_transactions is
  'Libro mayor del saldo: delta con signo y saldo resultante, escritos en la misma sentencia que mueve la tarjeta. `reference` es la idempotencia de negocio.';
comment on function ebim.gift_card_move(uuid, public.gift_card_movement, numeric, text, uuid) is
  'El unico sitio donde el saldo cambia: bloquea la fila, comprueba caducidad y saldo, y escribe asiento y saldo juntos.';
comment on function public.gift_card_redeem(text, text, numeric, text, uuid) is
  'Gastar saldo. SOLO servidor: si la llamara el navegador, el importe a descontar lo decidiria el navegador.';
comment on function public.gift_card_balance_for_slug(text, text) is
  'La unica puerta del comprador. Devuelve saldo, nunca codigo, y no distingue "no existe" de "es de otra tienda".';
