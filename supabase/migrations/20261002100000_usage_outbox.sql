-- =============================================================================
-- CCP fase 17 · Outbox de uso hacia EBIM MasterAdmin (contrato `ebim.usage/v1`,
-- FIX-USG-v1, vendorizado en `supabase/tests/fixtures/usage-v1/`).
--
-- Qué mide eCommerce en v1: UNA llamada de IA = UN evento `ecommerce.ai.calls`
-- (unidad `call`, `meters.json`). La capacidad consumida viaja en
-- `capabilityCode` (el `entitlement_code` de fase 09, p. ej.
-- `ecommerce.ai.content`). Las cuotas locales (`ai_quotas`, `ai_consume*`) NO
-- cambian: no hay pesos de crédito aprobados (D-03).
--
-- ## Dónde nace el evento
--
-- Toda traza de IA pasa por `ebim.ai_record_for` (la llaman `ebim.ai_record`
-- por JWT con ticket y `public.ai_record_for_store` por service_role), que
-- inserta UNA fila en `public.ai_interactions` — también cuando la llamada
-- falló (el pipeline registra en su `finally`, `_shared/aiPipeline.ts`). Un
-- trigger AFTER INSERT sobre esa tabla escribe la fila del outbox en la MISMA
-- transacción: si la traza se deshace, el evento también. Es el camino menos
-- invasivo: ni `ai_record*` ni sus tests cambian.
--
-- Una traza existe solo tras consumir una unidad de cuota (ticket o
-- `ai_consume_for_store`), así que 1 traza = 1 llamada cobrada localmente.
--
-- ## Atribución en origen
--
-- `control_plane_tenant_id` sale del mapping de provisioning ACTIVE
-- (`platform_provisioning.requests`). Sin mapping (tenant legado del hub) el
-- evento queda PENDING con `last_error_code = 'TENANT_NOT_MAPPED'` y el reclamo
-- nunca lo entrega: no se inventa tenant.
--
-- `internal` guarda SOLO lo que devolvió el proveedor: modelo, tokens y
-- latencia. Un contador en 0 se OMITE (la traza no distingue «0» de «no vino»,
-- y el contrato prohíbe inventar 0). Nunca prompt, respuesta ni datos.
--
-- ## Por qué `platform_usage` y no `platform_provisioning`
--
-- La suite protegida (INV-1) `platform-provisioning-db.test.ts` y
-- `database/platform_provisioning.test.sql` fijan la lista EXACTA de tablas y
-- grants del esquema `platform_provisioning`. Mismo criterio que la fase 09
-- (`platform_entitlements`).
--
-- Seguridad: esquema no expuesto, sin USAGE para nadie; tabla con RLS forzada
-- y sin GRANT; RPC SECURITY DEFINER con search_path vacío y EXECUTE solo para
-- service_role. El envío lo hace `supabase/functions/usage-outbox-worker`
-- (apagado por defecto). Ningún cron aquí.
-- =============================================================================

create schema if not exists platform_usage;
revoke all on schema platform_usage from public, anon, authenticated, service_role;

comment on schema platform_usage is
  'Outbox de uso ebim.usage/v1 hacia EBIM MasterAdmin. Privado: no lo expone PostgREST.';

-- ---------------------------------------------------------------------------
-- 1 · Outbox
-- ---------------------------------------------------------------------------

/** `internal` es un objeto con SOLO las claves COGS del contrato. */
create or replace function platform_usage.internal_is_valid(p_internal jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select jsonb_typeof(p_internal) = 'object'
     and not exists (
       select 1 from jsonb_object_keys(p_internal) k
        where k not in ('provider', 'model', 'inputTokens', 'outputTokens', 'cacheTokens',
                        'latencyMs', 'costAmount', 'costCurrency'));
$fn$;

create table if not exists platform_usage.usage_outbox (
  -- Generado EN ORIGEN al crear la fila; estable ante reintentos.
  event_id                uuid primary key default gen_random_uuid(),
  -- Traza que lo originó (sin FK: la traza tiene su propia retención).
  source_interaction_id   uuid,
  occurred_at             timestamptz not null,
  meter_code              text not null,
  quantity                numeric not null,
  unit                    text not null,
  control_plane_tenant_id uuid,
  organization_id         uuid not null,
  company_id              uuid not null,
  external_company_id     text,
  capability_code         text,
  internal                jsonb not null default '{}'::jsonb,
  -- Entrega (lo único que cambia).
  status                  text not null default 'PENDING',
  attempts                integer not null default 0,
  next_attempt_at         timestamptz not null default now(),
  sent_at                 timestamptz,
  last_error_code         text,
  created_at              timestamptz not null default now(),

  constraint usage_outbox_source_key unique (source_interaction_id),
  constraint usage_outbox_quantity_ck check (quantity >= 0 and quantity < 1e14),
  constraint usage_outbox_meter_ck check (meter_code ~ '^[a-z0-9]+([._][a-z0-9]+)*$'),
  constraint usage_outbox_unit_ck check (unit ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  constraint usage_outbox_capability_ck
    check (capability_code is null or capability_code ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  constraint usage_outbox_company_ck
    check (external_company_id is null or char_length(external_company_id) between 1 and 200),
  constraint usage_outbox_internal_ck check (platform_usage.internal_is_valid(internal)),
  constraint usage_outbox_status_ck check (status in ('PENDING', 'SENT', 'DEAD')),
  constraint usage_outbox_attempts_ck check (attempts >= 0),
  constraint usage_outbox_sent_ck check ((status = 'SENT') = (sent_at is not null)),
  constraint usage_outbox_error_len_ck check (last_error_code is null or char_length(last_error_code) <= 80),
  -- Lo que no tiene tenant no puede haberse entregado ni descartado.
  constraint usage_outbox_unmapped_ck check (control_plane_tenant_id is not null or status = 'PENDING')
);

create index if not exists usage_outbox_due_idx
  on platform_usage.usage_outbox (next_attempt_at)
  where status = 'PENDING' and control_plane_tenant_id is not null;

comment on table platform_usage.usage_outbox is
  'Eventos ebim.usage/v1 pendientes de entregar a MasterAdmin. Hecho inmutable; solo cambian status/attempts/next_attempt_at/sent_at/last_error_code.';

alter table platform_usage.usage_outbox enable row level security;
alter table platform_usage.usage_outbox force  row level security;
revoke all on platform_usage.usage_outbox from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2 · El hecho es inmutable; SENT y DEAD son terminales; no se borra
-- ---------------------------------------------------------------------------
create or replace function platform_usage.guard_usage_fact()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'USAGE_FACT_IMMUTABLE: el outbox de uso no se borra' using errcode = '42501';
  end if;
  if old.status <> 'PENDING' then
    raise exception 'USAGE_FACT_IMMUTABLE: % es terminal', old.status using errcode = '42501';
  end if;
  if (new.event_id, new.source_interaction_id, new.occurred_at, new.meter_code, new.quantity,
      new.unit, new.control_plane_tenant_id, new.organization_id, new.company_id,
      new.external_company_id, new.capability_code, new.internal, new.created_at)
     is distinct from
     (old.event_id, old.source_interaction_id, old.occurred_at, old.meter_code, old.quantity,
      old.unit, old.control_plane_tenant_id, old.organization_id, old.company_id,
      old.external_company_id, old.capability_code, old.internal, old.created_at) then
    raise exception 'USAGE_FACT_IMMUTABLE: solo cambian las columnas de entrega' using errcode = '42501';
  end if;
  return new;
end
$fn$;

drop trigger if exists usage_outbox_guard on platform_usage.usage_outbox;
create trigger usage_outbox_guard
  before update or delete on platform_usage.usage_outbox
  for each row execute function platform_usage.guard_usage_fact();

drop trigger if exists usage_outbox_no_truncate on platform_usage.usage_outbox;
create trigger usage_outbox_no_truncate
  before truncate on platform_usage.usage_outbox
  for each statement execute function platform_usage.guard_usage_fact();

-- ---------------------------------------------------------------------------
-- 3 · Origen: la traza de IA encola en su misma transacción
-- ---------------------------------------------------------------------------
create or replace function platform_usage.enqueue_ai_interaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cpt   uuid;
  v_cap   text;
  v_model text;
begin
  -- Tenant de MasterAdmin: solo el mapping ACTIVE de provisioning.
  select r.control_plane_tenant_id into v_cpt
    from platform_provisioning.requests r
   where r.tenant_organization_id = new.organization_id
     and r.tenant_company_id      = new.company_id
     and r.status = 'ACTIVE';

  -- Capacidad consumida, con el código canónico de fase 09.
  select c.entitlement_code into v_cap
    from public.app_capabilities c
   where c.code = ebim.ai_capability_for(new.feature);
  if v_cap is not null and v_cap !~ '^[a-z0-9]+(\.[a-z0-9_]+)+$' then
    v_cap := null;
  end if;

  -- 'desconocido' es el marcador del pipeline cuando el transporte lanzó: no
  -- es un modelo que haya devuelto el proveedor.
  v_model := nullif(btrim(coalesce(new.model, '')), '');
  if v_model = 'desconocido' or char_length(v_model) > 100 then
    v_model := null;
  end if;

  insert into platform_usage.usage_outbox (
    source_interaction_id, occurred_at, meter_code, quantity, unit,
    control_plane_tenant_id, organization_id, company_id, external_company_id,
    capability_code, internal, last_error_code
  )
  values (
    new.id,
    -- Milisegundos: lo que viaja en `occurredAt` es exactamente lo guardado.
    date_trunc('milliseconds', new.created_at),
    'ecommerce.ai.calls', 1, 'call',
    v_cpt, new.organization_id, new.company_id, new.company_id::text,
    v_cap,
    jsonb_strip_nulls(jsonb_build_object(
      'provider',     case when v_model like 'claude-%' then 'anthropic' end,
      'model',        v_model,
      'inputTokens',  case when new.input_tokens      > 0 then new.input_tokens end,
      'outputTokens', case when new.output_tokens     > 0 then new.output_tokens end,
      'cacheTokens',  case when new.cache_read_tokens > 0 then new.cache_read_tokens end,
      'latencyMs',    case when new.latency_ms        > 0 then new.latency_ms end
    )),
    case when v_cpt is null then 'TENANT_NOT_MAPPED' end
  );
  return null;
end
$fn$;

drop trigger if exists ai_interactions_usage_outbox on public.ai_interactions;
create trigger ai_interactions_usage_outbox
  after insert on public.ai_interactions
  for each row execute function platform_usage.enqueue_ai_interaction();

revoke all on function platform_usage.internal_is_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function platform_usage.guard_usage_fact() from public, anon, authenticated, service_role;
revoke all on function platform_usage.enqueue_ai_interaction() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4 · Entrega (service_role): reclamo con lease y marcas
-- ---------------------------------------------------------------------------

/**
 * Reclama hasta `p_limit` eventos vencidos y CON tenant, en orden estable. El
 * lease es `next_attempt_at`: otro trabajador no los ve hasta que venza (si el
 * que los tomó se cae, vuelven solos). `SKIP LOCKED`: dos trabajadores a la vez
 * nunca reciben la misma fila.
 */
create or replace function public.platform_usage_outbox_claim(
  p_limit         integer default 500,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 300), 30), 900);
  v_rows  jsonb;
begin
  with due as (
    select o.event_id
      from platform_usage.usage_outbox o
     where o.status = 'PENDING'
       and o.control_plane_tenant_id is not null
       and o.next_attempt_at <= now()
     order by o.next_attempt_at, o.occurred_at, o.event_id
     limit v_limit
     for update skip locked
  ), leased as (
    update platform_usage.usage_outbox o
       set next_attempt_at = now() + make_interval(secs => v_lease)
      from due
     where o.event_id = due.event_id
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'event_id',                l.event_id,
           'occurred_at',             l.occurred_at,
           'meter_code',              l.meter_code,
           'quantity',                l.quantity,
           'unit',                    l.unit,
           'control_plane_tenant_id', l.control_plane_tenant_id,
           'external_company_id',     l.external_company_id,
           'capability_code',         l.capability_code,
           'internal',                l.internal,
           'attempts',                l.attempts)
           order by l.occurred_at, l.event_id), '[]'::jsonb)
    into v_rows
    from leased l;
  return v_rows;
end
$fn$;

/**
 * Aplica la clasificación del contrato: SENT (ACCEPTED/DUPLICATE), DEAD con su
 * código (REJECTED, terminal) o RETRY (attempts + 1, backoff
 * `min(30·2^(attempts−1), 21600)` s). Solo toca filas PENDING con tenant; lo
 * demás se cuenta como `ignored`. Una entrada malformada rechaza la llamada
 * entera.
 */
create or replace function public.platform_usage_outbox_mark(p_results jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  r         jsonb;
  v_id      uuid;
  v_outcome text;
  v_code    text;
  v_n       integer;
  v_sent    integer := 0;
  v_dead    integer := 0;
  v_retry   integer := 0;
  v_ignored integer := 0;
begin
  if p_results is null or jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results) > 5000 then
    raise exception 'USAGE_MARK_INVALID' using errcode = '22023';
  end if;
  for r in select e.value from jsonb_array_elements(p_results) e loop
    if jsonb_typeof(r) <> 'object'
       or coalesce(r ->> 'outcome', '') not in ('SENT', 'DEAD', 'RETRY')
       or coalesce(r ->> 'eventId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (r ? 'code' and jsonb_typeof(r -> 'code') not in ('string', 'null')) then
      raise exception 'USAGE_MARK_INVALID' using errcode = '22023';
    end if;
  end loop;

  for r in select e.value from jsonb_array_elements(p_results) e loop
    v_id      := (r ->> 'eventId')::uuid;
    v_outcome := r ->> 'outcome';
    v_code    := left(nullif(btrim(coalesce(r ->> 'code', '')), ''), 80);

    if v_outcome = 'SENT' then
      update platform_usage.usage_outbox o
         set status = 'SENT', sent_at = now(), last_error_code = null
       where o.event_id = v_id and o.status = 'PENDING' and o.control_plane_tenant_id is not null;
    elsif v_outcome = 'DEAD' then
      update platform_usage.usage_outbox o
         set status = 'DEAD', last_error_code = coalesce(v_code, 'REJECTED')
       where o.event_id = v_id and o.status = 'PENDING' and o.control_plane_tenant_id is not null;
    else
      update platform_usage.usage_outbox o
         set attempts        = o.attempts + 1,
             next_attempt_at = now() + make_interval(
                                 secs => least(30 * power(2::numeric, least(o.attempts, 20)), 21600)::double precision),
             last_error_code = coalesce(v_code, 'RETRY')
       where o.event_id = v_id and o.status = 'PENDING' and o.control_plane_tenant_id is not null;
    end if;

    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_ignored := v_ignored + 1;
    elsif v_outcome = 'SENT' then
      v_sent := v_sent + 1;
    elsif v_outcome = 'DEAD' then
      v_dead := v_dead + 1;
    else
      v_retry := v_retry + 1;
    end if;
  end loop;

  return jsonb_build_object('sent', v_sent, 'dead', v_dead, 'retry', v_retry, 'ignored', v_ignored);
end
$fn$;

revoke all on function public.platform_usage_outbox_claim(integer, integer) from public, anon, authenticated;
grant execute on function public.platform_usage_outbox_claim(integer, integer) to service_role;
revoke all on function public.platform_usage_outbox_mark(jsonb) from public, anon, authenticated;
grant execute on function public.platform_usage_outbox_mark(jsonb) to service_role;

comment on function public.platform_usage_outbox_claim(integer, integer) is
  'CCP fase 17: reclama eventos de uso vencidos con tenant (lease en next_attempt_at, SKIP LOCKED). Solo service_role.';
comment on function public.platform_usage_outbox_mark(jsonb) is
  'CCP fase 17: marca SENT/DEAD/RETRY según la clasificación de ebim.usage/v1 (backoff del contrato). Solo service_role.';
