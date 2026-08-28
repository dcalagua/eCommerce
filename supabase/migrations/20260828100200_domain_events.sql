-- =============================================================================
-- P07-SaaS · El outbox de DOMINIO
--
-- ## Por que no se reusa `integration_outbox` (150000), que ya es un outbox
--
-- Porque no es la misma cosa, y la firma de `public.integration_enqueue` lo
-- dice sin ambiguedad: **exige un `provider_code` con la integracion ACTIVA en
-- esa sociedad** y ademas que ese proveedor declare la operacion. Es correcto
-- para lo que hace —entregar a un sistema externo concreto— y es exactamente lo
-- que un evento de dominio no puede aceptar: "se creo el pedido EC-…" tiene que
-- quedar registrado en un tenant que no ha contratado ni un solo conector. Si
-- se encolara ahi, la primera tienda sin integraciones veria fallar su checkout
-- con `INTEGRACION_NO_ACTIVA`, o —peor— alguien pondria un `exception when
-- others then null` alrededor y el evento se perderia en silencio.
--
-- Son dos colas con dos destinatarios: `integration_outbox` entrega A UN
-- SISTEMA; `domain_events` publica UN HECHO. Un consumidor del hecho puede ser
-- despues un `integration_enqueue` —y ese es el puente natural con P14—, un
-- correo, o nada en absoluto.
--
-- ## La propiedad que justifica la tabla
--
-- El evento se escribe en la MISMA transaccion que el pedido. No hay ventana en
-- la que el pedido exista y su aviso no: o estan los dos o no esta ninguno. Ese
-- es todo el patron, y es la razon de que la publicacion NO sea una llamada
-- HTTP dentro de la transaccion del checkout (regla explicita de la fase: nada
-- de llamadas externas dentro de transacciones largas).
--
-- ## Idempotencia
--
-- `dedupe_key` unica por sociedad. Reintentar un checkout con la misma clave de
-- idempotencia no publica dos veces "pedido creado", porque la clave del evento
-- se deriva de la del intento. La garantia es el indice, no una comprobacion
-- previa: entre comprobar y escribir cabe otro proceso.
-- =============================================================================

create type public.domain_event_status as enum
  ('pending', 'in_flight', 'processed', 'failed', 'dead');

create table public.domain_events (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  -- Opcional: hay hechos de la sociedad que no son de una tienda concreta.
  store_id        uuid,
  -- Nombre CANONICO del hecho, en pasado: `order.created`, no `create_order`.
  -- Un evento con nombre de orden es una llamada disfrazada, y entonces el
  -- publicador vuelve a saber quien lo escucha.
  event_type      text        not null,
  aggregate_type  text        not null,
  aggregate_id    uuid,
  payload         jsonb       not null default '{}'::jsonb,
  dedupe_key      text        not null,
  status          public.domain_event_status not null default 'pending',
  attempts        integer     not null default 0,
  max_attempts    integer     not null default 6,
  next_retry_at   timestamptz not null default now(),
  last_error      text,
  claimed_by      text,
  claimed_at      timestamptz,
  processed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint domain_events_type_fmt
    check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint domain_events_aggregate_fmt
    check (aggregate_type ~ '^[a-z][a-z0-9_]{0,40}$'),
  constraint domain_events_attempts
    check (attempts >= 0 and max_attempts between 1 and 20),
  constraint domain_events_dedupe_len check (char_length(dedupe_key) between 8 and 200),
  constraint domain_events_dedupe_unique unique (organization_id, company_id, dedupe_key),
  constraint domain_events_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index domain_events_tenant on public.domain_events (organization_id, company_id);
create index domain_events_aggregate on public.domain_events (aggregate_type, aggregate_id);
-- Indice de la ruta caliente: "dame lo siguiente que toca procesar".
create index domain_events_due
  on public.domain_events (next_retry_at, created_at)
  where status = 'pending';

create trigger domain_events_updated_at before update on public.domain_events
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- ebim.publish_event — se llama DENTRO de la transaccion del hecho.
--
-- Idempotente de verdad: el segundo intento con la misma `dedupe_key` devuelve
-- el evento que ya existe, no uno nuevo y no un error. Es lo que permite que el
-- pipeline reintente sin pensarlo.
-- ---------------------------------------------------------------------------
create or replace function ebim.publish_event(
  p_organization_id uuid,
  p_company_id      uuid,
  p_store_id        uuid,
  p_event_type      text,
  p_aggregate_type  text,
  p_aggregate_id    uuid,
  p_payload         jsonb,
  p_dedupe_key      text
)
returns uuid
language plpgsql
set search_path = ''
as $fn$
declare
  v_id uuid;
begin
  insert into public.domain_events (
    organization_id, company_id, store_id, event_type,
    aggregate_type, aggregate_id, payload, dedupe_key
  ) values (
    p_organization_id, p_company_id, p_store_id, p_event_type,
    p_aggregate_type, p_aggregate_id, coalesce(p_payload, '{}'::jsonb), p_dedupe_key
  )
  on conflict (organization_id, company_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    select e.id into v_id
    from public.domain_events e
    where e.organization_id = p_organization_id
      and e.company_id      = p_company_id
      and e.dedupe_key      = p_dedupe_key;
  end if;

  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.claim_domain_events — reclamar sin entregar dos veces.
--
-- `for update skip locked`, igual que `integration_claim` y por la misma razon:
-- dos trabajadores en paralelo no se pisan y ninguno espera al otro. Sin
-- `skip locked` se bloquean entre si; sin `for update` los dos se llevan el
-- mismo hecho y el comprador recibe dos correos.
-- ---------------------------------------------------------------------------
create or replace function public.claim_domain_events(
  p_worker      text,
  p_limit       integer default 10,
  p_event_types text[] default null
)
returns setof public.domain_events
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
  with candidatos as (
    select e.id
    from public.domain_events e
    where e.status = 'pending'
      and e.next_retry_at <= now()
      and (p_event_types is null or e.event_type = any (p_event_types))
    order by e.next_retry_at, e.created_at
    limit greatest(1, least(coalesce(p_limit, 10), 100))
    for update skip locked
  )
  update public.domain_events e
     set status = 'in_flight',
         attempts = e.attempts + 1,
         claimed_by = p_worker,
         claimed_at = now()
   from candidatos c
  where e.id = c.id
  returning e.*;
end;
$fn$;

create or replace function public.complete_domain_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.domain_events
     set status = 'processed', processed_at = now(), last_error = null
   where id = p_event_id and status = 'in_flight';

  if not found then
    raise exception 'EVENTO_NO_EN_VUELO: % no estaba reclamado', p_event_id
      using errcode = '22023';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Fallo: backoff exponencial con jitter, y cola muerta al agotar intentos.
--
-- El jitter no es adorno: sin el, todos los eventos que fallaron a la vez
-- vuelven a la vez y tumban otra vez al destinatario justo cuando se estaba
-- recuperando. Misma formula que `integration_fail` (150100).
-- ---------------------------------------------------------------------------
create or replace function public.fail_domain_event(
  p_event_id uuid,
  p_error    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row   public.domain_events%rowtype;
  v_delay numeric;
begin
  select * into v_row from public.domain_events e
   where e.id = p_event_id and e.status = 'in_flight';

  if not found then
    raise exception 'EVENTO_NO_EN_VUELO: % no estaba reclamado', p_event_id
      using errcode = '22023';
  end if;

  if v_row.attempts >= v_row.max_attempts then
    update public.domain_events
       set status = 'dead', processed_at = now(),
           last_error = left(coalesce(p_error, ''), 2000)
     where id = p_event_id;
  else
    v_delay := least(power(2, v_row.attempts)::numeric, 3600) * (0.5 + random());
    update public.domain_events
       set status = 'pending',
           next_retry_at = now() + make_interval(secs => v_delay),
           claimed_by = null,
           claimed_at = null,
           last_error = left(coalesce(p_error, ''), 2000)
     where id = p_event_id;
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Rescate de huerfanos: un worker que muere deja el evento `in_flight` para
-- siempre y el aviso no sale nunca, sin que nadie se entere.
-- ---------------------------------------------------------------------------
create or replace function public.reclaim_stale_domain_events(
  p_older_than interval default '5 minutes'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  update public.domain_events
     set status = 'pending', claimed_by = null, claimed_at = null, next_retry_at = now()
   where status = 'in_flight'
     and claimed_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- RLS — el tenant LEE su bitacora de hechos; nadie la escribe desde el cliente
-- ---------------------------------------------------------------------------
alter table public.domain_events enable row level security;
alter table public.domain_events force  row level security;

revoke all on public.domain_events from public, anon, authenticated;
grant  all on public.domain_events to service_role;

-- Solo lectura y solo del tenant: sirve para diagnosticar por que no salio un
-- aviso, no para operar. Un estado que el cliente pueda cambiar no es un
-- estado: es una sugerencia.
grant select on public.domain_events to authenticated;

create policy domain_events_select_member on public.domain_events
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

revoke execute on function
  ebim.publish_event(uuid, uuid, uuid, text, text, uuid, jsonb, text)
from public, anon, authenticated;

-- El servidor SI puede publicar. No es una concesion de comodidad: los hechos
-- de las fases siguientes —cambio de estado de un pedido (P08), cobro
-- confirmado (P09), envio despachado (P12)— los produce codigo de servidor que
-- no pasa por `checkout_place_order`. Lo que sigue siendo imposible es
-- publicarlos desde el navegador.
grant execute on function
  ebim.publish_event(uuid, uuid, uuid, text, text, uuid, jsonb, text)
to service_role;

revoke execute on function public.claim_domain_events(text, integer, text[])
  from public, anon, authenticated;
revoke execute on function public.complete_domain_event(uuid)
  from public, anon, authenticated;
revoke execute on function public.fail_domain_event(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.reclaim_stale_domain_events(interval)
  from public, anon, authenticated;

grant execute on function public.claim_domain_events(text, integer, text[])   to service_role;
grant execute on function public.complete_domain_event(uuid)                  to service_role;
grant execute on function public.fail_domain_event(uuid, text)                to service_role;
grant execute on function public.reclaim_stale_domain_events(interval)        to service_role;

comment on table public.domain_events is
  'Outbox de DOMINIO: hechos publicados en la misma transaccion que los produce. Distinto de integration_outbox, que exige un proveedor activo y entrega a un sistema concreto.';
comment on column public.domain_events.dedupe_key is
  'Clave de deduplicacion por sociedad. Se deriva de la clave de idempotencia del checkout: un reintento no publica el hecho dos veces.';
comment on function ebim.publish_event(uuid, uuid, uuid, text, text, uuid, jsonb, text) is
  'Publica un hecho DENTRO de la transaccion que lo causa. Idempotente por dedupe_key: el segundo intento devuelve el mismo evento.';
