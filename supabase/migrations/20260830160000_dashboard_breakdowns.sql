-- =============================================================================
-- P18 · El resumen deja de ser cuatro cifras sueltas
-- 95/95 — `dashboard_kpis` devolvia productos, publicados, pedidos y ventas. Con
--         eso no se puede dibujar nada: son cuatro escalares sin estructura.
--
-- Se anaden tres desgloses elegidos por lo que puede AFIRMAR la base con los
-- datos que hay, no por lo que quedaria bonito:
--
--   · `avg_ticket`   — ventas / pedidos vendidos. Un escalar mas, pero es la
--                      cifra que un comerciante mira antes que ninguna otra.
--   · `by_status`    — reparto de pedidos por estado. Pocas categorias, sin
--                      dependencia del tiempo: legible con 8 pedidos y con 8.000.
--   · `top_products` — los cinco productos por ingreso. Es la unica pregunta
--                      accionable que se responde con doce lineas de pedido.
--
-- Deliberadamente NO se anade una serie temporal. Los pedidos de esta tienda
-- caen todos en un dia: una linea de «ventas por dia» seria un punto, y un
-- grafico que no puede variar es decoracion que finge informacion.
--
-- `security invoker` como la original: cuenta bajo la RLS de quien pregunta, no
-- por encima de ella.
-- =============================================================================

create or replace function public.dashboard_kpis(p_store_id uuid default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_products   bigint;
  v_published  bigint;
  v_orders     bigint;
  v_sold       bigint;
  v_sales      numeric(14,2);
  v_currencies text[];
  v_by_status  jsonb;
  v_top        jsonb;
begin
  select count(*),
         count(*) filter (where p.status = 'published')
    into v_products, v_published
  from public.products p
  where p_store_id is null or p.store_id = p_store_id;

  -- Las ventas excluyen los pedidos anulados. `array_agg distinct` sobre la
  -- moneda es el guard: si la seleccion mezcla monedas, no hay un total que se
  -- pueda mostrar sin mentir, y la funcion devuelve null en vez de sumar soles
  -- con dolares.
  select count(*),
         count(*) filter (where o.status <> 'cancelled'),
         coalesce(sum(o.grand_total) filter (where o.status <> 'cancelled'), 0),
         coalesce(
           array_agg(distinct o.currency::text) filter (where o.status <> 'cancelled'),
           '{}'::text[]
         )
    into v_orders, v_sold, v_sales, v_currencies
  from public.orders o
  where p_store_id is null or o.store_id = p_store_id;

  -- Reparto por estado, ordenado de mayor a menor. Se devuelve el codigo del
  -- enum, no una etiqueta: quien traduce es la pantalla, que es la que sabe el
  -- idioma del usuario.
  select coalesce(jsonb_agg(jsonb_build_object('status', s.status, 'count', s.n)
                            order by s.n desc, s.status), '[]'::jsonb)
    into v_by_status
  from (
    select o.status::text as status, count(*) as n
    from public.orders o
    where p_store_id is null or o.store_id = p_store_id
    group by o.status
  ) s;

  -- Cinco productos por ingreso. Se lee de `order_items`, que guarda el precio
  -- CONGELADO del pedido: si el catalogo sube de precio manana, lo que ya se
  -- vendio no cambia de importe retroactivamente.
  select coalesce(jsonb_agg(jsonb_build_object(
           'sku',     t.sku,
           'name',    t.name,
           'units',   t.units,
           'revenue', t.revenue::text)
           order by t.revenue desc, t.name), '[]'::jsonb)
    into v_top
  from (
    select i.sku,
           max(i.name) as name,
           sum(i.quantity)::bigint as units,
           sum(i.unit_price * i.quantity) as revenue
    from public.order_items i
    join public.orders o on o.id = i.order_id
    where (p_store_id is null or i.store_id = p_store_id)
      and o.status <> 'cancelled'
    group by i.sku
    order by revenue desc, max(i.name)
    limit 5
  ) t;

  return jsonb_build_object(
    'products',  v_products,
    'published', v_published,
    'orders',    v_orders,
    -- Dinero como TEXTO (decision P02 #19): un numeric en JSON se convierte en
    -- float en el primer JSON.parse del navegador.
    'sales',    case when array_length(v_currencies, 1) = 1 then v_sales::text end,
    'currency', case when array_length(v_currencies, 1) = 1 then v_currencies[1] end,
    -- El ticket medio hereda el mismo guard que las ventas: sin moneda unica no
    -- hay promedio que ensenar, y con cero pedidos vendidos no se divide.
    'avg_ticket', case
                    when array_length(v_currencies, 1) = 1 and v_sold > 0
                    then round(v_sales / v_sold, 2)::text
                  end,
    'by_status',    v_by_status,
    'top_products', v_top
  );
end;
$fn$;

revoke execute on function public.dashboard_kpis(uuid) from public, anon;
grant  execute on function public.dashboard_kpis(uuid) to authenticated, service_role;

comment on function public.dashboard_kpis(uuid) is
  'Cifras y desgloses del resumen, bajo la RLS de quien pregunta. Sin serie temporal: los datos no la sostienen.';
