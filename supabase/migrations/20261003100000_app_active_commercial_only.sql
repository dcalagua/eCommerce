-- =============================================================================
-- CCP fase 18 · D-14 regla 2 (2026-09-29, aprobada por el humano para DEV/LOCAL)
--
--   «appActive=false retira las capacidades/entitlements COMERCIALES del SaaS;
--    NO bloquea por sí solo toda la aplicación operativa.»
--
-- Hasta aquí (20260914180000) la regla era:
--
--   app activa AND (baseline OR ((entitlement OR fallback legado) AND flag <> false))
--
-- con lo que `app_active = false` apagaba también lo BASELINE (catálogo,
-- vitrina, checkout, pedidos, analítica básica): el tenant quedaba sin
-- operación. La regla nueva:
--
--   baseline
--   OR ( app activa AND (entitlement OR fallback legado) AND flag <> false )
--
-- · Lo baseline no depende de `app_active` (ni de un flag, como antes).
-- · Lo vendible exige app activa, igual que antes. Ningún entitlement ni
--   fallback legado concede nada mientras la app esté inactiva.
-- · Nada más cambia: `has_capability`, `assert_capability`,
--   `effective_capabilities` y las policies leen esta función; las vistas que
--   filtran por `app_active` (`ebim.active_price_lists`) gatean capacidades
--   VENDIBLES (`pricing.lists`, `trade.quotes`) y quedan como están; el
--   manifiesto del receptor (`platform_entitlements.known_codes`) excluye lo
--   baseline, así que `record_shadow_diffs` no ve diferencia nueva.
--
-- Solo redefine la función (misma firma, mismo SECURITY INVOKER, mismo
-- search_path). Reversible reaplicando el cuerpo de 20260914180000.
-- =============================================================================

create or replace function ebim.company_is_entitled(
  p_organization_id uuid,
  p_company_id uuid,
  p_capability text
)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.app_capabilities cap
     where cap.code = p_capability
       and (
         cap.is_baseline
         or (
           coalesce(
             (select ctx.app_active
                from public.tenant_platform_context ctx
               where ctx.organization_id = p_organization_id
                 and ctx.company_id      = p_company_id),
             true)
           and (
             exists (
               select 1
                 from public.tenant_entitlements ent
                where ent.organization_id  = p_organization_id
                  and ent.company_id       = p_company_id
                  and ent.entitlement_code = cap.entitlement_code
                  and ent.is_active
             )
             or (
               cap.legacy_until_synced
               and not exists (
                 select 1
                   from public.tenant_platform_context ctx
                  where ctx.organization_id = p_organization_id
                    and ctx.company_id      = p_company_id
               )
               and (
                 current_user not in ('anon', 'authenticated')
                 or ebim.can_access(p_organization_id, p_company_id)
               )
             )
           )
           and coalesce(
             (select flag.is_enabled
                from public.tenant_feature_flags flag
               where flag.organization_id = p_organization_id
                 and flag.company_id      = p_company_id
                 and flag.flag_key        = cap.code),
             true)
         )
       )
  );
$fn$;

comment on function ebim.company_is_entitled(uuid, uuid, text) is
  '¿La sociedad tiene el módulo? baseline OR (app activa AND (entitlement activo OR fallback legado de sociedad nunca sincronizada) AND flag <> false). D-14 regla 2: app_active=false retira lo comercial, no lo baseline. SECURITY INVOKER.';
