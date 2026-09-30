-- =============================================================================
-- pgTAP · receptor de entitlements de EBIM MasterAdmin (20261001090000/100000).
--
-- Corre sobre un Supabase LOCAL recién creado (`supabase test db`), con los
-- roles y defaults de privilegios REALES de Supabase — lo que el banco PGlite
-- de Vitest recrea a mano. Todo en una transacción que se deshace al final.
--
-- El checksum aquí es sintético: el receptor SQL no recalcula JCS (lo hace la
-- Edge Function antes de llamar a la RPC); aquí se prueban las reglas de
-- versión, los modos y la política del camino legado.
-- =============================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(30);

-- ── 1 · Privacidad ──────────────────────────────────────────────────────────
select has_schema('platform_entitlements');
select ok(not has_schema_privilege('anon', 'platform_entitlements', 'USAGE'), 'anon sin USAGE');
select ok(not has_schema_privilege('authenticated', 'platform_entitlements', 'USAGE'), 'authenticated sin USAGE');
select is((select count(*)::int from information_schema.role_table_grants
            where table_schema = 'platform_entitlements'
              and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')), 0, 'ninguna tabla con GRANT');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'platform_entitlements' and c.relkind = 'r'
              and not (c.relrowsecurity and c.relforcerowsecurity)), 0, 'RLS activada y forzada en todas');
select ok(not has_function_privilege('anon', 'public.platform_apply_entitlements(uuid, jsonb, jsonb)', 'EXECUTE'), 'anon no aplica');
select ok(not has_function_privilege('authenticated', 'public.platform_apply_entitlements(uuid, jsonb, jsonb)', 'EXECUTE'), 'authenticated no aplica');
select ok(has_function_privilege('service_role', 'public.platform_apply_entitlements(uuid, jsonb, jsonb)', 'EXECUTE'), 'service_role aplica');
select ok(not has_function_privilege('authenticated', 'public.platform_set_entitlement_enforcement_mode(text, text, text)', 'EXECUTE'),
          'authenticated no cambia el modo');
select ok(not has_function_privilege('authenticated', 'public.platform_get_entitlements(uuid)', 'EXECUTE'), 'authenticated no lee lo aplicado');
select ok(not has_function_privilege('anon', 'public.platform_entitlements_use_jti(text, text, timestamptz)', 'EXECUTE'), 'anon no gasta jti');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'platform_entitlements'
              and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
          0, 'funciones internas cerradas');

-- ── 2 · Tenant aprovisionado por la RPC real ────────────────────────────────
create temp table t_out (step text, r jsonb) on commit drop;
grant all on t_out to service_role;

set local role service_role;
insert into t_out select 'provision', public.platform_provision_tenant(
  '{"controlPlaneTenantId":"7d000000-0000-4000-8000-000000000001",
    "organization":{"id":"7d000000-0000-4000-8000-0000000000a1","slug":"pgtap-ent","name":"PgTap Ent"},
    "company":{"id":"7d000000-0000-4000-8000-0000000000c1"},
    "admin":{"email":"owner@pgtap-ent.test"},"deploymentMode":"SHARED"}'::jsonb,
  '{"idempotencyKey":"pgtap-ent-0001","requestHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "correlationId":"7d000000-0000-4000-8000-00000000cc01","m2mSubject":"masteradmin-provisioning","m2mJti":"e1"}'::jsonb);
reset role;

create temp table t_snap (v int primary key, doc jsonb) on commit drop;
grant all on t_snap to service_role;
insert into t_snap values
  (1, '{"controlPlaneTenantId":"7d000000-0000-4000-8000-000000000001","snapshotVersion":1,"appActive":true,
        "planCode":"ecommerce-shared-standard","idempotencyKey":"ma-ent-v1-x",
        "checksum":"sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "capabilities":[{"code":"ecommerce.promotions","enabled":true,"scope":{"level":"TENANT"},"sources":["PLAN"]},
                        {"code":"ecommerce.ai.assist","enabled":true,"scope":{"level":"TENANT"},"sources":["PLAN"]},
                        {"code":"ecommerce.payments","enabled":false,"scope":{"level":"TENANT"},"sources":[]}],
        "limits":[],
        "allowances":[{"code":"ecommerce.ai.credits","meterCode":"ai.credits","included":1,"unit":"credit",
                       "period":{"start":"2026-10-01","end":"2026-10-31"},"overageMode":"BLOCK","sources":["PLAN"]}]}'),
  (0, '{"controlPlaneTenantId":"7d000000-0000-4000-8000-000000000001","snapshotVersion":1,"appActive":true,
        "checksum":"sha256:2222222222222222222222222222222222222222222222222222222222222222",
        "capabilities":[],"limits":[],"allowances":[]}');

-- ── 3 · Reglas de versión en SHADOW (por defecto): guarda, no decide ────────
set local role service_role;
insert into t_out select 'apply', public.platform_apply_entitlements('7d000000-0000-4000-8000-000000000001', (select doc from t_snap where v = 1), '{}'::jsonb);
insert into t_out select 'replay', public.platform_apply_entitlements('7d000000-0000-4000-8000-000000000001', (select doc from t_snap where v = 1), '{}'::jsonb);
insert into t_out select 'conflict', public.platform_apply_entitlements('7d000000-0000-4000-8000-000000000001', (select doc from t_snap where v = 0), '{}'::jsonb);
insert into t_out select 'get', public.platform_get_entitlements('7d000000-0000-4000-8000-000000000001');
insert into t_out select 'jti1', to_jsonb(public.platform_entitlements_use_jti('masteradmin.ebim', 'pgtap-jti', now() + interval '2 minutes'));
insert into t_out select 'jti2', to_jsonb(public.platform_entitlements_use_jti('masteradmin.ebim', 'pgtap-jti', now() + interval '2 minutes'));
reset role;

select is((select (r ->> 'httpStatus')::int from t_out where step = 'apply'), 200, 'apply: 200');
select is((select r #>> '{body,replayed}' from t_out where step = 'replay'), 'true', 'replay: replayed');
select is((select r #>> '{body,error}' from t_out where step = 'conflict'), 'VERSION_CONFLICT', 'misma versión, otro checksum: 409');
select is((select r ->> 'enforcementMode' from t_out where step = 'get'), 'SHADOW', 'modo por defecto: SHADOW');
select is((select r::text from t_out where step = 'jti1'), 'true', 'jti: primer uso');
select is((select r::text from t_out where step = 'jti2'), 'false', 'jti: reutilizado');
select ok(not ebim.company_is_entitled('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-0000000000c1', 'promotions'),
          'SHADOW: el snapshot NO concede');
select ok((select count(*) > 0 from platform_entitlements.shadow_diffs
            where control_plane_tenant_id = '7d000000-0000-4000-8000-000000000001'), 'SHADOW: diferencias registradas');

-- ── 4 · PRIMARY: decide el snapshot, el camino legado queda bloqueado ───────
select throws_ok($$select public.platform_set_entitlement_enforcement_mode('7d000000-0000-4000-8000-000000000001', 'PRIMARY', 't')$$,
                 '22023', null, 'no se salta de SHADOW a PRIMARY');
set local role service_role;
insert into t_out select 'dual', public.platform_set_entitlement_enforcement_mode('7d000000-0000-4000-8000-000000000001', 'DUAL_READ', 'pgtap');
insert into t_out select 'primary', public.platform_set_entitlement_enforcement_mode('7d000000-0000-4000-8000-000000000001', 'PRIMARY', 'pgtap');
reset role;

select ok(ebim.company_is_entitled('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-0000000000c1', 'promotions'),
          'PRIMARY: el snapshot concede');
select ok(not ebim.company_is_entitled('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-0000000000c1', 'payments'),
          'PRIMARY: legacy_until_synced resuelto');
select is((select source::text from public.tenant_platform_context where organization_id = '7d000000-0000-4000-8000-0000000000a1'),
          'masteradmin', 'caché escrita con origen masteradmin');
select throws_ok($$select public.sync_platform_context('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-0000000000c1',
                   true, array['ecommerce.payments'], 'provisioning', null)$$,
                 '42501', null, 'H-ECO-1: la clave estática no concede en PRIMARY');
select throws_ok($$select public.sync_platform_context('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-0000000000c1',
                   true, array['ecommerce.payments'], 'masteradmin', null)$$,
                 '42501', null, 'nadie se hace pasar por el receptor');
select is((select ebim.ai_consume_for('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-0000000000c1', 'assistant', 1) ->> 'allowed'),
          'true', 'IA: dentro de la asignación');
select is((select ebim.ai_consume_for('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-0000000000c1', 'assistant', 1) ->> 'reason'),
          'QUOTA_EXCEEDED', 'IA: el hard gate corta al agotar la asignación');

-- ── 5 · Auditoría append-only ───────────────────────────────────────────────
select throws_ok($$update platform_entitlements.apply_audit set outcome = outcome$$, '42501', null, 'audit: UPDATE rechazado');
select throws_ok($$delete from platform_entitlements.apply_audit$$, '42501', null, 'audit: DELETE rechazado');

select * from finish();
rollback;
