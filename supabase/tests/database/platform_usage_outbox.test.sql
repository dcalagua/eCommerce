-- =============================================================================
-- pgTAP · outbox de uso ebim.usage/v1 (20261002100000_usage_outbox.sql).
--
-- Corre sobre un Supabase LOCAL (`supabase test db`) con los roles y los
-- defaults de privilegios REALES de Supabase. Todo en una transacción que se
-- deshace al final (now() es constante: los backoff se miden exactos). Las
-- mismas aserciones corren en PGlite (`supabase/tests/usage-outbox-db.test.ts`).
-- =============================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(39);

-- ── 1 · Privacidad ──────────────────────────────────────────────────────────
select has_schema('platform_usage');
select has_table('platform_usage', 'usage_outbox', 'usage_outbox existe');
select ok(not has_schema_privilege('anon', 'platform_usage', 'USAGE'), 'anon sin USAGE');
select ok(not has_schema_privilege('authenticated', 'platform_usage', 'USAGE'), 'authenticated sin USAGE');
select is((select count(*)::int from information_schema.role_table_grants
            where table_schema = 'platform_usage'
              and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')), 0, 'ninguna tabla con GRANT');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'platform_usage.usage_outbox'::regclass), 'RLS activada y forzada');
select ok(not has_function_privilege('anon', 'public.platform_usage_outbox_claim(integer, integer)', 'EXECUTE'), 'anon no reclama');
select ok(not has_function_privilege('authenticated', 'public.platform_usage_outbox_claim(integer, integer)', 'EXECUTE'), 'authenticated no reclama');
select ok(has_function_privilege('service_role', 'public.platform_usage_outbox_claim(integer, integer)', 'EXECUTE'), 'service_role reclama');
select ok(not has_function_privilege('anon', 'public.platform_usage_outbox_mark(jsonb)', 'EXECUTE'), 'anon no marca');
select ok(not has_function_privilege('authenticated', 'public.platform_usage_outbox_mark(jsonb)', 'EXECUTE'), 'authenticated no marca');
select ok(has_function_privilege('service_role', 'public.platform_usage_outbox_mark(jsonb)', 'EXECUTE'), 'service_role marca');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'platform_usage'
              and (has_function_privilege('anon', p.oid, 'EXECUTE')
                   or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   or has_function_privilege('service_role', p.oid, 'EXECUTE'))),
          0, 'funciones internas cerradas');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'platform_usage_outbox_%'),
          'RPC DEFINER con search_path fijo');
select matches(lower(pg_get_functiondef('public.platform_usage_outbox_claim(integer, integer)'::regprocedure)),
               'for update skip locked', 'el reclamo usa SKIP LOCKED');

-- ── 2 · Tenant A por la RPC real de provisioning (mapping ACTIVE); B legado ─
create temp table t_out (step text, r jsonb) on commit drop;
grant all on t_out to service_role;

set local role service_role;
insert into t_out select 'provision', public.platform_provision_tenant(
  '{"controlPlaneTenantId":"17a00000-0000-4000-8000-00000000000a",
    "organization":{"id":"17a00000-0000-4000-8000-0000000000a0","slug":"usage-pgtap","name":"Usage PgTap"},
    "company":{"id":"17a00000-0000-4000-8000-0000000000c0"},
    "admin":{"email":"owner@usage-pgtap.test"},"deploymentMode":"SHARED"}'::jsonb,
  '{"idempotencyKey":"usage-pgtap-0001","requestHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "correlationId":"17a00000-0000-4000-8000-00000000cc01","m2mSubject":"masteradmin-provisioning","m2mJti":"ju1"}'::jsonb);
reset role;

-- ── 3 · Misma transacción que ai_record_for (éxito, fallo, legado) ─────────
create temp table t_ids (label text primary key, id uuid) on commit drop;
insert into t_ids values ('ok', ebim.ai_record_for(
  '17a00000-0000-4000-8000-0000000000a0', '17a00000-0000-4000-8000-0000000000c0',
  'content', 'ai', 'claude-sonnet-5', 'prompt', 'respuesta', 120, 45, 0, 850, null));
insert into t_ids values ('fail', ebim.ai_record_for(
  '17a00000-0000-4000-8000-0000000000a0', '17a00000-0000-4000-8000-0000000000c0',
  'content', 'error', 'desconocido', 'prompt', null, 0, 0, 0, 0, 'timeout'));
insert into t_ids values ('legacy', ebim.ai_record_for(
  '17a00000-0000-4000-8000-0000000000a1', '17a00000-0000-4000-8000-0000000000c1',
  'content', 'ai', 'claude-sonnet-5', 'prompt', 'respuesta', 1, 1, 0, 1, null));

create temp table t_ev on commit drop as
  select t.label, o.event_id from platform_usage.usage_outbox o join t_ids t on t.id = o.source_interaction_id;
grant select on t_ev to service_role;

select is((select count(*)::int from t_ev), 3, 'cada traza encola un evento');
select results_eq(
  $$select meter_code, quantity, unit, control_plane_tenant_id, capability_code, status, attempts
      from platform_usage.usage_outbox where event_id = (select event_id from t_ev where label = 'ok')$$,
  $$values ('ecommerce.ai.calls'::text, 1::numeric, 'call'::text, '17a00000-0000-4000-8000-00000000000a'::uuid,
            'ecommerce.ai.content'::text, 'PENDING'::text, 0)$$,
  'evento ecommerce.ai.calls atribuido al tenant de MasterAdmin');
select is((select internal from platform_usage.usage_outbox where event_id = (select event_id from t_ev where label = 'ok')),
          '{"provider": "anthropic", "model": "claude-sonnet-5", "inputTokens": 120, "outputTokens": 45, "latencyMs": 850}'::jsonb,
          'internal: solo lo devuelto, el 0 se omite');
select is((select internal from platform_usage.usage_outbox where event_id = (select event_id from t_ev where label = 'fail')),
          '{}'::jsonb, 'fallo: se mide, sin tokens ni modelo inventados');
select results_eq(
  $$select status, control_plane_tenant_id, last_error_code
      from platform_usage.usage_outbox where event_id = (select event_id from t_ev where label = 'legacy')$$,
  $$values ('PENDING'::text, null::uuid, 'TENANT_NOT_MAPPED'::text)$$,
  'sin mapping: PENDING con TENANT_NOT_MAPPED');

savepoint sp_rollback;
select ebim.ai_record_for('17a00000-0000-4000-8000-0000000000a0', '17a00000-0000-4000-8000-0000000000c0',
                          'content', 'ai', 'claude-sonnet-5', 'p', 'r', 1, 1, 0, 1, null);
rollback to savepoint sp_rollback;
select is((select count(*)::int from platform_usage.usage_outbox
            where organization_id = '17a00000-0000-4000-8000-0000000000a0'), 2,
          'traza deshecha → evento deshecho');

-- ── 4 · Inmutabilidad ───────────────────────────────────────────────────────
select throws_ok($$update platform_usage.usage_outbox set quantity = 2
                   where event_id = (select event_id from t_ev where label = 'ok')$$,
                 '42501', null, 'quantity inmutable');
select throws_ok($$update platform_usage.usage_outbox set control_plane_tenant_id = gen_random_uuid()
                   where event_id = (select event_id from t_ev where label = 'legacy')$$,
                 '42501', null, 'tenant inmutable');
select throws_ok($$delete from platform_usage.usage_outbox where event_id = (select event_id from t_ev where label = 'ok')$$,
                 '42501', null, 'DELETE rechazado');
select throws_ok($$truncate platform_usage.usage_outbox$$, '42501', null, 'TRUNCATE rechazado');
select throws_ok($$insert into platform_usage.usage_outbox (occurred_at, meter_code, quantity, unit, organization_id, company_id)
                   values (now(), 'ecommerce.ai.calls', -1, 'call', gen_random_uuid(), gen_random_uuid())$$,
                 '23514', null, 'cantidad negativa rechazada');

-- ── 5 · Grants efectivos ────────────────────────────────────────────────────
set local role authenticated;
select throws_ok($$select * from platform_usage.usage_outbox$$, '42501', null, 'authenticated no lee el outbox');
select throws_ok($$select public.platform_usage_outbox_claim(10, 60)$$, '42501', null, 'authenticated no reclama');
reset role;

-- ── 6 · Reclamo, lease y marcas (como la Edge Function: service_role) ──────
create temp table t_claim (e jsonb) on commit drop;
grant all on t_claim to service_role;

set local role service_role;
insert into t_claim select e from jsonb_array_elements(public.platform_usage_outbox_claim(500, 60)) e;
reset role;
select is((select count(*)::int from t_claim), 2, 'reclama solo lo mapeado (2 de 3)');
select ok((select bool_and((e ->> 'control_plane_tenant_id') is not null) from t_claim), 'nada sin tenant');

set local role service_role;
select is(jsonb_array_length(public.platform_usage_outbox_claim(500, 60)), 0, 'el lease impide el segundo reclamo');
select is(public.platform_usage_outbox_mark(jsonb_build_array(
            jsonb_build_object('eventId', (select event_id from t_ev where label = 'ok'), 'outcome', 'SENT'),
            jsonb_build_object('eventId', (select event_id from t_ev where label = 'fail'),
                               'outcome', 'RETRY', 'code', 'USAGE_INGEST_DISABLED'))),
          '{"sent": 1, "dead": 0, "retry": 1, "ignored": 0}'::jsonb, 'SENT y RETRY aplicados');
select is(public.platform_usage_outbox_mark(jsonb_build_array(
            jsonb_build_object('eventId', (select event_id from t_ev where label = 'legacy'), 'outcome', 'SENT'))),
          '{"sent": 0, "dead": 0, "retry": 0, "ignored": 1}'::jsonb, 'sin tenant nunca se marca enviado');
select throws_ok($$select public.platform_usage_outbox_mark('[{"eventId": "x", "outcome": "BORRAR"}]'::jsonb)$$,
                 '22023', null, 'marca malformada rechazada');
reset role;

select results_eq(
  $$select status, attempts, last_error_code, round(extract(epoch from (next_attempt_at - now())))::int
      from platform_usage.usage_outbox where event_id = (select event_id from t_ev where label = 'fail')$$,
  $$values ('PENDING'::text, 1, 'USAGE_INGEST_DISABLED'::text, 30)$$,
  'RETRY: attempts 1, backoff 30 s');

set local role service_role;
select is(public.platform_usage_outbox_mark(jsonb_build_array(jsonb_build_object(
            'eventId', (select event_id from t_ev where label = 'fail'),
            'outcome', 'RETRY', 'code', 'HTTP_502'))) ->> 'retry', '1', 'segundo RETRY');
reset role;
select is((select round(extract(epoch from (next_attempt_at - now())))::int
             from platform_usage.usage_outbox where event_id = (select event_id from t_ev where label = 'fail')),
          60, 'backoff 60 s en el intento 2');

set local role service_role;
select is(public.platform_usage_outbox_mark(jsonb_build_array(jsonb_build_object(
            'eventId', (select event_id from t_ev where label = 'fail'),
            'outcome', 'DEAD', 'code', 'UNKNOWN_METER'))) ->> 'dead', '1', 'DEAD con código');
reset role;
select throws_ok($$update platform_usage.usage_outbox set status = 'PENDING'
                   where event_id = (select event_id from t_ev where label = 'fail')$$,
                 '42501', null, 'DEAD es terminal');

select * from finish();
rollback;
