-- =============================================================================
-- CCP fase 09 · Receptor de snapshots de entitlements de EBIM MasterAdmin
-- (contrato `ebim.entitlements/v1`, FIX-ENT-v1)
--
-- MasterAdmin es la fuente CANÓNICA de lo que un tenant tiene contratado. Emite
-- un snapshot COMPLETO, versionado y con checksum; la Edge Function
-- `platform-provisioning` (rutas nuevas `PUT|GET /tenants/{id}/entitlements`)
-- verifica el JWT M2M, la forma, el entorno y el checksum, y recién entonces
-- llama a estas RPC con service_role.
--
--   platform_entitlements.applied            último snapshot aplicado (last-good durable)
--   platform_entitlements.apply_audit        bitácora append-only de cada aplicación
--   platform_entitlements.jti_replay         `jti` de un solo uso (TTL)
--   platform_entitlements.enforcement_mode   LEGACY/SHADOW/DUAL_READ/PRIMARY (producto y tenant)
--   platform_entitlements.mode_events        bitácora append-only de cambios de modo
--   platform_entitlements.shadow_diffs       decisión legada vs snapshot (SHADOW)
--   platform_entitlements.legacy_write_alerts escrituras del camino legado en DUAL_READ
--   platform_entitlements.legacy_backup      estado legado previo a materializar (rollback)
--   platform_entitlements.metered_codes      códigos LIMIT/ALLOWANCE que este receptor entiende
--   platform_entitlements.known_codes        (vista) manifiesto del receptor
--
-- ## Cómo decide eCommerce (y qué NO cambia)
--
-- El gate de servidor sigue siendo UNO: `ebim.company_is_entitled` /
-- `has_capability` / `assert_capability`, las policies y `ai_consume_for`, que
-- leen la caché local (`tenant_platform_context`, `tenant_entitlements`,
-- `ai_quotas`). Este archivo NO los reescribe. Lo que hace es decidir QUIÉN
-- escribe esa caché según el modo del tenant:
--
--   LEGACY / SHADOW  la escribe el camino legado (hub, clave de aprovisionamiento)
--                    exactamente como hoy. SHADOW guarda el snapshot y registra
--                    en `shadow_diffs` dónde la decisión legada y la del snapshot
--                    difieren. Ningún tenant cambia de comportamiento.
--   DUAL_READ        decide el snapshot (se MATERIALIZA con `source =
--                    'masteradmin'` vía `sync_platform_context`). Si el tenant
--                    aún no recibió ninguno, cae a legado y alerta. Una escritura
--                    legada se acepta, NO pisa el snapshot y queda en
--                    `legacy_write_alerts`.
--   PRIMARY          solo el snapshot. El camino legado queda BLOQUEADO en
--                    servidor (H-ECO-1: la clave estática de `platform-context`
--                    ya no puede conceder nada). Sin snapshot: solo baseline.
--
-- Materializar reutiliza `sync_platform_context`, así que se conserva todo lo
-- que esa puerta ya hacía (reemplazo atómico del conjunto, apagado del efecto de
-- la marca blanca) y `legacy_until_synced` queda resuelto en cuanto existe la
-- fila de contexto. Los kill switches locales (`tenant_feature_flags`) siguen en
-- `company_is_entitled`: solo restan, nunca conceden.
--
-- IA: la capacidad llega como cualquier otra (`ecommerce.ai.*`); la cuota sale
-- de la asignación `ecommerce.ai.credits` (medidor `ai.credits`) → `ai_quotas`
-- (`active`, mensual). Sin asignación: en PRIMARY cuota 0 (ausente nunca es
-- ilimitado); en DUAL_READ se conserva la cuota legada (valor comercial no
-- decidido, D-03). El hard gate `ai_consume_for` no cambia. Hasta que existan
-- pesos (fase 17) una acción consume un crédito.
--
-- Offline: el enforcement NUNCA llama a MasterAdmin. Lo aplicado no caduca.
--
-- Seguridad: esquema no expuesto por PostgREST, sin USAGE para anon ni
-- authenticated; tablas con RLS forzada y sin GRANT a nadie; RPC SECURITY
-- DEFINER con search_path vacío, EXECUTE solo para service_role. Nada de precios
-- entra aquí: el snapshot no los trae y el receptor no los guarda aparte.
-- =============================================================================

create schema if not exists platform_entitlements;
revoke all on schema platform_entitlements from public, anon, authenticated;
-- `sync_platform_context` (SECURITY INVOKER, la ejecuta service_role) consulta
-- aquí la política de escritura legada. Solo esa función se le concede.
grant usage on schema platform_entitlements to service_role;

comment on schema platform_entitlements is
  'Receptor de snapshots de entitlements de EBIM MasterAdmin (ebim.entitlements/v1). Privado: no lo expone PostgREST.';

-- ---------------------------------------------------------------------------
-- 1 · Manifiesto del receptor
-- ---------------------------------------------------------------------------
create table if not exists platform_entitlements.metered_codes (
  code       text primary key,
  kind       text not null,
  meter_code text,
  unit       text,
  constraint pe_metered_code_fmt check (code ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  constraint pe_metered_kind_ck check (kind in ('LIMIT', 'ALLOWANCE')),
  constraint pe_metered_meter_ck check (kind <> 'ALLOWANCE' or meter_code is not null)
);

insert into platform_entitlements.metered_codes (code, kind, meter_code, unit)
values ('ecommerce.ai.credits', 'ALLOWANCE', 'ai.credits', 'credit')
on conflict (code) do nothing;

-- Capacidades vendibles: los `entitlement_code` que eCommerce ya esperaba del
-- hub, 1:1 (ya son canónicos). Vista y no copia: una capacidad nueva en
-- `app_capabilities` entra sola en el manifiesto del receptor.
create or replace view platform_entitlements.known_codes
with (security_invoker = true) as
  select cap.entitlement_code as code,
         case when cap.boundary = 'ai' then 'AI_FEATURE' else 'FEATURE' end as kind,
         cap.code as capability_code,
         null::text as meter_code
    from public.app_capabilities cap
   where not cap.is_baseline
     and cap.entitlement_code ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'
  union all
  select m.code, m.kind, null::text, m.meter_code
    from platform_entitlements.metered_codes m;

-- ---------------------------------------------------------------------------
-- 2 · Estado aplicado, auditoría, jti, modos
-- ---------------------------------------------------------------------------
create table if not exists platform_entitlements.applied (
  control_plane_tenant_id     uuid primary key,
  organization_id             uuid not null,
  company_id                  uuid not null,
  snapshot                    jsonb not null,
  snapshot_version            integer not null,
  checksum                    text not null,
  status                      text not null,
  unknown_capabilities        text[] not null default '{}',
  -- Concesiones con lista explícita de compañías de MasterAdmin: el receptor no
  -- puede traducir esos ids, así que NO se conceden (fail-closed).
  unmapped_scope_capabilities text[] not null default '{}',
  app_active                  boolean not null,
  applied_at                  timestamptz not null default now(),
  materialized_version        integer,
  materialized_at             timestamptz,
  constraint pe_applied_version_ck check (snapshot_version >= 1),
  constraint pe_applied_checksum_ck check (checksum ~ '^sha256:[0-9a-f]{64}$'),
  constraint pe_applied_status_ck check (status in ('APPLIED', 'APPLIED_WITH_WARNINGS'))
);

create table if not exists platform_entitlements.apply_audit (
  id                      bigint generated always as identity primary key,
  control_plane_tenant_id uuid,
  snapshot_version        integer,
  checksum                text,
  outcome                 text not null,
  enforcement_mode        text,
  correlation_id          uuid,
  idempotency_key         text,
  m2m_subject             text,
  m2m_jti                 text,
  actor_id                text,
  actor_role              text,
  detail                  jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  constraint pe_audit_outcome_ck check (outcome in (
    'APPLIED', 'APPLIED_WITH_WARNINGS', 'REPLAYED', 'STALE_SNAPSHOT', 'VERSION_CONFLICT',
    'TENANT_NOT_PROVISIONED', 'SNAPSHOT_INVALID', 'MATERIALIZED', 'LEGACY_RESTORED', 'DRIFT_REPAIRED'))
);

create index if not exists pe_audit_tenant_idx
  on platform_entitlements.apply_audit (control_plane_tenant_id, id);

create table if not exists platform_entitlements.jti_replay (
  issuer     text not null,
  jti        text not null,
  expires_at timestamptz not null,
  used_at    timestamptz not null default now(),
  primary key (issuer, jti)
);

create index if not exists pe_jti_expires_idx on platform_entitlements.jti_replay (expires_at);

create table if not exists platform_entitlements.enforcement_mode (
  -- 'PRODUCT' = valor por defecto del producto; si no, el controlPlaneTenantId.
  scope_key  text primary key,
  mode       text not null,
  updated_at timestamptz not null default now(),
  constraint pe_mode_ck check (mode in ('LEGACY', 'SHADOW', 'DUAL_READ', 'PRIMARY')),
  constraint pe_mode_scope_ck check (
    scope_key = 'PRODUCT'
    or scope_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

-- Estado al cerrar la fase 09: SHADOW. Recibe y compara; no decide.
insert into platform_entitlements.enforcement_mode (scope_key, mode)
values ('PRODUCT', 'SHADOW')
on conflict (scope_key) do nothing;

create table if not exists platform_entitlements.mode_events (
  id         bigint generated always as identity primary key,
  scope_key  text not null,
  from_mode  text not null,
  to_mode    text not null,
  reason     text,
  tenants    integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists platform_entitlements.shadow_diffs (
  id                      bigint generated always as identity primary key,
  control_plane_tenant_id uuid not null,
  snapshot_version        integer not null,
  capability_code         text not null,
  legacy_decision         boolean not null,
  snapshot_decision       boolean not null,
  observed_at             timestamptz not null default now()
);

create index if not exists pe_shadow_tenant_idx
  on platform_entitlements.shadow_diffs (control_plane_tenant_id, observed_at desc);

create table if not exists platform_entitlements.legacy_write_alerts (
  id              bigint generated always as identity primary key,
  organization_id uuid not null,
  company_id      uuid not null,
  source          text not null,
  mode            text not null,
  action          text not null,
  entitlements    text[] not null default '{}',
  created_at      timestamptz not null default now(),
  constraint pe_alert_action_ck check (action in ('IGNORED', 'FALLBACK'))
);

create table if not exists platform_entitlements.legacy_backup (
  organization_id uuid not null,
  company_id      uuid not null,
  context         jsonb,
  entitlements    jsonb not null default '[]'::jsonb,
  ai_quota        jsonb,
  saved_at        timestamptz not null default now(),
  primary key (organization_id, company_id)
);

do $$
declare
  t text;
begin
  foreach t in array array['metered_codes', 'applied', 'apply_audit', 'jti_replay', 'enforcement_mode',
                           'mode_events', 'shadow_diffs', 'legacy_write_alerts', 'legacy_backup'] loop
    execute format('alter table platform_entitlements.%I enable row level security', t);
    execute format('alter table platform_entitlements.%I force row level security', t);
    execute format('revoke all on platform_entitlements.%I from public, anon, authenticated, service_role', t);
  end loop;
end
$$;

revoke all on platform_entitlements.known_codes from public, anon, authenticated, service_role;
revoke all on all sequences in schema platform_entitlements from public, anon, authenticated, service_role;

-- Append-only: la auditoría y los cambios de modo no se reescriben.
create or replace function platform_entitlements.append_only()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'AUDITORIA_INMUTABLE: platform_entitlements.% es append-only', tg_table_name
    using errcode = '42501';
end;
$fn$;

drop trigger if exists pe_audit_no_update on platform_entitlements.apply_audit;
create trigger pe_audit_no_update
  before update or delete on platform_entitlements.apply_audit
  for each row execute function platform_entitlements.append_only();
drop trigger if exists pe_audit_no_truncate on platform_entitlements.apply_audit;
create trigger pe_audit_no_truncate
  before truncate on platform_entitlements.apply_audit
  for each statement execute function platform_entitlements.append_only();

drop trigger if exists pe_mode_events_no_update on platform_entitlements.mode_events;
create trigger pe_mode_events_no_update
  before update or delete on platform_entitlements.mode_events
  for each row execute function platform_entitlements.append_only();
drop trigger if exists pe_mode_events_no_truncate on platform_entitlements.mode_events;
create trigger pe_mode_events_no_truncate
  before truncate on platform_entitlements.mode_events
  for each statement execute function platform_entitlements.append_only();

-- ---------------------------------------------------------------------------
-- 3 · Funciones internas (sin EXECUTE para nadie: las llaman las RPC DEFINER)
-- ---------------------------------------------------------------------------

create or replace function platform_entitlements.iso(p_ts timestamptz)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$fn$;

/** Mapping del alta M2M: controlPlaneTenantId → (organización, sociedad). */
create or replace function platform_entitlements.tenant_of(p_cpt uuid, out organization_id uuid, out company_id uuid)
language sql
stable
security definer
set search_path = ''
as $fn$
  select r.tenant_organization_id, r.tenant_company_id
    from platform_provisioning.requests r
   where r.control_plane_tenant_id = p_cpt and r.status = 'ACTIVE';
$fn$;

create or replace function platform_entitlements.cpt_of(p_org uuid, p_company uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select r.control_plane_tenant_id
    from platform_provisioning.requests r
   where r.tenant_organization_id = p_org and r.tenant_company_id = p_company and r.status = 'ACTIVE';
$fn$;

create or replace function platform_entitlements.mode_for(p_cpt uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (select m.mode from platform_entitlements.enforcement_mode m where m.scope_key = p_cpt::text),
    (select m.mode from platform_entitlements.enforcement_mode m where m.scope_key = 'PRODUCT'),
    'SHADOW');
$fn$;

/** Capacidades vendibles que el snapshot CONCEDE y este receptor puede conceder. */
create or replace function platform_entitlements.expected_codes(p_snapshot jsonb)
returns text[]
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(array_agg(distinct c ->> 'code' order by c ->> 'code'), '{}'::text[])
    from jsonb_array_elements(coalesce(p_snapshot -> 'capabilities', '[]'::jsonb)) c
    join platform_entitlements.known_codes k
      on k.code = c ->> 'code' and k.kind in ('FEATURE', 'AI_FEATURE')
   where (c ->> 'enabled')::boolean
     and not coalesce(c -> 'scope' ? 'companyIds', false);
$fn$;

create or replace function platform_entitlements.unmapped_codes(p_snapshot jsonb)
returns text[]
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(array_agg(distinct c ->> 'code' order by c ->> 'code'), '{}'::text[])
    from jsonb_array_elements(coalesce(p_snapshot -> 'capabilities', '[]'::jsonb)) c
    join platform_entitlements.known_codes k
      on k.code = c ->> 'code' and k.kind in ('FEATURE', 'AI_FEATURE')
   where (c ->> 'enabled')::boolean
     and coalesce(c -> 'scope' ? 'companyIds', false);
$fn$;

create or replace function platform_entitlements.unknown_codes(p_snapshot jsonb)
returns text[]
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(array_agg(distinct x.code order by x.code), '{}'::text[])
    from (
      select e ->> 'code' as code
        from jsonb_array_elements(
               coalesce(p_snapshot -> 'capabilities', '[]'::jsonb)
               || coalesce(p_snapshot -> 'limits', '[]'::jsonb)
               || coalesce(p_snapshot -> 'allowances', '[]'::jsonb)) e
    ) x
   where x.code is not null
     and not exists (select 1 from platform_entitlements.known_codes k where k.code = x.code);
$fn$;

/**
 * Cuota IA que manda el snapshot. NULL = no hay asignación y el modo permite
 * conservar la cuota legada (DUAL_READ). En PRIMARY, sin asignación → 0.
 */
create or replace function platform_entitlements.expected_ai_quota(p_snapshot jsonb, p_mode text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_included numeric;
begin
  select (a ->> 'included')::numeric into v_included
    from jsonb_array_elements(coalesce(p_snapshot -> 'allowances', '[]'::jsonb)) a
    join platform_entitlements.metered_codes m
      on m.code = a ->> 'code' and m.kind = 'ALLOWANCE' and m.meter_code = 'ai.credits'
   limit 1;
  if v_included is not null then
    return least(greatest(floor(v_included), 0), 1000000)::integer;
  end if;
  return case when p_mode = 'PRIMARY' then 0 else null end;
end;
$fn$;

create or replace function platform_entitlements.audit(
  p_cpt uuid, p_version integer, p_checksum text, p_outcome text, p_mode text,
  p_meta jsonb default '{}'::jsonb, p_idempotency_key text default null, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_meta jsonb := coalesce(p_meta, '{}'::jsonb);
begin
  insert into platform_entitlements.apply_audit (
    control_plane_tenant_id, snapshot_version, checksum, outcome, enforcement_mode,
    correlation_id, idempotency_key, m2m_subject, m2m_jti, actor_id, actor_role, detail)
  values (
    p_cpt, p_version, left(p_checksum, 80), p_outcome, p_mode,
    case when v_meta ->> 'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then (v_meta ->> 'correlationId')::uuid end,
    left(p_idempotency_key, 200),
    left(v_meta ->> 'm2mSubject', 200),
    left(v_meta ->> 'm2mJti', 200),
    left(v_meta ->> 'actorId', 200),
    left(v_meta ->> 'actorRole', 200),
    coalesce(p_detail, '{}'::jsonb));
end;
$fn$;

/** Foto del estado legado ANTES de la primera materialización (rollback sin pérdida). */
create or replace function platform_entitlements.save_legacy(p_org uuid, p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into platform_entitlements.legacy_backup (organization_id, company_id, context, entitlements, ai_quota)
  values (
    p_org, p_company,
    (select jsonb_build_object('app_active', c.app_active, 'plan', c.plan, 'source', c.source, 'synced_at', c.synced_at)
       from public.tenant_platform_context c
      where c.organization_id = p_org and c.company_id = p_company),
    coalesce((select jsonb_agg(jsonb_build_object('code', e.entitlement_code, 'active', e.is_active, 'source', e.source)
                               order by e.entitlement_code)
                from public.tenant_entitlements e
               where e.organization_id = p_org and e.company_id = p_company), '[]'::jsonb),
    (select jsonb_build_object('plan', q.plan, 'trial_quota', q.trial_quota, 'monthly_quota', q.monthly_quota)
       from public.ai_quotas q
      where q.organization_id = p_org and q.company_id = p_company))
  on conflict (organization_id, company_id) do nothing;
end;
$fn$;

create or replace function platform_entitlements.restore_ai_quota(p_org uuid, p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_quota jsonb;
begin
  select b.ai_quota into v_quota
    from platform_entitlements.legacy_backup b
   where b.organization_id = p_org and b.company_id = p_company;
  delete from public.ai_quotas where organization_id = p_org and company_id = p_company;
  if v_quota is not null then
    insert into public.ai_quotas (organization_id, company_id, plan, trial_quota, monthly_quota)
    values (p_org, p_company, v_quota ->> 'plan', (v_quota ->> 'trial_quota')::integer,
            (v_quota ->> 'monthly_quota')::integer);
  end if;
end;
$fn$;

/**
 * Escribe la caché local desde el snapshot aplicado (DUAL_READ/PRIMARY).
 * PRIMARY sin snapshot = solo baseline. DUAL_READ sin snapshot = no toca nada.
 */
create or replace function platform_entitlements.materialize(p_cpt uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org     uuid;
  v_company uuid;
  v_mode    text := platform_entitlements.mode_for(p_cpt);
  v_applied platform_entitlements.applied;
  v_has     boolean;
  v_quota   integer;
  v_plan    text;
begin
  select t.organization_id, t.company_id into v_org, v_company from platform_entitlements.tenant_of(p_cpt) t;
  if v_org is null then
    return;
  end if;

  select * into v_applied from platform_entitlements.applied a where a.control_plane_tenant_id = p_cpt;
  v_has := found;
  if not v_has and v_mode <> 'PRIMARY' then
    return;
  end if;

  perform platform_entitlements.save_legacy(v_org, v_company);

  v_plan := case when v_has then nullif(left(btrim(coalesce(v_applied.snapshot ->> 'planCode', '')), 60), '') end;

  -- `sync_platform_context` solo acepta `masteradmin` con esta marca de
  -- transacción: ningún otro llamador puede hacerse pasar por el receptor.
  perform set_config('ebim.entitlements_apply', 'on', true);
  perform public.sync_platform_context(
    v_org, v_company,
    case when v_has then v_applied.app_active else true end,
    case when v_has then platform_entitlements.expected_codes(v_applied.snapshot) else '{}'::text[] end,
    'masteradmin'::public.entitlement_source,
    v_plan);
  perform set_config('ebim.entitlements_apply', 'off', true);

  v_quota := case when v_has then platform_entitlements.expected_ai_quota(v_applied.snapshot, v_mode) else 0 end;
  if v_quota is not null then
    insert into public.ai_quotas (organization_id, company_id, plan, monthly_quota)
    values (v_org, v_company, 'active', v_quota)
    on conflict (organization_id, company_id)
      do update set plan = 'active', monthly_quota = excluded.monthly_quota;
  else
    perform platform_entitlements.restore_ai_quota(v_org, v_company);
  end if;

  if v_has then
    update platform_entitlements.applied
       set materialized_version = snapshot_version, materialized_at = now()
     where control_plane_tenant_id = p_cpt;
  end if;

  perform platform_entitlements.audit(
    p_cpt, v_applied.snapshot_version, v_applied.checksum, 'MATERIALIZED', v_mode,
    '{}'::jsonb, null, jsonb_build_object('reason', p_reason, 'aiQuota', v_quota));
end;
$fn$;

/** Vuelta al camino legado (DUAL_READ → SHADOW): la caché queda como estaba. */
create or replace function platform_entitlements.restore_legacy(p_cpt uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org     uuid;
  v_company uuid;
  v_backup  platform_entitlements.legacy_backup;
begin
  select t.organization_id, t.company_id into v_org, v_company from platform_entitlements.tenant_of(p_cpt) t;
  if v_org is null then
    return;
  end if;
  select * into v_backup from platform_entitlements.legacy_backup b
   where b.organization_id = v_org and b.company_id = v_company;
  if not found then
    return;
  end if;

  delete from public.tenant_platform_context where organization_id = v_org and company_id = v_company;
  if v_backup.context is not null then
    insert into public.tenant_platform_context (organization_id, company_id, app_active, plan, source, synced_at)
    values (v_org, v_company,
            (v_backup.context ->> 'app_active')::boolean,
            v_backup.context ->> 'plan',
            (v_backup.context ->> 'source')::public.entitlement_source,
            (v_backup.context ->> 'synced_at')::timestamptz);
  end if;

  delete from public.tenant_entitlements e
   where e.organization_id = v_org and e.company_id = v_company
     and not exists (select 1 from jsonb_array_elements(v_backup.entitlements) x
                      where x ->> 'code' = e.entitlement_code);
  insert into public.tenant_entitlements (organization_id, company_id, entitlement_code, is_active, source, synced_at)
  select v_org, v_company, x ->> 'code', (x ->> 'active')::boolean, (x ->> 'source')::public.entitlement_source, now()
    from jsonb_array_elements(v_backup.entitlements) x
  on conflict (organization_id, company_id, entitlement_code)
    do update set is_active = excluded.is_active, source = excluded.source, synced_at = excluded.synced_at;

  perform platform_entitlements.restore_ai_quota(v_org, v_company);
  delete from platform_entitlements.legacy_backup where organization_id = v_org and company_id = v_company;

  update platform_entitlements.applied
     set materialized_version = null, materialized_at = null
   where control_plane_tenant_id = p_cpt;

  perform platform_entitlements.audit(p_cpt, null, null, 'LEGACY_RESTORED', platform_entitlements.mode_for(p_cpt));
end;
$fn$;

/** SHADOW: dónde difieren la decisión legada y la del snapshot. Devuelve cuántas. */
create or replace function platform_entitlements.record_shadow_diffs(p_cpt uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org     uuid;
  v_company uuid;
  v_applied platform_entitlements.applied;
  v_codes   text[];
  v_count   integer;
begin
  select t.organization_id, t.company_id into v_org, v_company from platform_entitlements.tenant_of(p_cpt) t;
  select * into v_applied from platform_entitlements.applied a where a.control_plane_tenant_id = p_cpt;
  if v_org is null or not found then
    return 0;
  end if;
  v_codes := platform_entitlements.expected_codes(v_applied.snapshot);

  -- Se comparan decisiones EFECTIVAS (con kill switch local en los dos lados).
  -- `company_is_entitled` corre aquí como dueño (contexto de servidor): el
  -- fallback legado de sociedades nunca sincronizadas es observable.
  insert into platform_entitlements.shadow_diffs
    (control_plane_tenant_id, snapshot_version, capability_code, legacy_decision, snapshot_decision)
  select p_cpt, v_applied.snapshot_version, d.code, d.legacy, d.snap
    from (
      select k.code,
             ebim.company_is_entitled(v_org, v_company, k.capability_code) as legacy,
             (v_applied.app_active
              and k.code = any (v_codes)
              and coalesce((select f.is_enabled from public.tenant_feature_flags f
                             where f.organization_id = v_org and f.company_id = v_company
                               and f.flag_key = k.capability_code), true)) as snap
        from platform_entitlements.known_codes k
       where k.kind in ('FEATURE', 'AI_FEATURE')
    ) d
   where d.legacy is distinct from d.snap;
  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

/**
 * Política del camino legado (hub / clave de aprovisionamiento) según el modo.
 * La consulta `sync_platform_context` antes de escribir. 'ALLOW' | 'IGNORE';
 * en PRIMARY no devuelve: bloquea.
 */
create or replace function platform_entitlements.legacy_write_policy(
  p_org uuid, p_company uuid, p_source text, p_codes text[])
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_cpt  uuid;
  v_mode text;
begin
  if p_source = 'masteradmin' then
    if coalesce(current_setting('ebim.entitlements_apply', true), '') <> 'on' then
      raise exception 'FUENTE_RESERVADA: solo el receptor de MasterAdmin escribe con origen masteradmin'
        using errcode = '42501';
    end if;
    return 'ALLOW';
  end if;

  v_cpt := platform_entitlements.cpt_of(p_org, p_company);
  if v_cpt is null then
    return 'ALLOW'; -- sociedad fuera del plano de control: nada cambia
  end if;
  v_mode := platform_entitlements.mode_for(v_cpt);

  if v_mode = 'PRIMARY' then
    raise exception 'FUENTE_LEGADA_BLOQUEADA: los entitlements de esta sociedad los gobierna EBIM MasterAdmin'
      using errcode = '42501';
  end if;

  if v_mode = 'DUAL_READ' then
    if exists (select 1 from platform_entitlements.applied a where a.control_plane_tenant_id = v_cpt) then
      insert into platform_entitlements.legacy_write_alerts (organization_id, company_id, source, mode, action, entitlements)
      values (p_org, p_company, p_source, v_mode, 'IGNORED', coalesce(p_codes, '{}'::text[]));
      return 'IGNORE';
    end if;
    insert into platform_entitlements.legacy_write_alerts (organization_id, company_id, source, mode, action, entitlements)
    values (p_org, p_company, p_source, v_mode, 'FALLBACK', coalesce(p_codes, '{}'::text[]));
  end if;

  return 'ALLOW';
end;
$fn$;

revoke all on all functions in schema platform_entitlements from public, anon, authenticated, service_role;
grant execute on function platform_entitlements.legacy_write_policy(uuid, uuid, text, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4 · sync_platform_context — MISMA puerta, con la política de origen delante
--
-- Cuerpo idéntico al de 20260827160000 salvo el bloque marcado. La firma no
-- cambia (el borde `platform-context` la llama igual).
-- ---------------------------------------------------------------------------
create or replace function public.sync_platform_context(
  p_organization_id uuid,
  p_company_id uuid,
  p_app_active boolean,
  p_entitlements text[],
  p_source public.entitlement_source,
  p_plan text default null
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  v_codes text[] := coalesce(p_entitlements, '{}'::text[]);
  v_code  text;
begin
  if p_organization_id is null or p_company_id is null then
    raise exception 'EBIM_TENANT_REQUERIDO: falta organizacion o sociedad';
  end if;

  foreach v_code in array v_codes loop
    if v_code !~ '^[a-z][a-z0-9._-]{2,60}$' then
      raise exception 'ENTITLEMENT_INVALIDO: el codigo % no tiene forma de addon', v_code;
    end if;
  end loop;

  -- ── CCP fase 09: quién puede escribir la caché según el modo del tenant ──
  if platform_entitlements.legacy_write_policy(p_organization_id, p_company_id, p_source::text, v_codes) = 'IGNORE' then
    return jsonb_build_object(
      'organization_id', p_organization_id,
      'company_id',      p_company_id,
      'source',          p_source,
      'ignored',         true,
      'reason',          'SNAPSHOT_GOVERNS'
    );
  end if;
  -- ─────────────────────────────────────────────────────────────────────────

  insert into public.tenant_platform_context
    (organization_id, company_id, app_active, plan, source, synced_at)
  values
    (p_organization_id, p_company_id, coalesce(p_app_active, true), p_plan, p_source, now())
  on conflict (organization_id, company_id) do update
    set app_active = excluded.app_active,
        plan       = excluded.plan,
        source     = excluded.source,
        synced_at  = excluded.synced_at;

  insert into public.tenant_entitlements
    (organization_id, company_id, entitlement_code, is_active, source, synced_at)
  select p_organization_id, p_company_id, code, true, p_source, now()
    from unnest(v_codes) as code
  on conflict (organization_id, company_id, entitlement_code) do update
    set is_active = true,
        source    = excluded.source,
        synced_at = excluded.synced_at;

  update public.tenant_entitlements
     set is_active = false, synced_at = now()
   where organization_id = p_organization_id
     and company_id      = p_company_id
     and is_active
     and not (entitlement_code = any (v_codes));

  if not ebim.company_is_entitled(p_organization_id, p_company_id, 'content.white_label') then
    update public.store_settings
       set white_label = false
     where organization_id = p_organization_id
       and company_id      = p_company_id
       and white_label;
  end if;

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'company_id',      p_company_id,
    'app_active',      coalesce(p_app_active, true),
    'entitlements',    to_jsonb(v_codes),
    'source',          p_source
  );
end;
$fn$;

revoke execute on function
  public.sync_platform_context(uuid, uuid, boolean, text[], public.entitlement_source, text)
from public, anon, authenticated;
grant execute on function
  public.sync_platform_context(uuid, uuid, boolean, text[], public.entitlement_source, text)
to service_role;

-- ---------------------------------------------------------------------------
-- 5 · RPC del receptor (service_role)
-- ---------------------------------------------------------------------------

/**
 * PUT /tenants/{id}/entitlements, pasos 3–7 del contrato, en UNA transacción.
 * La Edge Function ya verificó JWT, jti, forma, tamaño, entorno y checksum.
 * Devuelve `{httpStatus, body}`; el cuerpo nunca incluye el snapshot.
 */
create or replace function public.platform_apply_entitlements(
  p_control_plane_tenant_id uuid,
  p_snapshot jsonb,
  p_meta jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_cpt      uuid := p_control_plane_tenant_id;
  v_version  integer;
  v_checksum text;
  v_idem     text;
  v_org      uuid;
  v_company  uuid;
  v_current  platform_entitlements.applied;
  v_unknown  text[];
  v_unmapped text[];
  v_status   text;
  v_mode     text;
  v_diffs    integer := 0;
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object'
     or jsonb_typeof(p_snapshot -> 'snapshotVersion') is distinct from 'number'
     or coalesce(p_snapshot ->> 'checksum', '') !~ '^sha256:[0-9a-f]{64}$'
     or v_cpt is null
     or p_snapshot ->> 'controlPlaneTenantId' is distinct from v_cpt::text
     or jsonb_typeof(p_snapshot -> 'appActive') is distinct from 'boolean' then
    return jsonb_build_object('httpStatus', 422, 'body',
      jsonb_build_object('error', 'SNAPSHOT_INVALID', 'message', 'Snapshot inválido o de otro tenant'));
  end if;
  v_version  := (p_snapshot ->> 'snapshotVersion')::integer;
  v_checksum := p_snapshot ->> 'checksum';
  v_idem     := p_snapshot ->> 'idempotencyKey';
  if v_version < 1 then
    return jsonb_build_object('httpStatus', 422, 'body',
      jsonb_build_object('error', 'SNAPSHOT_INVALID', 'message', 'snapshotVersion debe ser >= 1'));
  end if;

  select t.organization_id, t.company_id into v_org, v_company from platform_entitlements.tenant_of(v_cpt) t;
  if v_org is null then
    perform platform_entitlements.audit(v_cpt, v_version, v_checksum, 'TENANT_NOT_PROVISIONED', null, p_meta, v_idem);
    return jsonb_build_object('httpStatus', 404, 'body',
      jsonb_build_object('error', 'TENANT_NOT_PROVISIONED', 'message', 'Tenant sin provisioning local'));
  end if;

  -- Serializa las aplicaciones del mismo tenant (dos PUT concurrentes).
  perform pg_advisory_xact_lock(hashtextextended('ebim.entitlements:' || v_cpt::text, 0));
  v_mode := platform_entitlements.mode_for(v_cpt);

  select * into v_current from platform_entitlements.applied a
   where a.control_plane_tenant_id = v_cpt for update;

  if found then
    if v_version < v_current.snapshot_version then
      perform platform_entitlements.audit(v_cpt, v_version, v_checksum, 'STALE_SNAPSHOT', v_mode, p_meta, v_idem,
        jsonb_build_object('appliedVersion', v_current.snapshot_version));
      return jsonb_build_object('httpStatus', 409, 'body', jsonb_build_object(
        'error', 'STALE_SNAPSHOT', 'message', 'Versión anterior a la aplicada',
        'appliedVersion', v_current.snapshot_version));
    end if;
    if v_version = v_current.snapshot_version then
      if v_checksum <> v_current.checksum then
        perform platform_entitlements.audit(v_cpt, v_version, v_checksum, 'VERSION_CONFLICT', v_mode, p_meta, v_idem,
          jsonb_build_object('appliedChecksum', v_current.checksum));
        return jsonb_build_object('httpStatus', 409, 'body', jsonb_build_object(
          'error', 'VERSION_CONFLICT', 'message', 'Misma versión con otro contenido',
          'appliedVersion', v_current.snapshot_version));
      end if;
      perform platform_entitlements.audit(v_cpt, v_version, v_checksum, 'REPLAYED', v_mode, p_meta, v_idem);
      return jsonb_build_object('httpStatus', 200, 'body', jsonb_build_object(
        'appliedVersion',      v_current.snapshot_version,
        'appliedChecksum',     v_current.checksum,
        'appliedAt',           platform_entitlements.iso(v_current.applied_at),
        'status',              v_current.status,
        'unknownCapabilities', to_jsonb(v_current.unknown_capabilities),
        'replayed',            true));
    end if;
  end if;

  v_unknown  := platform_entitlements.unknown_codes(p_snapshot);
  v_unmapped := platform_entitlements.unmapped_codes(p_snapshot);
  v_status   := case when cardinality(v_unknown) > 0 then 'APPLIED_WITH_WARNINGS' else 'APPLIED' end;

  insert into platform_entitlements.applied as a (
    control_plane_tenant_id, organization_id, company_id, snapshot, snapshot_version, checksum, status,
    unknown_capabilities, unmapped_scope_capabilities, app_active, applied_at, materialized_version, materialized_at)
  values (
    v_cpt, v_org, v_company, p_snapshot, v_version, v_checksum, v_status,
    v_unknown, v_unmapped, (p_snapshot ->> 'appActive')::boolean, now(), null, null)
  on conflict (control_plane_tenant_id) do update
    set organization_id             = excluded.organization_id,
        company_id                  = excluded.company_id,
        snapshot                    = excluded.snapshot,
        snapshot_version            = excluded.snapshot_version,
        checksum                    = excluded.checksum,
        status                      = excluded.status,
        unknown_capabilities        = excluded.unknown_capabilities,
        unmapped_scope_capabilities = excluded.unmapped_scope_capabilities,
        app_active                  = excluded.app_active,
        applied_at                  = excluded.applied_at,
        materialized_version        = a.materialized_version,
        materialized_at             = a.materialized_at;

  if v_mode in ('DUAL_READ', 'PRIMARY') then
    perform platform_entitlements.materialize(v_cpt, 'APPLY');
  elsif v_mode = 'SHADOW' then
    v_diffs := platform_entitlements.record_shadow_diffs(v_cpt);
  end if;

  perform platform_entitlements.audit(v_cpt, v_version, v_checksum, v_status, v_mode, p_meta, v_idem,
    jsonb_build_object('unknownCapabilities', to_jsonb(v_unknown),
                       'unmappedScopeCapabilities', to_jsonb(v_unmapped),
                       'shadowDiffs', v_diffs));

  return jsonb_build_object('httpStatus', 200, 'body', jsonb_build_object(
    'appliedVersion',      v_version,
    'appliedChecksum',     v_checksum,
    'appliedAt',           platform_entitlements.iso(now()),
    'status',              v_status,
    'unknownCapabilities', to_jsonb(v_unknown),
    'replayed',            false));
end;
$fn$;

/** GET /tenants/{id}/entitlements. NULL = tenant sin provisioning local. */
create or replace function public.platform_get_entitlements(p_control_plane_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_org     uuid;
  v_company uuid;
  v_applied platform_entitlements.applied;
begin
  select t.organization_id, t.company_id into v_org, v_company
    from platform_entitlements.tenant_of(p_control_plane_tenant_id) t;
  if v_org is null then
    return null;
  end if;
  select * into v_applied from platform_entitlements.applied a
   where a.control_plane_tenant_id = p_control_plane_tenant_id;
  return jsonb_build_object(
    'appliedVersion',      v_applied.snapshot_version,
    'appliedChecksum',     v_applied.checksum,
    'appliedAt',           case when v_applied.applied_at is null then null
                                else platform_entitlements.iso(v_applied.applied_at) end,
    'status',              coalesce(v_applied.status, 'NONE'),
    'unknownCapabilities', to_jsonb(coalesce(v_applied.unknown_capabilities, '{}'::text[])),
    'enforcementMode',     platform_entitlements.mode_for(p_control_plane_tenant_id));
end;
$fn$;

/** `jti` de un solo uso en las rutas de entitlements. `true` = primer uso. */
create or replace function public.platform_entitlements_use_jti(
  p_issuer text,
  p_jti text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_rows integer;
begin
  if coalesce(btrim(p_issuer), '') = '' or coalesce(btrim(p_jti), '') = ''
     or length(p_issuer) > 200 or length(p_jti) > 200 then
    raise exception 'JTI_INVALIDO' using errcode = '22023';
  end if;
  -- Un jti solo sirve mientras su token vive (≤ 300 s): pasado eso se purga.
  delete from platform_entitlements.jti_replay where expires_at < now() - interval '10 minutes';
  insert into platform_entitlements.jti_replay (issuer, jti, expires_at)
  values (p_issuer, p_jti, least(greatest(coalesce(p_expires_at, now()), now()), now() + interval '1 hour'))
  on conflict (issuer, jti) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$fn$;

/**
 * Cambio de modo, UN paso por vez (adelante o atrás), por producto o por
 * tenant. Materializa o restaura en la misma transacción.
 */
create or replace function public.platform_set_entitlement_enforcement_mode(
  p_scope text,
  p_mode text,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_order   text[] := array['LEGACY', 'SHADOW', 'DUAL_READ', 'PRIMARY'];
  v_scope   text := btrim(coalesce(p_scope, ''));
  v_from    text;
  v_cpt     uuid;
  v_before  jsonb := '{}'::jsonb;
  v_tenant  record;
  v_new     text;
  v_old     text;
  v_count   integer := 0;
begin
  if p_mode is null or not (p_mode = any (v_order)) then
    raise exception 'MODO_INVALIDO: %', p_mode using errcode = '22023';
  end if;
  if v_scope <> 'PRODUCT' then
    if v_scope !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'ALCANCE_INVALIDO: PRODUCT o un controlPlaneTenantId' using errcode = '22023';
    end if;
    v_cpt := v_scope::uuid;
    if not exists (select 1 from platform_entitlements.tenant_of(v_cpt) t where t.organization_id is not null) then
      raise exception 'TENANT_NO_APROVISIONADO: %', v_scope using errcode = '22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ebim.entitlements.mode', 0));

  v_from := case when v_cpt is null
                 then coalesce((select m.mode from platform_entitlements.enforcement_mode m where m.scope_key = 'PRODUCT'), 'SHADOW')
                 else platform_entitlements.mode_for(v_cpt) end;
  if v_from = p_mode then
    return jsonb_build_object('scope', v_scope, 'from', v_from, 'to', p_mode, 'changed', false, 'tenants', 0);
  end if;
  if abs(array_position(v_order, v_from) - array_position(v_order, p_mode)) <> 1 then
    raise exception 'UN_PASO: de % a % salta estados; se avanza o retrocede de a uno', v_from, p_mode
      using errcode = '22023';
  end if;

  -- Modo efectivo ANTES del cambio de cada tenant afectado.
  for v_tenant in
    select r.control_plane_tenant_id as cpt
      from platform_provisioning.requests r
     where r.status = 'ACTIVE'
       and (case when v_cpt is null
                 then not exists (select 1 from platform_entitlements.enforcement_mode m
                                   where m.scope_key = r.control_plane_tenant_id::text)
                 else r.control_plane_tenant_id = v_cpt end)
  loop
    v_before := v_before || jsonb_build_object(v_tenant.cpt::text, platform_entitlements.mode_for(v_tenant.cpt));
  end loop;

  insert into platform_entitlements.enforcement_mode (scope_key, mode, updated_at)
  values (v_scope, p_mode, now())
  on conflict (scope_key) do update set mode = excluded.mode, updated_at = excluded.updated_at;

  for v_tenant in select key::uuid as cpt, value as old_mode from jsonb_each_text(v_before) loop
    v_new := platform_entitlements.mode_for(v_tenant.cpt);
    v_old := v_tenant.old_mode;
    if v_new in ('DUAL_READ', 'PRIMARY') then
      perform platform_entitlements.materialize(v_tenant.cpt, 'MODE_CHANGED');
    elsif v_old in ('DUAL_READ', 'PRIMARY') then
      perform platform_entitlements.restore_legacy(v_tenant.cpt);
    end if;
    v_count := v_count + 1;
  end loop;

  insert into platform_entitlements.mode_events (scope_key, from_mode, to_mode, reason, tenants)
  values (v_scope, v_from, p_mode, left(p_reason, 240), v_count);

  return jsonb_build_object('scope', v_scope, 'from', v_from, 'to', p_mode, 'changed', true, 'tenants', v_count);
end;
$fn$;

/**
 * Reconciliación LOCAL desde el último snapshot, sin MasterAdmin.
 * DUAL_READ/PRIMARY: compara la caché con lo que el snapshot manda y, si alguien
 * la tocó por fuera, la repara. SHADOW: recalcula las diferencias.
 */
create or replace function public.platform_reconcile_entitlements(p_control_plane_tenant_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_cpt      uuid := p_control_plane_tenant_id;
  v_org      uuid;
  v_company  uuid;
  v_mode     text;
  v_applied  platform_entitlements.applied;
  v_has      boolean;
  v_expected text[];
  v_actual   text[];
  v_extra    text[];
  v_missing  text[];
  v_app      boolean;
  v_ctx      public.tenant_platform_context;
  v_ctx_ok   boolean;
  v_quota    integer;
  v_q        public.ai_quotas;
  v_q_drift  boolean := false;
  v_diffs    integer;
begin
  select t.organization_id, t.company_id into v_org, v_company from platform_entitlements.tenant_of(v_cpt) t;
  if v_org is null then
    raise exception 'TENANT_NO_APROVISIONADO: %', v_cpt using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ebim.entitlements:' || v_cpt::text, 0));
  v_mode := platform_entitlements.mode_for(v_cpt);

  if v_mode not in ('DUAL_READ', 'PRIMARY') then
    v_diffs := case when v_mode = 'SHADOW' then platform_entitlements.record_shadow_diffs(v_cpt) else 0 end;
    return jsonb_build_object('mode', v_mode, 'drift', v_diffs > 0, 'repaired', false, 'shadowDiffs', v_diffs);
  end if;

  select * into v_applied from platform_entitlements.applied a where a.control_plane_tenant_id = v_cpt;
  v_has := found;
  if not v_has and v_mode = 'DUAL_READ' then
    return jsonb_build_object('mode', v_mode, 'drift', false, 'repaired', false, 'fallback', true);
  end if;

  v_expected := case when v_has then platform_entitlements.expected_codes(v_applied.snapshot) else '{}'::text[] end;
  v_app      := case when v_has then v_applied.app_active else true end;
  v_quota    := case when v_has then platform_entitlements.expected_ai_quota(v_applied.snapshot, v_mode) else 0 end;

  select coalesce(array_agg(e.entitlement_code order by e.entitlement_code), '{}'::text[]) into v_actual
    from public.tenant_entitlements e
   where e.organization_id = v_org and e.company_id = v_company and e.is_active;

  select coalesce(array_agg(x order by x), '{}'::text[]) into v_extra
    from unnest(v_actual) x where not (x = any (v_expected));
  select coalesce(array_agg(x order by x), '{}'::text[]) into v_missing
    from unnest(v_expected) x where not (x = any (v_actual));

  select * into v_ctx from public.tenant_platform_context c
   where c.organization_id = v_org and c.company_id = v_company;
  v_ctx_ok := found and v_ctx.source = 'masteradmin' and v_ctx.app_active = v_app;

  if v_quota is not null then
    select * into v_q from public.ai_quotas q where q.organization_id = v_org and q.company_id = v_company;
    v_q_drift := not found or v_q.plan <> 'active' or v_q.monthly_quota <> v_quota;
  end if;

  if cardinality(v_extra) = 0 and cardinality(v_missing) = 0 and v_ctx_ok and not v_q_drift then
    return jsonb_build_object('mode', v_mode, 'drift', false, 'repaired', false,
      'extra', '[]'::jsonb, 'missing', '[]'::jsonb, 'contextDrift', false, 'aiQuotaDrift', false);
  end if;

  perform platform_entitlements.materialize(v_cpt, 'DRIFT_REPAIRED');
  perform platform_entitlements.audit(v_cpt, v_applied.snapshot_version, v_applied.checksum, 'DRIFT_REPAIRED', v_mode,
    '{}'::jsonb, null, jsonb_build_object('extra', to_jsonb(v_extra), 'missing', to_jsonb(v_missing),
                                          'contextDrift', not v_ctx_ok, 'aiQuotaDrift', v_q_drift));
  return jsonb_build_object('mode', v_mode, 'drift', true, 'repaired', true,
    'extra', to_jsonb(v_extra), 'missing', to_jsonb(v_missing),
    'contextDrift', not v_ctx_ok, 'aiQuotaDrift', v_q_drift);
end;
$fn$;

revoke all on function public.platform_apply_entitlements(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.platform_get_entitlements(uuid) from public, anon, authenticated;
revoke all on function public.platform_entitlements_use_jti(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.platform_set_entitlement_enforcement_mode(text, text, text) from public, anon, authenticated;
revoke all on function public.platform_reconcile_entitlements(uuid) from public, anon, authenticated;

grant execute on function public.platform_apply_entitlements(uuid, jsonb, jsonb) to service_role;
grant execute on function public.platform_get_entitlements(uuid) to service_role;
grant execute on function public.platform_entitlements_use_jti(text, text, timestamptz) to service_role;
grant execute on function public.platform_set_entitlement_enforcement_mode(text, text, text) to service_role;
grant execute on function public.platform_reconcile_entitlements(uuid) to service_role;

comment on function public.platform_apply_entitlements(uuid, jsonb, jsonb) is
  'Receptor ebim.entitlements/v1 (pasos 3-7). service_role, llamado por platform-provisioning tras verificar JWT/jti/forma/entorno/checksum.';
comment on function public.platform_set_entitlement_enforcement_mode(text, text, text) is
  'Cambio de modo de enforcement de entitlements (LEGACY/SHADOW/DUAL_READ/PRIMARY), un paso por vez, por producto o tenant.';
comment on function public.platform_reconcile_entitlements(uuid) is
  'Reconciliación local desde el último snapshot aplicado, sin llamar a MasterAdmin.';
