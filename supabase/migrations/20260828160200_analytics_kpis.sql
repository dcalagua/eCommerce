-- =============================================================================
-- P13-SaaS · 3/6 — Los indicadores. Todos con denominador, o ninguno
--
-- ## La regla que gobierna este archivo entero
--
-- «No inventes métricas si faltan datos.» Aqui eso no es una recomendacion: es
-- que **toda razon devuelve NULL cuando su denominador es cero**, y ninguna
-- devuelve 0 % en su lugar. Un 0 % de conversion se lee como «la tienda no
-- vende»; un NULL se lee como «todavia no hay con que calcularlo», que es lo
-- que pasa de verdad el primer dia de un tenant. La pantalla pinta un guion.
--
-- Lo mismo con la moneda, y el precedente ya estaba escrito en `dashboard_kpis`
-- (P03): si la seleccion mezcla monedas, el total sale NULL en vez de sumar
-- soles con dolares.
--
-- ## De donde sale cada numero, y por que no todos del mismo sitio
--
-- | Indicador | Fuente | Por que esa |
-- |---|---|---|
-- | ventas, pedidos, ticket, unidades | `orders` + `order_items` | es el dinero; la serie de eventos no cobra |
-- | conversion de compra | `checkout_intents` | numerador y denominador de la MISMA fila |
-- | abandono | `carts` | el estado `abandoned` ya existia desde P07 |
-- | productos mas vendidos | `order_items` | lo vendido, no lo mirado |
-- | rendimiento por canal | `orders` × `channels` | el canal es del pedido, no del evento |
-- | embudo y busquedas | `analytics_events` | son los unicos que solo existen ahi |
--
-- Que la conversion NO se calcule sobre eventos del navegador es la decision
-- que mas cuesta revertir y la que mas vale: un ratio cuyo denominador depende
-- de que el navegador consiga mandar un evento baja cuando sube el uso de
-- bloqueadores, y entonces parece que la tienda empeora.
--
-- ## Que se vende y que viene con el producto
--
-- `analytics.basic` es BASELINE desde P02: ventas, pedidos, ticket, productos y
-- canal salen de `orders`, que todo tenant tiene. Lo vendible
-- (`analytics.advanced`) es el COMPORTAMIENTO —el embudo y los terminos de
-- busqueda—, que es lo unico que necesita la serie de eventos. Un tenant sin el
-- addon ve exactamente los indicadores que veia antes de esta fase mas los que
-- se derivan de sus pedidos: se degrada, no se rompe.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.analytics_from / ebim.analytics_to — la ventana por defecto.
--
-- Existen como funcion y no como `coalesce` repetido en seis sitios porque el
-- dia que el defecto cambie de 30 dias a otra cosa, seis copias se convierten
-- en seis ventanas distintas y dos pantallas dejan de cuadrar entre si.
-- ---------------------------------------------------------------------------
create or replace function ebim.analytics_from(p_from timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $fn$
  select coalesce(p_from, now() - interval '30 days');
$fn$;

create or replace function ebim.analytics_to(p_to timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $fn$
  select coalesce(p_to, now());
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.assert_analytics_advanced — la puerta del modulo vendible.
--
-- Levanta `SIN_MODULO` en vez de devolver vacio. Devolver una lista vacia haria
-- que la pantalla dijera «no hay datos» cuando lo que pasa es «no lo tienes
-- contratado», y son dos incidencias distintas para quien da soporte — el mismo
-- argumento que P02 escribio para `sin-contexto`.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_analytics_advanced()
returns void
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_org     uuid := ebim.org_id();
  v_company uuid := ebim.active_company();
begin
  if v_org is null or v_company is null then
    raise exception 'SIN_PERMISO: el token no trae la jerarquia de tenant'
      using errcode = '42501';
  end if;
  if not ebim.has_capability(v_org, v_company, 'analytics.advanced') then
    raise exception 'SIN_MODULO: la analitica avanzada no esta activa para esta sociedad'
      using errcode = '42501';
  end if;
end;
$fn$;

revoke execute on function
  ebim.analytics_from(timestamptz), ebim.analytics_to(timestamptz),
  ebim.assert_analytics_advanced()
from public;

-- Las llaman funciones SECURITY INVOKER, asi que el permiso lo necesita quien
-- pregunta y no el propietario. `anon` no entra: la analitica no es publica.
grant execute on function
  ebim.analytics_from(timestamptz), ebim.analytics_to(timestamptz),
  ebim.assert_analytics_advanced()
to authenticated, service_role;

-- =============================================================================
-- public.analytics_kpis — el cuadro de mando.
--
-- SECURITY INVOKER, igual que `dashboard_kpis` y por la misma razon exacta: la
-- RLS del usuario decide que filas cuentan. Una definer aqui devolveria
-- agregados de todos los tenants sin que ninguna policy pudiera impedirlo.
--
-- No recibe `organization_id` ni `company_id`. El unico alcance es la tienda, y
-- una tienda ajena no aporta filas visibles — cuenta 0, no filtra nada.
-- =============================================================================
create or replace function public.analytics_kpis(
  p_store_id uuid default null,
  p_from     timestamptz default null,
  p_to       timestamptz default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_from       timestamptz := ebim.analytics_from(p_from);
  v_to         timestamptz := ebim.analytics_to(p_to);
  v_currencies text[];
  v_currency   text;
  v_orders     bigint  := 0;
  v_gross      numeric(14,2) := 0;
  v_paid       numeric(14,2) := 0;
  v_discount   numeric(14,2) := 0;
  v_shipping   numeric(14,2) := 0;
  v_units      bigint  := 0;
  v_started    bigint  := 0;
  v_completed  bigint  := 0;
  v_abandoned  bigint  := 0;
  v_converted  bigint  := 0;
begin
  -- Los pedidos. `cancelled` queda fuera de todo: un pedido anulado no es una
  -- venta, y contarlo en el ticket medio lo hunde sin que nadie sepa por que.
  select count(*),
         coalesce(sum(o.grand_total), 0),
         coalesce(sum(o.grand_total) filter (
           where o.payment_status in ('paid', 'partially_refunded')), 0),
         coalesce(sum(o.discount_total), 0),
         coalesce(sum(o.shipping_total), 0),
         coalesce(array_agg(distinct o.currency::text), '{}'::text[])
    into v_orders, v_gross, v_paid, v_discount, v_shipping, v_currencies
    from public.orders o
   where o.status <> 'cancelled'
     and o.placed_at >= v_from and o.placed_at < v_to
     and (p_store_id is null or o.store_id = p_store_id);

  v_currency := case when array_length(v_currencies, 1) = 1 then v_currencies[1] end;

  select coalesce(sum(oi.quantity), 0)
    into v_units
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.status <> 'cancelled'
     and o.placed_at >= v_from and o.placed_at < v_to
     and (p_store_id is null or o.store_id = p_store_id);

  -- Conversion de compra. Denominador CONFIABLE: cada intento de checkout es
  -- una fila que el servidor escribio, no un evento que el navegador logro
  -- mandar. Se cuentan intentos DISTINTOS, no reintentos: la clave de
  -- idempotencia es la que dice que dos peticiones son la misma compra.
  select count(*),
         count(*) filter (where i.status = 'succeeded')
    into v_started, v_completed
    from public.checkout_intents i
   where i.created_at >= v_from and i.created_at < v_to
     and (p_store_id is null or i.store_id = p_store_id);

  -- Abandono. Denominador = carritos que llegaron a un desenlace (abandonado o
  -- convertido). Un carrito TODAVIA activo no es ni lo uno ni lo otro, y
  -- meterlo en el denominador haria que la tasa bajara sola con el trafico del
  -- dia en curso.
  select count(*) filter (where c.status = 'abandoned'),
         count(*) filter (where c.status = 'converted')
    into v_abandoned, v_converted
    from public.carts c
   where c.created_at >= v_from and c.created_at < v_to
     and (p_store_id is null or c.store_id = p_store_id)
     and exists (select 1 from public.cart_items ci where ci.cart_id = c.id);

  return jsonb_build_object(
    'from', v_from,
    'to',   v_to,
    'currency', v_currency,
    'orders', v_orders,
    -- Dinero como TEXTO (decision P02 #19): un numeric en JSON se vuelve float
    -- en el primer JSON.parse del navegador. Y en NULL si hay mezcla de
    -- monedas: no hay un total que se pueda enseñar sin mentir.
    'gross_sales',  case when v_currency is not null then v_gross::text end,
    'paid_sales',   case when v_currency is not null then v_paid::text end,
    'discounts',    case when v_currency is not null then v_discount::text end,
    'shipping',     case when v_currency is not null then v_shipping::text end,
    'units', v_units,
    'average_ticket', case
      when v_currency is not null and v_orders > 0
        then round(v_gross / v_orders, 2)::text
    end,
    'checkouts_started',   v_started,
    'checkouts_completed', v_completed,
    -- NULL, no 0: sin intentos no hay tasa que calcular.
    'conversion_rate', case
      when v_started > 0 then round((v_completed::numeric / v_started) * 100, 2)::text
    end,
    'carts_abandoned', v_abandoned,
    'carts_converted', v_converted,
    'abandonment_rate', case
      when (v_abandoned + v_converted) > 0
        then round((v_abandoned::numeric / (v_abandoned + v_converted)) * 100, 2)::text
    end
  );
end;
$fn$;

revoke execute on function public.analytics_kpis(uuid, timestamptz, timestamptz) from public, anon;
grant  execute on function public.analytics_kpis(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

-- =============================================================================
-- public.analytics_top_products — lo mas VENDIDO, no lo mas mirado.
--
-- Sale de `order_items` y no de `product_view` a proposito: un producto que se
-- mira mucho y no se vende es una pregunta interesante, pero no es «producto
-- mas vendido», y mezclarlos produce el listado que nadie sabe interpretar.
-- El `product_id` puede ser NULL (producto borrado): se agrupa por SKU, que es
-- lo que el pedido congelo y sigue siendo cierto.
-- =============================================================================
create or replace function public.analytics_top_products(
  p_store_id uuid default null,
  p_from     timestamptz default null,
  p_to       timestamptz default null,
  p_limit    integer default 10
)
returns table (
  product_id uuid,
  sku        text,
  name       text,
  units      bigint,
  revenue    text,
  currency   text,
  orders     bigint
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select (array_agg(oi.product_id) filter (where oi.product_id is not null))[1] as product_id,
         oi.sku,
         (array_agg(oi.name order by o.placed_at desc))[1] as name,
         sum(oi.quantity)::bigint as units,
         sum(oi.line_total)::text as revenue,
         (array_agg(distinct o.currency::text))[1] as currency,
         count(distinct o.id)::bigint as orders
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.status <> 'cancelled'
     and o.placed_at >= ebim.analytics_from(p_from)
     and o.placed_at <  ebim.analytics_to(p_to)
     and (p_store_id is null or o.store_id = p_store_id)
   group by oi.sku
   order by sum(oi.quantity) desc, oi.sku
   limit greatest(1, least(coalesce(p_limit, 10), 200));
$fn$;

revoke execute on function public.analytics_top_products(uuid, timestamptz, timestamptz, integer)
  from public, anon;
grant execute on function public.analytics_top_products(uuid, timestamptz, timestamptz, integer)
  to authenticated, service_role;

-- =============================================================================
-- public.analytics_channel_performance — rendimiento por canal.
--
-- El canal es del PEDIDO (`orders.channel_id`, NOT NULL desde P02 histórico),
-- no del evento: un pedido creado desde el backoffice no tiene sesion de
-- navegador y aun asi pertenece a un canal. Por eso el agregado sale de
-- `orders` y no de `analytics_events`, y por eso este indicador es baseline.
-- =============================================================================
create or replace function public.analytics_channel_performance(
  p_store_id uuid default null,
  p_from     timestamptz default null,
  p_to       timestamptz default null
)
returns table (
  channel_id   uuid,
  channel_code text,
  channel_name text,
  channel_kind text,
  orders       bigint,
  units        bigint,
  revenue      text,
  currency     text
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select ch.id,
         ch.code,
         ch.name,
         ch.kind::text,
         count(distinct o.id)::bigint,
         coalesce(sum(items.units), 0)::bigint,
         case when count(distinct o.currency::text) = 1
              then coalesce(sum(o.grand_total), 0)::text end,
         case when count(distinct o.currency::text) = 1
              then (array_agg(distinct o.currency::text))[1] end
    from public.orders o
    join public.channels ch on ch.id = o.channel_id
    left join lateral (
      select coalesce(sum(oi.quantity), 0)::bigint as units
        from public.order_items oi where oi.order_id = o.id
    ) items on true
   where o.status <> 'cancelled'
     and o.placed_at >= ebim.analytics_from(p_from)
     and o.placed_at <  ebim.analytics_to(p_to)
     and (p_store_id is null or o.store_id = p_store_id)
   group by ch.id, ch.code, ch.name, ch.kind
   order by count(distinct o.id) desc, ch.code;
$fn$;

revoke execute on function public.analytics_channel_performance(uuid, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.analytics_channel_performance(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

-- =============================================================================
-- public.analytics_timeseries — la serie diaria, que es tambien la exportacion.
--
-- Devuelve filas y no un jsonb con un array dentro: una tabla se exporta a CSV
-- tal cual, y ese es literalmente el requisito («KPIs reales y exportables»).
-- Los dias sin pedidos SALEN, con ceros: una serie con huecos se pinta como una
-- linea que salta y se lee como si el negocio hubiera parado.
-- =============================================================================
create or replace function public.analytics_timeseries(
  p_store_id uuid default null,
  p_from     timestamptz default null,
  p_to       timestamptz default null
)
returns table (
  day      date,
  orders   bigint,
  units    bigint,
  revenue  text,
  currency text
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  with dias as (
    select generate_series(
             date_trunc('day', ebim.analytics_from(p_from)),
             date_trunc('day', ebim.analytics_to(p_to)),
             interval '1 day')::date as day
  ),
  pedidos as (
    select date_trunc('day', o.placed_at)::date as day,
           count(*)::bigint as orders,
           coalesce(sum(o.grand_total), 0) as revenue,
           count(distinct o.currency::text) as monedas,
           (array_agg(distinct o.currency::text))[1] as currency,
           coalesce(sum((select coalesce(sum(oi.quantity), 0)
                           from public.order_items oi where oi.order_id = o.id)), 0)::bigint as units
      from public.orders o
     where o.status <> 'cancelled'
       and o.placed_at >= ebim.analytics_from(p_from)
       and o.placed_at <  ebim.analytics_to(p_to)
       and (p_store_id is null or o.store_id = p_store_id)
     group by 1
  )
  select d.day,
         coalesce(p.orders, 0),
         coalesce(p.units, 0),
         -- Dia sin pedidos: cero de verdad. Dia con monedas mezcladas: NULL,
         -- por el mismo motivo que en el resto del archivo.
         case when p.day is null then '0'
              when p.monedas = 1 then p.revenue::text end,
         case when p.monedas = 1 then p.currency end
    from dias d
    left join pedidos p on p.day = d.day
   order by d.day;
$fn$;

revoke execute on function public.analytics_timeseries(uuid, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.analytics_timeseries(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

-- =============================================================================
-- EL MODULO VENDIBLE: el comportamiento del comprador.
-- =============================================================================

-- public.analytics_funnel — los nueve hechos, con sus sesiones distintas.
--
-- `sessions` es NULL, no 0, cuando ningun hecho de ese tipo trae sesion: los
-- seis hechos de servidor no la tienen y nunca la tendran, porque no nacen en
-- un navegador. Un 0 ahi se leeria como «nadie», que es falso.
create or replace function public.analytics_funnel(
  p_store_id uuid default null,
  p_from     timestamptz default null,
  p_to       timestamptz default null
)
returns table (
  event_type text,
  events     bigint,
  sessions   bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
begin
  perform ebim.assert_analytics_advanced();

  return query
  select tipos.code,
         count(e.id)::bigint,
         nullif(count(distinct e.session_hash), 0)::bigint
    from (select unnest(enum_range(null::public.analytics_event_type))::text as code) tipos
    left join public.analytics_events e
      on e.event_type::text = tipos.code
     and e.occurred_at >= ebim.analytics_from(p_from)
     and e.occurred_at <  ebim.analytics_to(p_to)
     and (p_store_id is null or e.store_id = p_store_id)
   group by tipos.code
   order by tipos.code;
end;
$fn$;

revoke execute on function public.analytics_funnel(uuid, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.analytics_funnel(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

-- public.analytics_search_terms — que buscan y que no encuentran.
--
-- `zero_results` es el numero que de verdad se acciona: un termino buscado
-- cincuenta veces con cero resultados es un producto que falta en el catalogo o
-- un sinonimo que falta en `search_synonyms` (P11).
create or replace function public.analytics_search_terms(
  p_store_id uuid default null,
  p_from     timestamptz default null,
  p_to       timestamptz default null,
  p_limit    integer default 20
)
returns table (
  term         text,
  searches     bigint,
  zero_results bigint,
  sessions     bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
begin
  perform ebim.assert_analytics_advanced();

  return query
  select lower(e.search_term),
         count(*)::bigint,
         count(*) filter (where coalesce(e.result_count, 0) = 0)::bigint,
         nullif(count(distinct e.session_hash), 0)::bigint
    from public.analytics_events e
   where e.event_type = 'search'
     and e.search_term is not null
     and e.occurred_at >= ebim.analytics_from(p_from)
     and e.occurred_at <  ebim.analytics_to(p_to)
     and (p_store_id is null or e.store_id = p_store_id)
   group by lower(e.search_term)
   order by count(*) desc, lower(e.search_term)
   limit greatest(1, least(coalesce(p_limit, 20), 200));
end;
$fn$;

revoke execute on function public.analytics_search_terms(uuid, timestamptz, timestamptz, integer)
  from public, anon;
grant execute on function public.analytics_search_terms(uuid, timestamptz, timestamptz, integer)
  to authenticated, service_role;

comment on function public.analytics_kpis(uuid, timestamptz, timestamptz) is
  'Cuadro de mando del comercio. SECURITY INVOKER: la RLS decide que filas cuentan. Toda razon devuelve NULL cuando su denominador es cero: nunca un 0 % inventado.';
comment on function public.analytics_funnel(uuid, timestamptz, timestamptz) is
  'Embudo de los nueve hechos canonicos. Exige la capacidad analytics.advanced: sin ella levanta SIN_MODULO en vez de devolver una lista vacia.';
