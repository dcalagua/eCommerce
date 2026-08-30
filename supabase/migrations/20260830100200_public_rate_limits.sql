-- =============================================================================
-- P16-SaaS · 3/3 — Techo de tasa para las dos superficies anonimas que faltaban
--
-- Inventario de lo que `anon` puede EJECUTAR (leido de `pg_proc`, no supuesto):
-- dieciocho funciones. Diecisiete son lectura sobre catalogo publicado o van
-- protegidas por un secreto largo. Las que quedaban sin techo y con
-- consecuencia son dos:
--
--  1. `track_events_for_slug` — ESCRIBE. Cada llamada mete hasta 20 filas en
--     `analytics_events` sin sesion, sin coste para quien llama y sin limite de
--     llamadas. El lote tenia techo desde P13; el numero de lotes, no. Es
--     amplificacion de almacenamiento contra la factura del comercio, y ademas
--     envenena sus indicadores, que es el daño que no se nota.
--
--  2. `promotion_quote_for_slug` — es un ORACULO de cupones. Un codigo de cupon
--     lo teclea una persona (`^[a-z0-9][a-z0-9_-]{0,40}$`, minimo 3
--     caracteres): no tiene entropia, se adivina. La respuesta distingue
--     `no_existe` de `aplicable`, que es exactamente lo que necesita un bucle
--     para encontrar VERANO20 sin saberlo.
--
-- Las otras dieciseis se dejan como estan, y esta escrito por que en
-- `docs/SECURITY_BASELINE.md`: `order_by_token` y `returns_by_token` van con
-- 256 bits de entropia y `gift_card_balance_for_slug` con 96 — adivinarlos no
-- es un ataque, es una imposibilidad aritmetica, y ponerles un contador
-- compartido solo crearia una forma nueva de dejar sin servicio a un comprador
-- legitimo. El checkout ya tiene el suyo desde P10.
--
-- ## La decision que gobierna este archivo: DEGRADAR, no negar
--
-- El contador es POR TIENDA. Es la unica dimension que la base conoce de forma
-- fiable: no hay IP —Postgres no la recibe— y el identificador de sesion lo
-- elige el cliente, asi que un atacante lo cambia en cada peticion y un
-- contador por sesion no cuenta nada.
--
-- Un contador compartido tiene un coste evidente: quien abusa gasta el
-- presupuesto de los demas. Por eso ninguna de las dos superficies LANZA al
-- pasarse:
--
--   · La analitica devuelve `recorded: 0`. Se pierden hechos de medicion; no se
--     pierde ni una venta.
--   · La cotizacion se calcula IGUAL, sin los cupones. El comprador ve que su
--     codigo no aplica; el carrito, el precio y el checkout siguen enteros — y
--     el checkout aplica el cupon por su propio camino, que tiene su propio
--     limite desde P10 y no es un oraculo (5 por correo y hora).
--
-- Un limite que tumba el checkout de una tienda entera porque alguien lanzo un
-- bucle es peor que el abuso que evita. Este no puede hacerlo.
--
-- Y el de cupones cuenta FALLOS, no usos. Una campana con diez mil canjes
-- legitimos no gasta ni una unidad del contador: solo la gastan los codigos que
-- NO existen, que es lo que hace un enumerador y casi nunca una persona.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- La tabla del contador
--
-- No es bitacora: es una ventana. Una fila por intento CONTABILIZADO, con purga
-- propia. El tamaño esta acotado por construccion —solo se anota mientras se
-- esta por debajo del techo—, asi que como mucho hay `techo + rafaga` filas por
-- tienda, superficie y ventana.
--
-- Sin dato personal: ni correo, ni sesion, ni el codigo tecleado. Guardar el
-- codigo convertiria la defensa contra la enumeracion en una lista de codigos
-- probados, que es justo lo que no interesa custodiar.
-- ---------------------------------------------------------------------------
create table public.public_rate_events (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  surface         text        not null,
  created_at      timestamptz not null default now(),
  constraint public_rate_events_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint public_rate_events_surface_fmt check (surface ~ '^[a-z][a-z0-9_.]{2,60}$')
);

create index public_rate_events_tenant on public.public_rate_events (organization_id, company_id);
create index public_rate_events_window
  on public.public_rate_events (store_id, surface, created_at desc);

comment on table public.public_rate_events is
  'Ventana de tasa de las superficies publicas anonimas (P16-SaaS). Contador, no bitacora: sin correo, sin sesion y sin el valor probado.';

alter table public.public_rate_events enable row level security;
alter table public.public_rate_events force  row level security;

revoke all on public.public_rate_events from public, anon, authenticated;
grant  all on public.public_rate_events to service_role;

-- Lectura para el tenant y nada mas: sirve para diagnosticar un pico. Sin
-- INSERT/UPDATE/DELETE ni para `owner` — un contador que el cliente puede
-- escribir no cuenta nada. Misma regla que `checkout_attempts` (P10).
grant select on public.public_rate_events to authenticated;

create policy public_rate_events_select_member on public.public_rate_events
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- ---------------------------------------------------------------------------
-- ebim.public_rate_limit — el techo vigente de una superficie
--
-- Configurable por tienda sin migracion (`store_settings.config.rate_limits`),
-- igual que el del checkout. `0` desactiva el limite: escape deliberado y
-- explicito, para el comercio que mide su vitrina con su propia herramienta.
-- ---------------------------------------------------------------------------
create or replace function ebim.public_rate_limit(
  p_store_id  uuid,
  p_surface   text,
  p_default   integer
)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (select (ss.config -> 'rate_limits' ->> p_surface)::integer
       from public.store_settings ss
      where ss.store_id = p_store_id),
    p_default);
$fn$;

revoke execute on function ebim.public_rate_limit(uuid, text, integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ebim.public_rate_exceeded — ¿esta por encima del techo AHORA?
--
-- Solo pregunta; no anota. Separar la pregunta de la anotacion es lo que
-- permite que `promotion_quote_for_slug` cuente FALLOS: primero mira si puede
-- seguir, y solo despues —cuando ya sabe cuantos codigos no existian— apunta.
-- ---------------------------------------------------------------------------
create or replace function ebim.public_rate_exceeded(
  p_store_id  uuid,
  p_surface   text,
  p_default   integer,
  p_window    interval default '1 hour'
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_max   integer;
  v_count integer;
begin
  v_max := ebim.public_rate_limit(p_store_id, p_surface, p_default);
  if v_max is null or v_max <= 0 then
    return false;
  end if;

  select count(*)::integer into v_count
  from public.public_rate_events e
  where e.store_id = p_store_id
    and e.surface  = p_surface
    and e.created_at > now() - p_window;

  return v_count >= v_max;
end;
$fn$;

revoke execute on function ebim.public_rate_exceeded(uuid, text, integer, interval)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ebim.public_rate_record — anota N intentos
--
-- El tenant sale de la fila de la TIENDA, nunca de un parametro: es la misma
-- regla que el resto del repo y aqui ademas evita que un fallo de llamada
-- escriba el contador de otro.
-- ---------------------------------------------------------------------------
create or replace function ebim.public_rate_record(
  p_store_id uuid,
  p_surface  text,
  p_count    integer default 1,
  p_default  integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
begin
  if p_count is null or p_count <= 0 then
    return;
  end if;

  -- Con el techo DESACTIVADO (`0`) no se anota. Sin esta guarda, apagar el
  -- limite dejaria escribiendo una fila de contador por llamada — es decir,
  -- exactamente la amplificacion de escritura que el limite venia a impedir,
  -- pero en la tabla del propio limite.
  if p_default is not null
     and coalesce(ebim.public_rate_limit(p_store_id, p_surface, p_default), 0) <= 0 then
    return;
  end if;

  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    return;
  end if;

  insert into public.public_rate_events (organization_id, company_id, store_id, surface)
  select v_store.organization_id, v_store.company_id, v_store.id, p_surface
  from generate_series(1, least(p_count, 50));
end;
$fn$;

revoke execute on function ebim.public_rate_record(uuid, text, integer, integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Purga. Sin ella la ventana crece para siempre y el indice se degrada justo en
-- la ruta que mas se llama. Misma forma que `purge_checkout_attempts` (P10).
-- ---------------------------------------------------------------------------
create or replace function public.purge_public_rate_events(
  p_older_than interval default '24 hours'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_deleted integer;
begin
  delete from public.public_rate_events where created_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

revoke execute on function public.purge_public_rate_events(interval)
  from public, anon, authenticated;
grant  execute on function public.purge_public_rate_events(interval) to service_role;

-- =============================================================================
-- Las dos funciones publicas, redefinidas
--
-- Se reescriben ENTERAS (`create or replace`) porque una migracion aplicada es
-- inmutable. Ni una linea de conducta cambia respecto de P13 y P10 salvo lo que
-- se señala con `P16-SaaS`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- public.track_events_for_slug — P13-SaaS + techo de tasa
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

  -- P16-SaaS. El lote tenia techo; el numero de lotes, no. Se DESCARTA en vez
  -- de lanzar: la vitrina manda estos hechos en segundo plano y un error aqui
  -- se convertiria en un aviso en la consola del comprador por un problema que
  -- no es suyo. La respuesta es la misma forma de siempre, con `recorded: 0`.
  if ebim.public_rate_exceeded(v_store.id, 'analytics.track', 600) then
    return jsonb_build_object('recorded', 0);
  end if;
  perform ebim.public_rate_record(v_store.id, 'analytics.track', 1, 600);

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

comment on function public.track_events_for_slug(text, text, jsonb) is
  'Ingesta de analitica de la vitrina: tenant por slug, tres tipos, lote de 20 y techo de tasa por tienda que DESCARTA en vez de fallar (P16-SaaS).';

-- ---------------------------------------------------------------------------
-- public.promotion_quote_for_slug — P10-SaaS + techo de sondeo de cupones
-- ---------------------------------------------------------------------------
create or replace function public.promotion_quote_for_slug(
  p_store_slug   text,
  p_items        jsonb,
  p_coupon_codes text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store    public.stores%rowtype;
  v_channel  public.channels%rowtype;
  v_slug     text := lower(btrim(coalesce(p_store_slug, '')));
  v_quote    jsonb;
  v_codes    text[] := p_coupon_codes;
  v_result   jsonb;
  v_misses   integer;
begin
  if v_slug = '' then
    raise exception 'TIENDA_NO_DISPONIBLE: falta la tienda de la cotizacion'
      using errcode = '22023';
  end if;

  select * into v_store
  from public.stores s
  where lower(s.slug) = v_slug and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  select * into v_channel
  from public.channels c
  where c.store_id = v_store.id and c.is_default and c.is_active;

  if not found then
    raise exception 'CANAL_NO_DISPONIBLE: la tienda % no tiene canal por defecto activo', v_store.slug
      using errcode = '22023';
  end if;

  if v_channel.requires_auth then
    raise exception 'CANAL_NO_PUBLICO: el canal por defecto de % exige sesion', v_store.slug
      using errcode = '22023';
  end if;

  -- P16-SaaS. Con el contador de FALLOS por encima del techo, la cotizacion se
  -- calcula igual y sin cupones: el oraculo se apaga, el carrito no. Nada mas
  -- cambia — ni el precio, ni los impuestos, ni las campanas automaticas, que
  -- no dependen de un codigo tecleado.
  if v_codes is not null
     and array_length(v_codes, 1) > 0
     and ebim.public_rate_exceeded(v_store.id, 'promotions.coupon_probe', 100) then
    v_codes := null;
  end if;

  v_quote := ebim.build_quote(v_store.id, v_channel.id, p_items, null, null, now(), true);

  v_result := ebim.apply_promotions(
    v_store.id, v_channel.id, v_quote, v_codes,
    null, null, null, null, now(), false);

  -- Se anota UN intento por codigo que no existe. Un canje legitimo —incluso
  -- uno caducado o agotado— no gasta contador: esos codigos SI existen, asi que
  -- quien los teclea ya los conocia.
  -- `ebim.apply_promotions` devuelve la COTIZACION entera y cuelga el resultado
  -- de los cupones de `promotions.coupons`, no de la raiz. Leerlo de la raiz
  -- daria cero siempre: el contador existiria y no contaria nada.
  select count(*)::integer into v_misses
  from jsonb_array_elements(
         coalesce(v_result -> 'promotions' -> 'coupons', '[]'::jsonb)) as c(value)
  where c.value ->> 'status' = 'no_existe';

  if coalesce(v_misses, 0) > 0 then
    perform ebim.public_rate_record(v_store.id, 'promotions.coupon_probe', v_misses, 100);
  end if;

  return v_result;
end;
$fn$;

comment on function public.promotion_quote_for_slug(text, jsonb, text[]) is
  'Cotizacion publica con promociones. Cuenta los codigos que NO existen y, pasado el techo por tienda, deja de admitir cupones sin dejar de cotizar (P16-SaaS).';

revoke execute on function public.promotion_quote_for_slug(text, jsonb, text[]) from public;
grant  execute on function public.promotion_quote_for_slug(text, jsonb, text[])
  to anon, authenticated, service_role;

revoke execute on function public.track_events_for_slug(text, text, jsonb) from public;
grant  execute on function public.track_events_for_slug(text, text, jsonb)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Nota sobre el otro llamador de `promotion_quote_for_slug`
--
-- La etapa 4 del checkout (`_shared/checkout/dbPorts.ts` → `resolvePromotions`)
-- usa ESTA MISMA funcion para previsualizar el descuento antes de cobrar. Es
-- deliberado y no cambia nada del razonamiento de arriba:
--
--  · un codigo mal tecleado en el checkout SI gasta contador, porque es un
--    fallo de verdad;
--  · y el techo NO puede dejar a nadie sin su descuento, porque `create_order`
--    no pasa por aqui: llama a `ebim.apply_promotions` con los codigos y los
--    cerrojos puestos, y es SU resultado el que se cobra (20260828130300).
--
-- Es decir: el techo apaga el oraculo, no la venta.
-- ---------------------------------------------------------------------------
