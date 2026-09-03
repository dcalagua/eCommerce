-- =============================================================================
-- Activa los diez addons del recorrido B2B para la sociedad de DEMOSTRACION.
--
-- Por que hace falta: las diez capacidades nuevas se registraron en
-- `app_capabilities` con las migraciones, pero eso solo dice que EXISTEN. Que
-- una sociedad las TENGA es otra cosa, y vive en `tenant_entitlements`. Sin
-- estas filas las ocho pantallas nuevas no salen ni en el menu, y su ruta pinta
-- «no esta en tu plan» — que es el comportamiento correcto, no un fallo.
--
-- Solo para la sociedad de miquimica en DEV. En produccion esto lo escribe el
-- hub al contratar el addon, nunca un script.
--
--   node scripts/apply-demo-data.mjs --file supabase/b2b-entitlements.sql
--
-- Idempotente. Para volver atras y ver como se degrada una pantalla sin su
-- addon, basta con desactivar la fila:
--
--   update public.tenant_entitlements set is_active = false
--    where entitlement_code = 'ecommerce.trade.quotes';
-- =============================================================================

insert into public.tenant_entitlements
  (organization_id, company_id, entitlement_code, is_active, source)
select 'd0000000-0000-4000-8000-000000000001'::uuid,
       'd0000000-0000-4000-8000-0000000000c1'::uuid,
       code,
       true,
       'provisioning'::public.entitlement_source
  from (values
    ('ecommerce.sales.force'),
    ('ecommerce.sales.territory'),
    ('ecommerce.sales.performance'),
    ('ecommerce.credit.management'),
    ('ecommerce.invoicing'),
    ('ecommerce.trade.quotes'),
    ('ecommerce.trade.assortments'),
    ('ecommerce.trade.promotions'),
    ('ecommerce.fulfillment.routing'),
    ('ecommerce.planning.demand')
  ) as t(code)
on conflict (organization_id, company_id, entitlement_code)
do update set is_active = true, updated_at = now();
