-- =============================================================================
-- P14-SaaS · 1/7 — El transporte gana una DIMENSION: el destino concreto
--
-- ## Que problema resuelve, y por que no se construye otra cola
--
-- El encargo de la fase es explicito: «reutiliza el framework actual … no
-- construyas otro sistema paralelo». El framework de P12 historico
-- (`20260827150000` y `20260827150100`) ya trae todo lo que un webhook
-- necesita —outbox transaccional, idempotencia, reintentos con backoff y
-- jitter, cola muerta, disyuntor y bitacora de intentos— salvo UNA cosa: sabe
-- entregar «al proveedor X», no «al endpoint numero 3 del proveedor X».
--
-- Esa es toda la diferencia, y se arregla con una columna, no con una segunda
-- cola:
--
--   · `integration_outbox.target`  — a QUE destino concreto va este mensaje.
--   · `integration_circuit.target` — el disyuntor pasa a ser POR destino.
--
-- La segunda es la que de verdad importa. Sin ella, un solo endpoint de webhook
-- roto abriria el circuito del proveedor `webhook` entero y dejaria de entregar
-- a los endpoints SANOS del mismo tenant. Un disyuntor que castiga al inocente
-- es peor que no tener disyuntor, porque el fallo se vuelve invisible: la cola
-- crece y nadie sabe cual de los cinco destinos la esta bloqueando.
--
-- `target = ''` (cadena vacia, no NULL) significa «el proveedor entero», que es
-- exactamente lo que habia antes de esta migracion. Por eso el DEFAULT no
-- cambia ni un comportamiento existente: los mensajes de ERP, pago o logistica
-- siguen compartiendo un circuito por (proveedor, operacion) igual que ayer.
-- Cadena vacia y no NULL porque el destino entra en una clave UNIQUE, y en
-- Postgres dos NULL no chocan: con NULL, el disyuntor «del proveedor entero»
-- podria duplicarse en silencio.
--
-- ## Por que se DROPEA y se recrea en vez de anadir una sobrecarga
--
-- `create or replace function` con un parametro mas crea una SOBRECARGA, no una
-- sustitucion, y entonces `integration_enqueue(a,b,c,d,e,f)` deja de resolver:
-- Postgres no puede elegir entre la vieja de 6 y la nueva de 7-con-defecto y
-- levanta «function is not unique». Las llamadas existentes —incluidas las de
-- la suite— se romperian. Se dropea la firma vieja y se crea la nueva con el
-- parametro al final y con defecto, que es la unica forma de que las llamadas
-- posicionales de 6 argumentos sigan siendo validas. Mismo patron que
-- `20260828150600` uso con `create_order`.
--
-- ## Lo que NO se guarda, a proposito
--
-- El CUERPO de la respuesta del destino. Se guarda el codigo de estado y el
-- error truncado, y nada mas. Un cuerpo de respuesta es texto que escribe un
-- tercero: puede traer dentro el correo del comprador que le acabamos de
-- enviar, un token de su propia API o una traza con datos de otro cliente
-- suyo. La pantalla de monitor tiene que ser legible por soporte, y eso exige
-- que lo que hay dentro no sea un vertedero sin revisar.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. El destino, en las tres tablas del transporte
-- ---------------------------------------------------------------------------
alter table public.integration_outbox
  add column target text not null default '';

alter table public.integration_circuit
  add column target text not null default '';

alter table public.integration_messages
  add column target         text not null default '',
  add column status_code    integer,
  -- El HILO tambien en la bitacora de intentos. Sin el, `trace_by_correlation`
  -- puede decir «el mensaje murio» pero no «murio en el intento 4 con un 503»,
  -- que es la mitad util del diagnostico.
  add column correlation_id text;

-- Formato del destino: o vacio, o un identificador acotado. Es texto que se
-- pinta en una pantalla de operacion; un salto de linea dentro es como se
-- falsifica una fila de monitor.
alter table public.integration_outbox
  add constraint integration_outbox_target_fmt
  check (target = '' or target ~ '^[A-Za-z0-9_.:-]{1,120}$');

alter table public.integration_circuit
  add constraint integration_circuit_target_fmt
  check (target = '' or target ~ '^[A-Za-z0-9_.:-]{1,120}$');

alter table public.integration_messages
  add constraint integration_messages_target_fmt
  check (target = '' or target ~ '^[A-Za-z0-9_.:-]{1,120}$');

alter table public.integration_messages
  add constraint integration_messages_status_code
  check (status_code is null or status_code between 100 and 599);

alter table public.integration_messages
  add constraint integration_messages_correlation_fmt
  check (correlation_id is null or correlation_id ~ '^[A-Za-z0-9_.:-]{8,120}$');

-- ---------------------------------------------------------------------------
-- 2. El disyuntor pasa a ser por destino
--
-- Se sustituye la clave unica, no se anade otra: dejar la vieja haria imposible
-- tener dos circuitos del mismo (proveedor, operacion) con destinos distintos,
-- que es justo lo que esta migracion existe para permitir.
-- ---------------------------------------------------------------------------
alter table public.integration_circuit
  drop constraint integration_circuit_unique;

alter table public.integration_circuit
  add constraint integration_circuit_unique
  unique (organization_id, company_id, provider_code, operation, target);

-- Ruta caliente del monitor: «que circuitos estan abiertos ahora mismo».
create index integration_circuit_open
  on public.integration_circuit (provider_code, target)
  where state <> 'closed';

create index integration_outbox_target_idx
  on public.integration_outbox (organization_id, company_id, target, created_at desc)
  where target <> '';

create index integration_messages_target_idx
  on public.integration_messages (target, created_at desc)
  where target <> '';

-- ---------------------------------------------------------------------------
-- 3. Encolar, ahora con destino
-- ---------------------------------------------------------------------------
drop function if exists public.integration_enqueue(uuid, uuid, text, text, jsonb, text);

create function public.integration_enqueue(
  p_organization_id uuid,
  p_company_id      uuid,
  p_provider_code   text,
  p_operation       text,
  p_payload         jsonb,
  p_idempotency_key text,
  -- El destino concreto dentro del proveedor. '' = el proveedor entero, que es
  -- el comportamiento de P12 y el de todo llamante que no lo pase.
  p_target          text default ''
)
returns uuid
language plpgsql
set search_path = ''
as $fn$
declare
  v_id     uuid;
  v_target text := coalesce(nullif(btrim(p_target), ''), '');
begin
  if not exists (
    select 1 from public.tenant_integrations ti
    where ti.organization_id = p_organization_id
      and ti.company_id = p_company_id
      and ti.provider_code = p_provider_code
      and ti.is_active
  ) then
    raise exception 'INTEGRACION_NO_ACTIVA: % no esta habilitada para esta sociedad', p_provider_code
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.integration_providers p
    where p.code = p_provider_code and p_operation = any (p.capabilities)
  ) then
    raise exception 'OPERACION_NO_SOPORTADA: % no implementa %', p_provider_code, p_operation
      using errcode = '22023';
  end if;

  insert into public.integration_outbox
    (organization_id, company_id, provider_code, operation, payload, idempotency_key, target)
  values
    (p_organization_id, p_company_id, p_provider_code, p_operation,
     coalesce(p_payload, '{}'::jsonb), p_idempotency_key, v_target)
  on conflict (organization_id, company_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select o.id into v_id
    from public.integration_outbox o
    where o.organization_id = p_organization_id
      and o.company_id = p_company_id
      and o.idempotency_key = p_idempotency_key;
  end if;

  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Reclamar, respetando el circuito DEL DESTINO
--
-- El `not exists` mira ahora tambien `c.target = o.target`: un circuito abierto
-- para el destino A no frena los mensajes del destino B.
-- ---------------------------------------------------------------------------
create or replace function public.integration_claim(
  p_provider_code text,
  p_worker        text,
  p_limit         integer default 10
)
returns setof public.integration_outbox
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.integration_circuit c
     set state = 'half_open'
   where c.provider_code = p_provider_code
     and c.state = 'open'
     and c.opened_at + make_interval(secs => c.cooldown_seconds) <= now();

  return query
  with candidatos as (
    select o.id
    from public.integration_outbox o
    where o.provider_code = p_provider_code
      and o.status = 'pending'
      and o.next_retry_at <= now()
      and not exists (
        select 1 from public.integration_circuit c
        where c.organization_id = o.organization_id
          and c.company_id = o.company_id
          and c.provider_code = o.provider_code
          and c.operation = o.operation
          and c.target = o.target
          and c.state = 'open'
      )
    order by o.next_retry_at, o.created_at
    limit greatest(1, least(coalesce(p_limit, 10), 100))
    for update skip locked
  )
  update public.integration_outbox o
     set status = 'in_flight',
         attempts = o.attempts + 1,
         claimed_by = p_worker,
         claimed_at = now()
   from candidatos c
  where o.id = c.id
  returning o.*;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Cerrar el intento con exito, apuntando destino, estado HTTP e hilo
-- ---------------------------------------------------------------------------
drop function if exists public.integration_succeed(uuid, integer);

create function public.integration_succeed(
  p_outbox_id   uuid,
  p_latency_ms  integer default null,
  p_status_code integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.integration_outbox%rowtype;
begin
  update public.integration_outbox
     set status = 'succeeded', completed_at = now(), last_error = null
   where id = p_outbox_id and status = 'in_flight'
  returning * into v_row;

  if not found then
    raise exception 'MENSAJE_NO_EN_VUELO: % no estaba reclamado', p_outbox_id
      using errcode = '22023';
  end if;

  insert into public.integration_messages
    (organization_id, company_id, outbox_id, provider_code, operation, attempt,
     succeeded, latency_ms, target, status_code, correlation_id)
  values
    (v_row.organization_id, v_row.company_id, v_row.id, v_row.provider_code,
     v_row.operation, v_row.attempts, true, p_latency_ms, v_row.target,
     p_status_code, v_row.correlation_id);

  insert into public.integration_circuit
    (organization_id, company_id, provider_code, operation, target, state, consecutive_fail)
  values (v_row.organization_id, v_row.company_id, v_row.provider_code,
          v_row.operation, v_row.target, 'closed', 0)
  on conflict (organization_id, company_id, provider_code, operation, target)
  do update set state = 'closed', consecutive_fail = 0, opened_at = null;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Cerrar el intento con fallo. Mismo backoff, mismo jitter, mismo umbral;
--    lo unico que cambia es que el disyuntor cuenta por DESTINO.
-- ---------------------------------------------------------------------------
drop function if exists public.integration_fail(uuid, text);

create function public.integration_fail(
  p_outbox_id   uuid,
  p_error       text,
  p_status_code integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row     public.integration_outbox%rowtype;
  v_circuit public.integration_circuit%rowtype;
  v_delay   numeric;
begin
  select * into v_row from public.integration_outbox where id = p_outbox_id and status = 'in_flight';
  if not found then
    raise exception 'MENSAJE_NO_EN_VUELO: % no estaba reclamado', p_outbox_id
      using errcode = '22023';
  end if;

  insert into public.integration_messages
    (organization_id, company_id, outbox_id, provider_code, operation, attempt,
     succeeded, error, target, status_code, correlation_id)
  values
    (v_row.organization_id, v_row.company_id, v_row.id, v_row.provider_code,
     v_row.operation, v_row.attempts, false, left(coalesce(p_error, ''), 2000),
     v_row.target, p_status_code, v_row.correlation_id);

  if v_row.attempts >= v_row.max_attempts then
    update public.integration_outbox
       set status = 'dead', completed_at = now(), last_error = left(coalesce(p_error, ''), 2000)
     where id = p_outbox_id;
  else
    v_delay := least(power(2, v_row.attempts)::numeric, 3600) * (0.5 + random());
    update public.integration_outbox
       set status = 'pending',
           next_retry_at = now() + make_interval(secs => v_delay),
           claimed_by = null,
           claimed_at = null,
           last_error = left(coalesce(p_error, ''), 2000)
     where id = p_outbox_id;
  end if;

  insert into public.integration_circuit
    (organization_id, company_id, provider_code, operation, target, consecutive_fail)
  values (v_row.organization_id, v_row.company_id, v_row.provider_code,
          v_row.operation, v_row.target, 1)
  on conflict (organization_id, company_id, provider_code, operation, target)
  do update set consecutive_fail = public.integration_circuit.consecutive_fail + 1
  returning * into v_circuit;

  if v_circuit.consecutive_fail >= v_circuit.threshold and v_circuit.state <> 'open' then
    update public.integration_circuit
       set state = 'open', opened_at = now()
     where id = v_circuit.id;
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Permisos: exactamente los mismos de P12. Solo el servidor mueve la cola.
-- ---------------------------------------------------------------------------
revoke execute on function
  public.integration_enqueue(uuid, uuid, text, text, jsonb, text, text),
  public.integration_claim(text, text, integer),
  public.integration_succeed(uuid, integer, integer),
  public.integration_fail(uuid, text, integer)
from public, anon, authenticated;

grant execute on function
  public.integration_enqueue(uuid, uuid, text, text, jsonb, text, text),
  public.integration_claim(text, text, integer),
  public.integration_succeed(uuid, integer, integer),
  public.integration_fail(uuid, text, integer)
to service_role;

comment on column public.integration_outbox.target is
  'Destino CONCRETO dentro del proveedor (p. ej. el endpoint de webhook). Cadena vacia = el proveedor entero, que es el comportamiento de P12.';
comment on column public.integration_circuit.target is
  'El disyuntor es POR destino: un endpoint roto no puede cortar la entrega a los endpoints sanos del mismo tenant.';
comment on column public.integration_messages.status_code is
  'Codigo HTTP del intento. El CUERPO de la respuesta no se guarda: lo escribe un tercero y acaba trayendo datos de terceros dentro.';
