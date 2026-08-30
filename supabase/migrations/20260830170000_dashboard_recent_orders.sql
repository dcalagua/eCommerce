-- =============================================================================
-- P18 · Ultimos pedidos en el resumen
-- 96/96 — El panel tenia cifras y desgloses, pero nada que se pueda MIRAR: un
--         resumen operativo se abre para ver que ha pasado, no solo cuanto.
--
-- Cinco pedidos, los mas recientes. Cinco y no diez porque el panel es un
-- vistazo: si hacen falta mas, el sitio es la pantalla de pedidos, y por eso la
-- tabla lleva su enlace a «ver todo».
--
-- `security invoker` como el resto de la funcion: cuenta y lista bajo la RLS de
-- quien pregunta.
-- =============================================================================

create or replace function public.dashboard_recent_orders(p_store_id uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'order_number', o.order_number,
           'status',       o.status::text,
           'customer',     coalesce(o.customer_name, o.customer_email),
           -- Dinero como texto, misma razon que en el resto del panel: un
           -- numeric en JSON se vuelve float en el primer JSON.parse.
           'total',        o.grand_total::text,
           'currency',     o.currency,
           'placed_at',    o.placed_at)
           order by o.placed_at desc), '[]'::jsonb)
  from (
    select *
    from public.orders o2
    where p_store_id is null or o2.store_id = p_store_id
    order by o2.placed_at desc
    limit 5
  ) o;
$fn$;

revoke execute on function public.dashboard_recent_orders(uuid) from public, anon;
grant  execute on function public.dashboard_recent_orders(uuid) to authenticated, service_role;

comment on function public.dashboard_recent_orders(uuid) is
  'Cinco pedidos mas recientes para el resumen. Un vistazo, no un listado: para eso esta la pantalla de pedidos.';
