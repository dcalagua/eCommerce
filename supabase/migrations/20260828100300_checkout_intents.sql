-- =============================================================================
-- P07-SaaS · El intento de compra: idempotencia y etapas auditables
--
-- El fallo que esta tabla existe para hacer imposible es el mas viejo del
-- comercio electronico y ya estaba anotado en la auditoria de P00: la peticion
-- llega, el pedido se crea, la respuesta se pierde por el camino y el navegador
-- reintenta. Sin ancla, eso son dos pedidos, dos descuentos de existencia y dos
-- correos. El bloqueo del boton en el frontend NO es la solucion —es una ayuda
-- de usabilidad y ni siquiera se ejecuta si la peticion la manda otra cosa—; la
-- solucion es que el servidor sepa que esa peticion ya la vio.
--
-- ## Tres decisiones
--
-- 1. **La clave la pone el cliente y el HASH la valida.** `idempotency_key` es
--    un secreto de alta entropia generado por el navegador; `request_hash` es
--    el resumen de lo que se pidio. Repetir la clave con OTRA peticion es un
--    error explicito (`IDEMPOTENCIA_EN_CONFLICTO`), nunca una segunda compra
--    silenciosa. Y el resultado guardado —que incluye el token de acceso al
--    pedido— solo se devuelve si el hash coincide: adivinar la clave no basta.
--
-- 2. **Un intento en curso NO se atiende dos veces.** El segundo recibe 409 y
--    no una segunda ejecucion. Solo se retoma cuando lleva parado mas de dos
--    minutos, que es la unica manera de que un proceso muerto no deje al
--    comprador sin poder comprar nunca mas con esa clave.
--
-- 3. **La etapa se guarda.** No para la pantalla —el comprador no quiere leer
--    `reserve_inventory`— sino para poder responder a "¿por que este pedido no
--    existe?" con "fallo al reservar existencia" en vez de con un 500. Es la
--    parte "auditable" del "errores por etapa son tipados y auditables".
--
-- El vocabulario de etapas es un ENUM, no texto libre: es un contrato con el
-- orquestador de TypeScript y hay un test que compara las dos listas.
-- =============================================================================

create type public.checkout_stage as enum (
  'resolve_context',
  'validate_account',
  'resolve_prices',
  'resolve_promotions',
  'calculate_taxes',
  'reserve_inventory',
  'validate_delivery',
  'authorize_payment',
  'create_order',
  'publish_events',
  'notify'
);

create type public.checkout_intent_status as enum ('running', 'succeeded', 'failed');

create table public.checkout_intents (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  -- Secreto de alta entropia del navegador. No identifica a nadie y no se
  -- reusa: es el ancla de UN intento de compra.
  idempotency_key text        not null,
  -- Resumen de la peticion. Lo que ata la clave a lo que se pidio con ella.
  request_hash    text        not null,
  status          public.checkout_intent_status not null default 'running',
  stage           public.checkout_stage not null default 'resolve_context',
  attempts        integer     not null default 1,
  cart_id         uuid,
  -- Secreto de la reserva viva de este intento. Se guarda para poder SOLTARLA
  -- si el intento muere a medias: sin el, esas unidades quedarian comprometidas
  -- hasta que caducaran solas.
  reservation_token text,
  order_id        uuid,
  error_stage     public.checkout_stage,
  error_code      text,
  error_detail    text,
  -- Respuesta ya construida del intento que salio bien. Es lo que se devuelve
  -- tal cual en un reintento, en vez de volver a crear nada.
  result          jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  constraint checkout_intents_key_fmt
    check (idempotency_key ~ '^[A-Za-z0-9_-]{24,200}$'),
  constraint checkout_intents_hash_fmt
    check (request_hash ~ '^[a-f0-9]{64}$'),
  constraint checkout_intents_attempts check (attempts between 1 and 50),
  constraint checkout_intents_reservation_len
    check (reservation_token is null or char_length(reservation_token) = 64),
  -- Un intento que dice haber salido bien sin pedido y sin respuesta es una
  -- fila que miente.
  constraint checkout_intents_success_shape
    check (status <> 'succeeded' or (order_id is not null and result is not null)),
  constraint checkout_intents_failure_shape
    check (status <> 'failed' or error_code is not null),
  constraint checkout_intents_unique unique (store_id, idempotency_key),
  constraint checkout_intents_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  -- `cascade` y no `set null`: la FK es compuesta y `store_id` es NOT NULL, asi
  -- que un `set null` fallaria al intentar anular las dos columnas. Un carrito
  -- solo desaparece si desaparece su tienda, y entonces el intento tampoco
  -- significa nada.
  constraint checkout_intents_cart_fk foreign key (cart_id, store_id)
    references public.carts (id, store_id) on delete cascade,
  constraint checkout_intents_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade
);

create index checkout_intents_tenant on public.checkout_intents (organization_id, company_id);
create index checkout_intents_store  on public.checkout_intents (store_id, created_at desc);
create index checkout_intents_stuck
  on public.checkout_intents (updated_at) where status = 'running';

create trigger checkout_intents_updated_at before update on public.checkout_intents
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- public.checkout_context — la primera etapa del pipeline, y la unica que
-- responde antes de decidir nada.
--
-- Devuelve lo que el orquestador necesita saber del ENTORNO —moneda, canal, si
-- el impuesto va incluido— y nada mas. No trae ids internos, no trae el tenant
-- y no acepta ninguno: el comprador dice el slug de su URL y el servidor
-- traduce, exactamente igual que en `price_quote_for_slug`.
--
-- Existe como funcion propia y no como campos sueltos de otra respuesta porque
-- la etapa 1 del pipeline tiene que poder fallar SOLA: "esta tienda no esta
-- recibiendo pedidos" es un error distinto de "este producto no existe", y
-- mezclarlos hace que el comprador reintente lo que no se arregla.
-- ---------------------------------------------------------------------------
create or replace function public.checkout_context(p_store_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store     public.stores%rowtype;
  v_channel   public.channels%rowtype;
  v_inclusive boolean;
begin
  v_store   := ebim.active_store_by_slug(p_store_slug);
  v_channel := ebim.public_channel(v_store.id);

  select coalesce(ss.tax_inclusive, false) into v_inclusive
  from public.store_settings ss where ss.store_id = v_store.id;

  return jsonb_build_object(
    'store_slug',    v_store.slug,
    'store_name',    v_store.name,
    'currency',      v_store.currency,
    'channel',       v_channel.code,
    'channel_kind',  v_channel.kind,
    'requires_auth', v_channel.requires_auth,
    'tax_inclusive', coalesce(v_inclusive, false));
end;
$fn$;

revoke execute on function public.checkout_context(text) from public;
grant  execute on function public.checkout_context(text) to anon, authenticated, service_role;

comment on function public.checkout_context(text) is
  'Etapa 1 del pipeline: moneda, canal e impuesto de la tienda del slug. Sin ids internos y sin aceptar tenant.';

-- ---------------------------------------------------------------------------
-- public.checkout_begin — reclamar el intento.
--
-- Devuelve una de tres cosas y el orquestador no tiene que adivinar cual:
--   · `replay = true`  -> este pedido YA existe. Toma su respuesta y no hagas
--                         nada mas. Es el caso del reintento de red.
--   · `replay = false` -> es tuyo, sigue.
--   · excepcion        -> o la clave se reuso con otra peticion, o hay otro
--                         intento vivo con la misma clave.
-- ---------------------------------------------------------------------------
create or replace function public.checkout_begin(
  p_store_slug      text,
  p_idempotency_key text,
  p_request_hash    text,
  p_cart_token      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store    public.stores%rowtype;
  v_key      text := btrim(coalesce(p_idempotency_key, ''));
  v_hash     text := lower(btrim(coalesce(p_request_hash, '')));
  v_cart_id  uuid := null;
  v_intent   public.checkout_intents%rowtype;
  v_id       uuid;
begin
  v_store := ebim.active_store_by_slug(p_store_slug);

  if v_key !~ '^[A-Za-z0-9_-]{24,200}$' then
    raise exception 'IDEMPOTENCIA_INVALIDA: la clave de idempotencia tiene que ser un texto de al menos 24 caracteres seguros para URL'
      using errcode = '22023';
  end if;

  if v_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'IDEMPOTENCIA_INVALIDA: falta el resumen de la peticion'
      using errcode = '22023';
  end if;

  if p_cart_token is not null and btrim(p_cart_token) <> '' then
    select c.id into v_cart_id
    from public.carts c
    where c.store_id = v_store.id and c.token = btrim(p_cart_token);
    -- Un token de carrito que no corresponde a nada NO bloquea la compra: el
    -- carrito es una comodidad, el pedido es lo que importa.
  end if;

  insert into public.checkout_intents (
    organization_id, company_id, store_id, idempotency_key, request_hash, cart_id
  ) values (
    v_store.organization_id, v_store.company_id, v_store.id, v_key, v_hash, v_cart_id
  )
  on conflict (store_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object(
      'intent_id', v_id, 'status', 'running', 'replay', false, 'attempt', 1);
  end if;

  -- Ya existia. El bloqueo de fila es lo que hace que dos peticiones
  -- simultaneas con la misma clave se ordenen aqui en vez de correr las dos.
  select * into v_intent
  from public.checkout_intents i
  where i.store_id = v_store.id and i.idempotency_key = v_key
  for update;

  if v_intent.request_hash <> v_hash then
    raise exception 'IDEMPOTENCIA_EN_CONFLICTO: esa clave ya se uso para una peticion distinta'
      using errcode = '22023';
  end if;

  if v_intent.status = 'succeeded' then
    return jsonb_build_object(
      'intent_id', v_intent.id,
      'status',    'succeeded',
      'replay',    true,
      'attempt',   v_intent.attempts,
      'order_id',  v_intent.order_id,
      'result',    v_intent.result);
  end if;

  if v_intent.status = 'running' and v_intent.updated_at > now() - interval '2 minutes' then
    raise exception 'CHECKOUT_EN_CURSO: ese intento de compra todavia se esta procesando'
      using errcode = '22023';
  end if;

  -- Fallido, o parado hace mas de dos minutos: se retoma. La existencia que
  -- pudiera haber quedado apartada se suelta antes de volver a empezar, porque
  -- si no el reintento competiria contra su propia reserva.
  if v_intent.reservation_token is not null then
    begin
      perform public.release_inventory_by_token(v_store.slug, v_intent.reservation_token);
    exception when others then
      -- Ya estaba soltada o caducada. No es motivo para no dejar comprar.
      null;
    end;
  end if;

  update public.checkout_intents
     set status = 'running',
         stage = 'resolve_context',
         attempts = attempts + 1,
         error_stage = null,
         error_code = null,
         error_detail = null,
         reservation_token = null,
         cart_id = coalesce(v_cart_id, cart_id)
   where id = v_intent.id
  returning * into v_intent;

  return jsonb_build_object(
    'intent_id', v_intent.id, 'status', 'running', 'replay', false,
    'attempt', v_intent.attempts);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.checkout_mark_stage — donde va el intento, y con que reserva.
-- ---------------------------------------------------------------------------
create or replace function public.checkout_mark_stage(
  p_intent_id         uuid,
  p_stage             public.checkout_stage,
  p_reservation_token text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.checkout_intents
     set stage = p_stage,
         reservation_token = coalesce(nullif(btrim(coalesce(p_reservation_token, '')), ''),
                                      reservation_token)
   where id = p_intent_id and status = 'running';

  if not found then
    raise exception 'INTENTO_NO_VIGENTE: ese intento de compra ya se cerro'
      using errcode = '22023';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.checkout_fail — cerrar el intento con su etapa y su codigo.
--
-- No borra el intento: un intento fallido es lo que permite reintentar con la
-- MISMA clave sin crear un segundo pedido, y es lo que explica despues por que
-- una compra no llego a existir.
-- ---------------------------------------------------------------------------
create or replace function public.checkout_fail(
  p_intent_id uuid,
  p_stage     public.checkout_stage,
  p_code      text,
  p_detail    text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.checkout_intents
     set status = 'failed',
         stage = p_stage,
         error_stage = p_stage,
         error_code = left(coalesce(nullif(btrim(coalesce(p_code, '')), ''), 'ERROR_INTERNO'), 80),
         error_detail = left(coalesce(p_detail, ''), 2000),
         completed_at = now()
   where id = p_intent_id and status = 'running';
end;
$fn$;

-- ---------------------------------------------------------------------------
-- RLS — el comercio ve sus intentos; nadie los escribe desde el cliente
-- ---------------------------------------------------------------------------
alter table public.checkout_intents enable row level security;
alter table public.checkout_intents force  row level security;

revoke all on public.checkout_intents from public, anon, authenticated;
grant  all on public.checkout_intents to service_role;

-- GRANT por columna: ni `reservation_token` ni `result` salen al backoffice.
-- El primero es un secreto de portador sobre existencia apartada; el segundo
-- lleva dentro el token de acceso del comprador a su pedido, que ya tiene su
-- propia puerta en `order_tokens`.
grant select (
  id, organization_id, company_id, store_id, idempotency_key, request_hash,
  status, stage, attempts, cart_id, order_id,
  error_stage, error_code, error_detail,
  created_at, updated_at, completed_at
) on public.checkout_intents to authenticated;

create policy checkout_intents_select_member on public.checkout_intents
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

revoke execute on function public.checkout_begin(text, text, text, text)
  from public, anon, authenticated;
revoke execute on function
  public.checkout_mark_stage(uuid, public.checkout_stage, text)
  from public, anon, authenticated;
revoke execute on function
  public.checkout_fail(uuid, public.checkout_stage, text, text)
  from public, anon, authenticated;

grant execute on function public.checkout_begin(text, text, text, text) to service_role;
grant execute on function
  public.checkout_mark_stage(uuid, public.checkout_stage, text) to service_role;
grant execute on function
  public.checkout_fail(uuid, public.checkout_stage, text, text) to service_role;

comment on table public.checkout_intents is
  'Un intento de compra por clave de idempotencia y tienda. Repetir la peticion devuelve el MISMO pedido; repetir la clave con otra peticion es un error explicito.';
comment on column public.checkout_intents.request_hash is
  'Resumen de la peticion. Ata la clave a lo que se pidio: adivinar la clave no basta para recuperar el resultado.';
comment on column public.checkout_intents.reservation_token is
  'Secreto de la reserva viva. Fuera del GRANT del backoffice: con el se opera sobre existencia apartada.';
comment on function public.checkout_begin(text, text, text, text) is
  'Reclama el intento. replay=true significa que el pedido ya existe y hay que devolver su respuesta sin crear nada.';
