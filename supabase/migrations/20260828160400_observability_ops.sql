-- =============================================================================
-- P13-SaaS · 5/6 — La bitacora de OPERACION y la salud del tenant
--
-- ## Por que existe una tabla y no basta con mirar las que ya hay
--
-- Los hechos ya estan: un checkout fallido esta en `checkout_intents.status`,
-- un cobro fallido en `payment_intents`, un mensaje muerto en
-- `integration_outbox`, un aviso no entregado en `domain_events`. Lo que NO
-- existe es un sitio con la MISMA FORMA para los cuatro, y esa es toda la
-- diferencia entre «se puede averiguar» y «se ve».
--
-- Sin esto, atender un incidente son cuatro consultas distintas contra cuatro
-- esquemas distintos, cada una con su nombre para «fallo» y su nombre para
-- «cuando». Con esto es una: severidad, codigo, momento y el HILO. Ademas hay
-- dos senales que hoy no tienen tabla ninguna y no la pueden tener —una
-- operacion lenta y un webhook con firma invalida ocurren en el BORDE, donde no
-- hay fila que mirar—, y esas son justo las que se pierden.
--
-- Es una PROYECCION, no una segunda verdad: la fila que manda sigue siendo la
-- del dominio, y `entity_type`/`entity_id` apuntan a ella. Se alimenta por
-- trigger, no por copia manual.
--
-- ## Y por que NO va en `analytics_events`
--
-- Porque el requisito de la fase lo prohibe con todas las letras: «sin acoplar
-- analitica comercial a logs tecnicos». Un pico de reintentos de un conector no
-- puede aparecer en el mismo sitio del que sale la tasa de conversion, ni
-- compartir retencion con ella. Son dos publicos, dos vidas y dos preguntas.
--
-- ## Vendor-neutral, que es un requisito y no una preferencia
--
-- «No dependas de un vendor unico: crea puntos de integracion.» Los puntos son
-- tres y ninguno nombra a nadie:
--
--   · `public.ops_record_event`  — el borde escribe aqui (`service_role`).
--   · `public.ops_health`        — cualquiera lo consulta para un tablero.
--   · `supabase/functions/_shared/observability` — el logger con SINKS
--     registrables: la consola siempre, la base opcional, y el que haga falta
--     el dia que se contrate uno. Cambiar de proveedor es registrar un sink.
--
-- No hay SDK de nadie, ni variable de entorno con nombre de producto, ni
-- formato propietario. Lo que se emite es JSON con campos estables.
-- =============================================================================

create type public.ops_event_kind as enum (
  'checkout_failed',    -- un intento de compra se cerro sin pedido
  'payment_failed',     -- la pasarela dijo que no
  'integration_failed', -- un mensaje al exterior agoto reintentos o murio
  'event_undelivered',  -- un hecho de dominio llego a la cola muerta
  'webhook_rejected',   -- entro algo que no pudo verificarse (firma, tenant)
  'slow_operation'      -- tardo mas de lo que nadie espera
);

create type public.ops_severity as enum ('info', 'warning', 'error', 'critical');

create table public.ops_events (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid,
  kind            public.ops_event_kind not null,
  severity        public.ops_severity   not null default 'error',
  -- Codigo ESTABLE, en mayusculas, el mismo vocabulario que ya usan los errores
  -- de negocio de esta base (`STOCK_INSUFICIENTE`, `FIRMA_INVALIDA`). Un texto
  -- libre aqui obligaria a agrupar por `like`, que es como se pierden los
  -- recuentos.
  code            text        not null,
  -- Que paso, en una linea y ya redactado. NO es el stack trace.
  message         text,
  -- Quien lo emitio: `db` o `edge:<funcion>`. Sin marca ni producto dentro.
  source          text        not null default 'db',
  -- La operacion canonica afectada, cuando la hay (`order.create`, `checkout`).
  operation       text,
  duration_ms     integer,
  entity_type     text,
  entity_id       uuid,
  correlation_id  text        default ebim.correlation_id(),
  request_id      text        default ebim.request_id(),
  context         jsonb       not null default '{}'::jsonb,
  occurred_at     timestamptz not null default now(),
  -- Un incidente se ATIENDE. Sin esto, el tablero solo sabe contar y la misma
  -- fila de hace tres semanas sigue pintando en rojo.
  resolved_at     timestamptz,
  resolved_by     uuid,
  resolution_note text,
  -- Idempotencia: el mismo fallo de la misma fila es UN incidente, no uno por
  -- reintento. Misma tecnica que `domain_events.dedupe_key`.
  dedupe_key      text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint ops_events_code_fmt    check (code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  constraint ops_events_source_fmt  check (source ~ '^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)?$'),
  constraint ops_events_operation_fmt
    check (operation is null or operation ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$'),
  constraint ops_events_entity_fmt
    check (entity_type is null or entity_type ~ '^[a-z][a-z0-9_]{0,60}$'),
  constraint ops_events_message_len
    check (message is null or char_length(message) <= 2000),
  constraint ops_events_duration     check (duration_ms is null or duration_ms >= 0),
  constraint ops_events_context_obj  check (jsonb_typeof(context) = 'object'),
  -- La misma guarda que la auditoria y por la misma razon: un contexto de error
  -- es exactamente donde acaba pegado el cuerpo de una peticion con datos
  -- dentro.
  constraint ops_events_context_clean check (ebim.jsonb_is_pii_free(context)),
  constraint ops_events_correlation_fmt
    check (correlation_id is null or correlation_id ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  constraint ops_events_request_fmt
    check (request_id is null or request_id ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  constraint ops_events_note_len
    check (resolution_note is null or char_length(resolution_note) between 3 and 1000),
  -- Resuelto sin fecha, o con fecha y sin nadie, son filas que mienten.
  constraint ops_events_resolution_shape
    check ((resolved_at is null and resolution_note is null) or resolved_at is not null),
  constraint ops_events_dedupe_len check (char_length(dedupe_key) between 8 and 200),
  constraint ops_events_dedupe_unique unique (organization_id, company_id, dedupe_key)
);

create index ops_events_tenant_idx on public.ops_events (organization_id, company_id);
create index ops_events_open_idx
  on public.ops_events (organization_id, company_id, severity, occurred_at desc)
  where resolved_at is null;
create index ops_events_kind_idx
  on public.ops_events (organization_id, company_id, kind, occurred_at desc);
create index ops_events_correlation_idx
  on public.ops_events (correlation_id) where correlation_id is not null;

create trigger ops_events_set_updated_at
  before update on public.ops_events
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- ebim.record_ops_event — LA escritura. Nunca levanta, por el mismo motivo que
-- `ebim.audit`: un fallo del registro de incidentes no puede convertirse en un
-- segundo incidente que ademas tumba la operacion.
--
-- `on conflict do update` y no `do nothing`: el segundo golpe del mismo fallo
-- actualiza el momento y sube el contador. Descartarlo haria que un incidente
-- que lleva tres dias repitiendose pareciera de hace tres dias.
-- ---------------------------------------------------------------------------
create or replace function ebim.record_ops_event(
  p_organization_id uuid,
  p_company_id      uuid,
  p_kind            public.ops_event_kind,
  p_code            text,
  p_dedupe_key      text,
  p_severity        public.ops_severity default 'error',
  p_message         text    default null,
  p_source          text    default 'db',
  p_operation       text    default null,
  p_duration_ms     integer default null,
  p_entity_type     text    default null,
  p_entity_id       uuid    default null,
  p_store_id        uuid    default null,
  p_context         jsonb   default '{}'::jsonb,
  p_correlation_id  text    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id uuid;
begin
  if p_organization_id is null or p_company_id is null then
    return null;
  end if;

  begin
    insert into public.ops_events (
      organization_id, company_id, store_id, kind, severity, code, message,
      source, operation, duration_ms, entity_type, entity_id,
      context, dedupe_key, correlation_id
    ) values (
      p_organization_id, p_company_id, p_store_id, p_kind, p_severity,
      upper(left(coalesce(nullif(btrim(coalesce(p_code, '')), ''), 'ERROR_INTERNO'), 80)),
      ebim.redact_text(p_message, 2000),
      coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'db'),
      p_operation, p_duration_ms, p_entity_type, p_entity_id,
      ebim.redact_pii(coalesce(p_context, '{}'::jsonb)),
      p_dedupe_key,
      coalesce(p_correlation_id, ebim.correlation_id())
    )
    on conflict (organization_id, company_id, dedupe_key) do update
      set occurred_at = now(),
          severity    = excluded.severity,
          message     = excluded.message,
          context     = ops_events.context
                        || jsonb_build_object(
                             'repeats',
                             coalesce((ops_events.context ->> 'repeats')::integer, 1) + 1)
    returning id into v_id;
  exception when others then
    v_id := null;
  end;

  return v_id;
end;
$fn$;

-- =============================================================================
-- Los CUATRO triggers. Cada uno sobre el estado que ya se escribe hoy.
-- =============================================================================

create or replace function ebim.ops_on_checkout_intent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.status <> 'failed' or old.status is not distinct from 'failed' then
    return null;
  end if;

  perform ebim.record_ops_event(
    p_organization_id => new.organization_id,
    p_company_id      => new.company_id,
    p_store_id        => new.store_id,
    p_kind            => 'checkout_failed',
    -- El codigo que la etapa levanto, tal cual. Es lo que agrupa: veinte
    -- `STOCK_INSUFICIENTE` son un problema de inventario y veinte
    -- `PRECIO_CAMBIADO` son otro completamente distinto.
    p_code            => coalesce(new.error_code, 'CHECKOUT_FALLIDO'),
    p_dedupe_key      => 'checkout:' || new.id::text,
    -- Un fallo de checkout es dinero que no entro. No es un aviso.
    p_severity        => 'error',
    p_message         => new.error_detail,
    p_operation       => 'checkout',
    p_entity_type     => 'checkout_intent',
    p_entity_id       => new.id,
    p_context         => jsonb_build_object(
                           'stage',    new.error_stage::text,
                           'attempts', new.attempts),
    p_correlation_id  => new.correlation_id);
  return null;
end;
$fn$;

create trigger checkout_intents_ops
  after update of status on public.checkout_intents
  for each row execute function ebim.ops_on_checkout_intent();

create or replace function ebim.ops_on_payment_intent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.status <> 'failed' or old.status is not distinct from 'failed' then
    return null;
  end if;

  perform ebim.record_ops_event(
    p_organization_id => new.organization_id,
    p_company_id      => new.company_id,
    p_store_id        => new.store_id,
    p_kind            => 'payment_failed',
    -- El codigo del PROVEEDOR, sin traducir. Es el que se cita al llamar al
    -- soporte de la pasarela, y traducirlo aqui lo haria inservible para eso
    -- (misma decision que P09 tomo con `provider_status`).
    p_code            => coalesce(new.last_error_code, 'PAGO_RECHAZADO'),
    p_dedupe_key      => 'payment:' || new.id::text,
    p_severity        => 'error',
    p_message         => new.last_error_detail,
    p_operation       => 'payment.authorize',
    p_entity_type     => 'payment_intent',
    p_entity_id       => new.id,
    p_context         => jsonb_build_object(
                           'provider', new.provider_code,
                           'currency', new.currency),
    p_correlation_id  => new.correlation_id);
  return null;
end;
$fn$;

create trigger payment_intents_ops
  after update of status on public.payment_intents
  for each row execute function ebim.ops_on_payment_intent();

create or replace function ebim.ops_on_integration_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.status not in ('failed', 'dead') or old.status = new.status then
    return null;
  end if;

  perform ebim.record_ops_event(
    p_organization_id => new.organization_id,
    p_company_id      => new.company_id,
    p_kind            => 'integration_failed'::public.ops_event_kind,
    p_code            => 'INTEGRACION_FALLIDA',
    p_dedupe_key      => 'outbox:' || new.id::text,
    -- `dead` es critico y `failed` no: uno va a reintentar solo y el otro no va
    -- a salir nunca sin que alguien lo toque. Pintarlos igual entrena a no
    -- mirar el tablero.
    --
    -- El cast explicito no es adorno: un `case` devuelve `text`, y una llamada
    -- con parametros con nombre no puede resolver la sobrecarga a partir de un
    -- `text` cuando el parametro es un enum. Sin el, la funcion «no existe».
    p_severity        => (case when new.status = 'dead' then 'critical' else 'warning' end)
                         ::public.ops_severity,
    p_message         => new.last_error,
    p_operation       => new.operation,
    p_entity_type     => 'integration_outbox',
    p_entity_id       => new.id,
    p_context         => jsonb_build_object(
                           'provider', new.provider_code,
                           'attempts', new.attempts,
                           'max_attempts', new.max_attempts),
    p_correlation_id  => new.correlation_id);
  return null;
end;
$fn$;

create trigger integration_outbox_ops
  after update of status on public.integration_outbox
  for each row execute function ebim.ops_on_integration_outbox();

create or replace function ebim.ops_on_domain_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.status <> 'dead' or old.status is not distinct from 'dead' then
    return null;
  end if;

  perform ebim.record_ops_event(
    p_organization_id => new.organization_id,
    p_company_id      => new.company_id,
    p_store_id        => new.store_id,
    p_kind            => 'event_undelivered',
    p_code            => 'HECHO_NO_ENTREGADO',
    p_dedupe_key      => 'domain_event:' || new.id::text,
    p_severity        => 'critical',
    p_message         => new.last_error,
    p_operation       => new.event_type,
    p_entity_type     => 'domain_event',
    p_entity_id       => new.id,
    p_context         => jsonb_build_object('attempts', new.attempts),
    p_correlation_id  => new.correlation_id);
  return null;
end;
$fn$;

create trigger domain_events_ops
  after update of status on public.domain_events
  for each row execute function ebim.ops_on_domain_event();

-- =============================================================================
-- Las puertas: escribir desde el borde, atender desde la pantalla
-- =============================================================================

-- ---------------------------------------------------------------------------
-- public.ops_record_event — el punto de integracion del BORDE.
--
-- Es por donde entran las dos senales que la base no puede ver: una firma de
-- webhook que no valida y una operacion lenta. Solo `service_role`: si el
-- navegador pudiera escribir incidentes, el tablero de salud lo llenaria
-- cualquiera desde la consola.
-- ---------------------------------------------------------------------------
create or replace function public.ops_record_event(
  p_organization_id uuid,
  p_company_id      uuid,
  p_kind            public.ops_event_kind,
  p_code            text,
  p_dedupe_key      text,
  p_severity        public.ops_severity default 'error',
  p_message         text    default null,
  p_source          text    default 'edge',
  p_operation       text    default null,
  p_duration_ms     integer default null,
  p_entity_type     text    default null,
  p_entity_id       uuid    default null,
  p_store_id        uuid    default null,
  p_context         jsonb   default '{}'::jsonb,
  p_correlation_id  text    default null
)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $fn$
  select ebim.record_ops_event(
    p_organization_id, p_company_id, p_kind, p_code, p_dedupe_key, p_severity,
    p_message, p_source, p_operation, p_duration_ms, p_entity_type, p_entity_id,
    p_store_id, p_context, p_correlation_id);
$fn$;

-- ---------------------------------------------------------------------------
-- public.ops_resolve_event — atender.
--
-- Es la unica escritura que la pantalla puede hacer, y no es un `update`
-- directo: `ops_events` no tiene GRANT de UPDATE. Resolver son tres cosas que
-- pasan juntas (autorizacion, fecha y firma de quien lo hizo) y un GRANT de
-- UPDATE permite hacer una sin las otras — la misma decision que P08 tomo con
-- los ejes del pedido y P12 con las entregas.
-- ---------------------------------------------------------------------------
create or replace function public.ops_resolve_event(p_event_id uuid, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_row public.ops_events%rowtype;
begin
  select * into v_row from public.ops_events e where e.id = p_event_id;
  if not found then
    raise exception 'INCIDENTE_NO_ENCONTRADO: ese incidente no existe'
      using errcode = '22023';
  end if;

  if not ebim.has_role(v_row.organization_id, v_row.company_id,
                       array['owner', 'admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: hace falta rol owner o admin para atender un incidente'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'MOTIVO_REQUERIDO: hay que decir que se hizo con el incidente'
      using errcode = '22023';
  end if;

  update public.ops_events
     set resolved_at     = now(),
         resolved_by     = ebim.user_id(),
         resolution_note = ebim.redact_text(p_note, 1000)
   where id = p_event_id
  returning * into v_row;

  perform ebim.audit(
    p_organization_id => v_row.organization_id,
    p_company_id      => v_row.company_id,
    p_action          => 'ops_event.resolved',
    p_entity_type     => 'ops_event',
    p_entity_id       => v_row.id,
    p_entity_label    => v_row.code,
    p_store_id        => v_row.store_id,
    p_metadata        => jsonb_build_object('kind', v_row.kind::text));

  return jsonb_build_object('id', v_row.id, 'resolved_at', v_row.resolved_at);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.ops_health — la foto de salud del TENANT, y solo del tenant.
--
-- SECURITY DEFINER con la autorizacion DENTRO, no invoker. Dos motivos:
--
--   1. Cuenta filas de `integration_outbox`, `integration_inbox` y
--      `domain_events`, tres tablas cuyo GRANT de lectura para el backoffice
--      existe pero cuya profundidad de cola hay que poder contar sin depender
--      de que las tres policies coincidan hoy y dentro de un año.
--   2. Cada rama filtra por `organization_id`/`company_id` derivados del JWT.
--      No hay parametro de tenant, asi que no hay nada que un cliente pueda
--      declarar para mirar la cola de otro.
--
-- El `p_store_id` es alcance dentro de lo ya autorizado, igual que en
-- `effective_capabilities`: acota, no concede.
-- ---------------------------------------------------------------------------
create or replace function public.ops_health(p_store_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_org     uuid := ebim.org_id();
  v_company uuid := ebim.active_company();
  v_result  jsonb;
begin
  if v_org is null or v_company is null then
    raise exception 'SIN_PERMISO: el token no trae la jerarquia de tenant'
      using errcode = '42501';
  end if;
  if not ebim.has_role(v_org, v_company, array['owner', 'admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: la salud operativa la ve owner o admin'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'organization_id', v_org,
    'company_id',      v_company,
    'generated_at',    now(),

    -- Profundidad de cola. Las tres colas que existen, con la MISMA forma.
    'queues', jsonb_build_object(
      'domain_events', (
        select jsonb_build_object(
          'pending',   count(*) filter (where e.status = 'pending'),
          'in_flight', count(*) filter (where e.status = 'in_flight'),
          'dead',      count(*) filter (where e.status = 'dead'),
          -- La edad del mas viejo es la senal que de verdad importa: una cola
          -- de 200 que se vacia sola esta sana; una de 3 parada desde ayer, no.
          'oldest_pending_seconds', (
            select floor(extract(epoch from (now() - min(p.created_at))))::bigint
              from public.domain_events p
             where p.organization_id = v_org and p.company_id = v_company
               and p.status = 'pending'))
          from public.domain_events e
         where e.organization_id = v_org and e.company_id = v_company),
      'integration_outbox', (
        select jsonb_build_object(
          'pending',   count(*) filter (where o.status = 'pending'),
          'in_flight', count(*) filter (where o.status = 'in_flight'),
          'failed',    count(*) filter (where o.status = 'failed'),
          'dead',      count(*) filter (where o.status = 'dead'),
          'oldest_pending_seconds', (
            select floor(extract(epoch from (now() - min(p.created_at))))::bigint
              from public.integration_outbox p
             where p.organization_id = v_org and p.company_id = v_company
               and p.status = 'pending'))
          from public.integration_outbox o
         where o.organization_id = v_org and o.company_id = v_company),
      'integration_inbox', (
        select jsonb_build_object(
          'unprocessed', count(*) filter (where i.processed_at is null),
          'oldest_pending_seconds', (
            select floor(extract(epoch from (now() - min(p.created_at))))::bigint
              from public.integration_inbox p
             where p.organization_id = v_org and p.company_id = v_company
               and p.processed_at is null))
          from public.integration_inbox i
         where i.organization_id = v_org and i.company_id = v_company)),

    -- Lo que se rompio en las ultimas 24 horas, por familia.
    'last_24h', jsonb_build_object(
      'checkouts_failed', (
        select count(*) from public.checkout_intents c
         where c.organization_id = v_org and c.company_id = v_company
           and c.status = 'failed' and c.updated_at > now() - interval '24 hours'
           and (p_store_id is null or c.store_id = p_store_id)),
      'checkouts_total', (
        select count(*) from public.checkout_intents c
         where c.organization_id = v_org and c.company_id = v_company
           and c.created_at > now() - interval '24 hours'
           and (p_store_id is null or c.store_id = p_store_id)),
      'payments_failed', (
        select count(*) from public.payment_intents pi
         where pi.organization_id = v_org and pi.company_id = v_company
           and pi.status = 'failed' and pi.updated_at > now() - interval '24 hours'
           and (p_store_id is null or pi.store_id = p_store_id)),
      'integrations_failed', (
        select count(*) from public.integration_outbox o
         where o.organization_id = v_org and o.company_id = v_company
           and o.status in ('failed', 'dead') and o.updated_at > now() - interval '24 hours')),

    -- Intentos ATASCADOS: `running` desde hace mas de cinco minutos. Es
    -- exactamente el sintoma que P07 describio —un proceso que murio a medias—
    -- y hasta hoy no habia donde verlo.
    'stuck_checkouts', (
      select count(*) from public.checkout_intents c
       where c.organization_id = v_org and c.company_id = v_company
         and c.status = 'running' and c.updated_at < now() - interval '5 minutes'
         and (p_store_id is null or c.store_id = p_store_id)),

    -- Incidentes abiertos, por severidad.
    'open_incidents', coalesce((
      select jsonb_object_agg(sev.severity, sev.total)
        from (select e.severity::text as severity, count(*) as total
                from public.ops_events e
               where e.organization_id = v_org and e.company_id = v_company
                 and e.resolved_at is null
               group by e.severity) sev), '{}'::jsonb),

    -- Operaciones lentas: cuantas y la peor. Sin p95 inventado: con cuatro
    -- muestras un percentil es un numero con aspecto de estadistica.
    'slow_operations', (
      select jsonb_build_object(
        'count', count(*),
        'max_ms', max(e.duration_ms))
        from public.ops_events e
       where e.organization_id = v_org and e.company_id = v_company
         and e.kind = 'slow_operation'
         and e.occurred_at > now() - interval '24 hours'),

    -- Frescura del contexto del hub. Un tenant cuyo `synced_at` es de hace un
    -- mes esta gateando modulos con una respuesta caducada, y eso se nota como
    -- «no me deja entrar a un modulo que si pago».
    'platform_context', (
      select jsonb_build_object(
        'source',    coalesce(ctx.source::text, 'sin-contexto'),
        'app_active', coalesce(ctx.app_active, true),
        'synced_at', ctx.synced_at)
        from public.tenant_platform_context ctx
       where ctx.organization_id = v_org and ctx.company_id = v_company)
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.trace_by_correlation — LA funcion de la Definition of Done.
--
-- «PASS si un incidente de checkout/integracion puede rastrearse end-to-end con
-- correlation id.» Esto es ese rastreo: una linea de tiempo ordenada con todo
-- lo que ocurrio bajo el mismo hilo, atravesando siete dominios.
--
-- SECURITY DEFINER con la autorizacion dentro y por rama. Es la unica forma de
-- unir siete tablas cuyas policies no son la misma —una tiene GRANT por
-- columna, otra solo lectura de miembro— sin acabar devolviendo menos de lo que
-- el usuario tiene derecho a ver o, mucho peor, mas. Cada rama filtra por
-- `ebim.can_access(...)`: un hilo que atraviesa dos tenants —imposible hoy, y
-- por eso mismo hay que asegurarlo— devuelve solo la parte del que pregunta.
-- ---------------------------------------------------------------------------
create or replace function public.trace_by_correlation(p_correlation_id text)
returns table (
  occurred_at timestamptz,
  domain      text,
  entity_type text,
  entity_id   uuid,
  summary     text,
  status      text,
  severity    text
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_id text := nullif(btrim(coalesce(p_correlation_id, '')), '');
begin
  if v_id is null or v_id !~ '^[A-Za-z0-9_.:-]{8,120}$' then
    raise exception 'CORRELACION_INVALIDA: el identificador de hilo no tiene la forma esperada'
      using errcode = '22023';
  end if;

  return query
  select c.created_at, 'checkout'::text, 'checkout_intent'::text, c.id,
         ('etapa ' || c.stage::text)::text, c.status::text,
         (case when c.status = 'failed' then 'error' else 'info' end)::text
    from public.checkout_intents c
   where c.correlation_id = v_id and ebim.can_access(c.organization_id, c.company_id)
  union all
  select o.placed_at, 'orders', 'order', o.id, o.order_number, o.status::text, 'info'::text
    from public.orders o
   where o.correlation_id = v_id and ebim.can_access(o.organization_id, o.company_id)
  union all
  select p.created_at, 'payments', 'payment_intent', p.id,
         coalesce(p.provider_code, 'sin proveedor'), p.status::text,
         (case when p.status = 'failed' then 'error' else 'info' end)::text
    from public.payment_intents p
   where p.correlation_id = v_id and ebim.can_access(p.organization_id, p.company_id)
  union all
  select pe.created_at, 'payments', 'payment_event', pe.id, pe.event_type, null::text, 'info'::text
    from public.payment_events pe
   where pe.correlation_id = v_id and ebim.can_access(pe.organization_id, pe.company_id)
  union all
  select f.created_at, 'fulfillment', 'fulfillment', f.id, f.method_code, f.state::text, 'info'::text
    from public.fulfillments f
   where f.correlation_id = v_id and ebim.can_access(f.organization_id, f.company_id)
  union all
  select d.created_at, 'events', 'domain_event', d.id, d.event_type, d.status::text,
         (case when d.status = 'dead' then 'critical' else 'info' end)::text
    from public.domain_events d
   where d.correlation_id = v_id and ebim.can_access(d.organization_id, d.company_id)
  union all
  select ob.created_at, 'integrations', 'integration_outbox', ob.id,
         (ob.provider_code || ' · ' || ob.operation)::text, ob.status::text,
         (case when ob.status = 'dead' then 'critical'
               when ob.status = 'failed' then 'warning' else 'info' end)::text
    from public.integration_outbox ob
   where ob.correlation_id = v_id and ebim.can_access(ob.organization_id, ob.company_id)
  union all
  select ib.created_at, 'integrations', 'integration_inbox', ib.id,
         (ib.provider_code || ' · ' || ib.event_type)::text,
         (case when ib.processed_at is null then 'pending' else 'processed' end)::text,
         'info'::text
    from public.integration_inbox ib
   where ib.correlation_id = v_id and ebim.can_access(ib.organization_id, ib.company_id)
  union all
  select a.occurred_at, 'audit', a.entity_type, a.entity_id, a.action, null::text, 'info'::text
    from public.audit_log a
   where a.correlation_id = v_id and ebim.can_access(a.organization_id, a.company_id)
  union all
  select ae.occurred_at, 'analytics', 'analytics_event', ae.id,
         ae.event_type::text, null::text, 'info'::text
    from public.analytics_events ae
   where ae.correlation_id = v_id and ebim.can_access(ae.organization_id, ae.company_id)
  union all
  select oe.occurred_at, 'ops', 'ops_event', oe.id,
         (oe.kind::text || ' · ' || oe.code)::text,
         (case when oe.resolved_at is null then 'open' else 'resolved' end)::text,
         oe.severity::text
    from public.ops_events oe
   where oe.correlation_id = v_id and ebim.can_access(oe.organization_id, oe.company_id)
  order by 1;
end;
$fn$;

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.ops_events enable row level security;
alter table public.ops_events force  row level security;

revoke all on public.ops_events from public, anon, authenticated;
grant  all on public.ops_events to service_role;
grant  select on public.ops_events to authenticated;

-- `owner` y `admin`, igual que la auditoria: un incidente lleva dentro el
-- codigo de error del proveedor de cobro y la operacion que no salio.
create policy ops_events_select_admin on public.ops_events
  for select to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner', 'admin']::public.app_role[]));

revoke execute on function ebim.record_ops_event(
  uuid, uuid, public.ops_event_kind, text, text, public.ops_severity, text, text,
  text, integer, text, uuid, uuid, jsonb, text
) from public, anon, authenticated;
grant execute on function ebim.record_ops_event(
  uuid, uuid, public.ops_event_kind, text, text, public.ops_severity, text, text,
  text, integer, text, uuid, uuid, jsonb, text
) to service_role;

revoke execute on function public.ops_record_event(
  uuid, uuid, public.ops_event_kind, text, text, public.ops_severity, text, text,
  text, integer, text, uuid, uuid, jsonb, text
) from public, anon, authenticated;
grant execute on function public.ops_record_event(
  uuid, uuid, public.ops_event_kind, text, text, public.ops_severity, text, text,
  text, integer, text, uuid, uuid, jsonb, text
) to service_role;

revoke execute on function public.ops_resolve_event(uuid, text) from public, anon;
grant  execute on function public.ops_resolve_event(uuid, text) to authenticated, service_role;

revoke execute on function public.ops_health(uuid) from public, anon;
grant  execute on function public.ops_health(uuid) to authenticated, service_role;

revoke execute on function public.trace_by_correlation(text) from public, anon;
grant  execute on function public.trace_by_correlation(text) to authenticated, service_role;

comment on table public.ops_events is
  'Bitacora de OPERACION: checkout, cobro e integracion fallidos, hechos no entregados, webhooks rechazados y operaciones lentas, todos con la misma forma y con el hilo. Proyeccion, no segunda verdad.';
comment on function public.ops_health(uuid) is
  'Salud del TENANT: profundidad de cola, fallos de 24 h, intentos atascados e incidentes abiertos. No acepta tenant: lo deriva del JWT, asi que no hay nada que declarar para ver la cola de otro.';
comment on function public.trace_by_correlation(text) is
  'La linea de tiempo de UN hilo a traves de once tablas y siete dominios. Cada rama filtra por ebim.can_access: un hilo compartido devuelve solo la parte del que pregunta.';
