-- =============================================================================
-- P03 · 09/09 — KPIs del panel del backoffice.
--
-- `SECURITY INVOKER` a propósito (y explícito, aunque sea el default): la
-- función corre con los privilegios del usuario, así que la RLS de `products`
-- y `orders` sigue decidiendo qué filas cuentan. Una definer aquí sería un
-- agujero: devolvería agregados de todos los tenants sin que ninguna policy
-- pudiera impedirlo.
--
-- No recibe `organization_id` ni `company_id`: el tenant sale del JWT vía las
-- policies. El único parámetro es la tienda, y una tienda ajena simplemente no
-- aporta filas visibles (cuenta 0), no filtra datos.
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
  v_sales      numeric(14,2);
  v_currencies text[];
begin
  select count(*),
         count(*) filter (where p.status = 'published')
    into v_products, v_published
  from public.products p
  where p_store_id is null or p.store_id = p_store_id;

  -- Las ventas excluyen los pedidos anulados. `array_agg distinct` sobre la
  -- moneda es el guard: si la selección mezcla monedas, no hay un total que
  -- se pueda mostrar sin mentir, y la función devuelve null en vez de sumar
  -- soles con dólares.
  select count(*),
         coalesce(sum(o.grand_total) filter (where o.status <> 'cancelled'), 0),
         coalesce(
           array_agg(distinct o.currency::text) filter (where o.status <> 'cancelled'),
           '{}'::text[]
         )
    into v_orders, v_sales, v_currencies
  from public.orders o
  where p_store_id is null or o.store_id = p_store_id;

  return jsonb_build_object(
    'products',  v_products,
    'published', v_published,
    'orders',    v_orders,
    -- Dinero como TEXTO (decisión P02 #19): un numeric en JSON se convierte en
    -- float en el primer JSON.parse del navegador.
    'sales',    case when array_length(v_currencies, 1) = 1 then v_sales::text end,
    'currency', case when array_length(v_currencies, 1) = 1 then v_currencies[1] end
  );
end;
$fn$;

-- El comprador anónimo del storefront no tiene nada que hacer con esto.
revoke execute on function public.dashboard_kpis(uuid) from public, anon;
grant  execute on function public.dashboard_kpis(uuid) to authenticated, service_role;

comment on function public.dashboard_kpis(uuid) is
  'KPIs del panel. SECURITY INVOKER: la RLS del usuario decide que filas cuentan. '
  'Devuelve `sales`/`currency` en null cuando no hay una unica moneda: sin cifra inventada.';
