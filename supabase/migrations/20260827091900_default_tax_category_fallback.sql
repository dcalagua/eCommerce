-- =============================================================================
-- P09 · La categoria marcada "por defecto" tiene que aplicarse de verdad
-- 19/19 — `tax_categories.is_default` era decorativo: la cascada de
--         `ebim.effective_tax_rate` solo miraba `store_settings.tax_category_id`,
--         que no lo rellena nadie. Marcar una categoria por defecto en el
--         backoffice no cambiaba ni un centimo del pedido.
--
-- Cascada corregida, de mas especifico a mas general:
--   1. categoria fiscal del PRODUCTO
--   2. categoria explicita de la TIENDA (`store_settings.tax_category_id`)
--   3. categoria `is_default` de la SOCIEDAD  <- nivel que faltaba
--   4. `store_settings.tax_rate` (legado)
--   5. 0
--
-- El nivel 3 va a nivel de sociedad y no de tienda a proposito: el indice
-- `tax_categories_one_default` ya garantiza una sola por (organization_id,
-- company_id), asi que dar de alta una tienda nueva hereda el IVA del pais sin
-- tener que acordarse de configurarla.
-- =============================================================================

create or replace function ebim.effective_tax_rate(
  p_store_id        uuid,
  p_tax_category_id uuid default null,
  p_at              timestamptz default now()
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  with authorized as (
    select s.id, s.organization_id, s.company_id
    from public.stores s
    where s.id = p_store_id
      and s.status = 'active'
  ),
  resolved_category as (
    select coalesce(
      -- 1 · la del producto, si es del mismo tenant
      (select tc.id
         from public.tax_categories tc, authorized a
        where tc.id = p_tax_category_id
          and tc.organization_id = a.organization_id
          and tc.company_id = a.company_id),
      -- 2 · la que la tienda haya fijado explicitamente
      (select ss.tax_category_id
         from public.store_settings ss, authorized a
        where ss.store_id = a.id),
      -- 3 · la marcada por defecto en la sociedad
      (select tc.id
         from public.tax_categories tc, authorized a
        where tc.organization_id = a.organization_id
          and tc.company_id = a.company_id
          and tc.is_default)
    ) as id
  )
  select coalesce(
    (select tr.rate
       from public.tax_rates tr, resolved_category rc
      where tr.tax_category_id = rc.id
        and tr.valid_from <= p_at
        and (tr.valid_to is null or tr.valid_to > p_at)
      order by tr.valid_from desc
      limit 1),
    -- 4 · legado, mientras queden tiendas sin categoria configurada
    (select ss.tax_rate
       from public.store_settings ss, authorized a
      where ss.store_id = a.id),
    0
  );
$fn$;

revoke execute on function ebim.effective_tax_rate(uuid, uuid, timestamptz) from public;
grant  execute on function ebim.effective_tax_rate(uuid, uuid, timestamptz)
  to anon, authenticated, service_role;

comment on function ebim.effective_tax_rate(uuid, uuid, timestamptz) is
  'Tasa vigente: producto -> tienda -> categoria por defecto de la sociedad -> tax_rate legado -> 0.';
