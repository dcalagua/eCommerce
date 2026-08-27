-- =============================================================================
-- P12 · Mecanica del transporte de integraciones
-- 27/27 — Encolar idempotente, reclamar sin entregar dos veces, backoff
--         exponencial y disyuntor. Todo en la base y no en el worker: un worker
--         se cae a mitad, se despliega dos veces o se invoca desde otro sitio;
--         una transaccion de Postgres, no.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Encolar. Se llama DENTRO de la transaccion del cambio de negocio.
--
-- `security invoker` a proposito: quien encola tiene que poder escribir en el
-- tenant. No es SECURITY DEFINER porque no hay nada que elevar.
-- ---------------------------------------------------------------------------
create or replace function public.integration_enqueue(
  p_organization_id uuid,
  p_company_id      uuid,
  p_provider_code   text,
  p_operation       text,
  p_payload         jsonb,
  p_idempotency_key text
)
returns uuid
language plpgsql
set search_path = ''
as $fn$
declare
  v_id uuid;
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

  -- El proveedor tiene que declarar la operacion. Encolar `order.create` contra
  -- un conector de mensajeria es un error de programacion, y se para aqui en
  -- vez de descubrirse cuando el adaptador no sepa que hacer.
  if not exists (
    select 1 from public.integration_providers p
    where p.code = p_provider_code and p_operation = any (p.capabilities)
  ) then
    raise exception 'OPERACION_NO_SOPORTADA: % no implementa %', p_provider_code, p_operation
      using errcode = '22023';
  end if;

  -- Idempotente de verdad: el segundo intento devuelve el mensaje que ya
  -- existe, no uno nuevo y no un error. Es lo que permite que el llamante
  -- reintente sin pensarlo.
  insert into public.integration_outbox
    (organization_id, company_id, provider_code, operation, payload, idempotency_key)
  values
    (p_organization_id, p_company_id, p_provider_code, p_operation,
     coalesce(p_payload, '{}'::jsonb), p_idempotency_key)
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
-- Reclamar el siguiente mensaje.
--
-- `for update skip locked` es la pieza clave: varios workers en paralelo NO se
-- pisan y ninguno espera al otro. Sin `skip locked`, dos workers se bloquean
-- entre si y el rendimiento se cae; sin `for update`, los dos se llevan el mismo
-- mensaje y SAP recibe el pedido dos veces.
--
-- Respeta el disyuntor: si el circuito esta abierto y no ha pasado el enfriado,
-- no devuelve nada aunque haya mensajes esperando.
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
  -- Enfriado cumplido: el circuito pasa a half_open y deja pasar UN intento.
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
-- Cerrar un intento: exito.
-- ---------------------------------------------------------------------------
create or replace function public.integration_succeed(
  p_outbox_id  uuid,
  p_latency_ms integer default null
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
    (organization_id, company_id, outbox_id, provider_code, operation, attempt, succeeded, latency_ms)
  values
    (v_row.organization_id, v_row.company_id, v_row.id, v_row.provider_code,
     v_row.operation, v_row.attempts, true, p_latency_ms);

  -- Un exito cierra el circuito y borra el historial de fallos: si el sistema
  -- volvio, volvio del todo.
  insert into public.integration_circuit
    (organization_id, company_id, provider_code, operation, state, consecutive_fail)
  values (v_row.organization_id, v_row.company_id, v_row.provider_code, v_row.operation, 'closed', 0)
  on conflict (organization_id, company_id, provider_code, operation)
  do update set state = 'closed', consecutive_fail = 0, opened_at = null;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Cerrar un intento: fallo. Backoff exponencial con jitter y disyuntor.
-- ---------------------------------------------------------------------------
create or replace function public.integration_fail(
  p_outbox_id uuid,
  p_error     text
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
    (organization_id, company_id, outbox_id, provider_code, operation, attempt, succeeded, error)
  values
    (v_row.organization_id, v_row.company_id, v_row.id, v_row.provider_code,
     v_row.operation, v_row.attempts, false, left(coalesce(p_error, ''), 2000));

  if v_row.attempts >= v_row.max_attempts then
    -- Agotado: a la cola muerta. No se reintenta para siempre, porque un
    -- mensaje que nunca va a entrar solo gasta cuota y esconde a los demas.
    update public.integration_outbox
       set status = 'dead', completed_at = now(), last_error = left(coalesce(p_error, ''), 2000)
     where id = p_outbox_id;
  else
    -- Backoff exponencial 2^intento segundos, con jitter: sin el, todos los
    -- mensajes que fallaron a la vez vuelven a la vez y tumban otra vez el
    -- destino justo cuando se estaba recuperando.
    v_delay := least(power(2, v_row.attempts)::numeric, 3600) * (0.5 + random());
    update public.integration_outbox
       set status = 'pending',
           next_retry_at = now() + make_interval(secs => v_delay),
           claimed_by = null,
           claimed_at = null,
           last_error = left(coalesce(p_error, ''), 2000)
     where id = p_outbox_id;
  end if;

  -- Disyuntor por proveedor y operacion.
  insert into public.integration_circuit
    (organization_id, company_id, provider_code, operation, consecutive_fail)
  values (v_row.organization_id, v_row.company_id, v_row.provider_code, v_row.operation, 1)
  on conflict (organization_id, company_id, provider_code, operation)
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
-- Rescate de mensajes huerfanos: un worker que muere deja el mensaje `in_flight`
-- para siempre. Sin esto, cada caida de worker pierde pedidos en silencio.
-- ---------------------------------------------------------------------------
create or replace function public.integration_reclaim_stale(
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
  update public.integration_outbox
     set status = 'pending', claimed_by = null, claimed_at = null,
         next_retry_at = now()
   where status = 'in_flight'
     and claimed_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Solo el servidor mueve la cola. El backoffice la MIRA (grant select del
-- fichero anterior) pero no la toca: una cola que el cliente puede reescribir
-- no garantiza nada.
-- ---------------------------------------------------------------------------
revoke execute on function
  public.integration_enqueue(uuid, uuid, text, text, jsonb, text),
  public.integration_claim(text, text, integer),
  public.integration_succeed(uuid, integer),
  public.integration_fail(uuid, text),
  public.integration_reclaim_stale(interval)
from public, anon, authenticated;

grant execute on function
  public.integration_enqueue(uuid, uuid, text, text, jsonb, text),
  public.integration_claim(text, text, integer),
  public.integration_succeed(uuid, integer),
  public.integration_fail(uuid, text),
  public.integration_reclaim_stale(interval)
to service_role;

comment on function public.integration_enqueue(uuid, uuid, text, text, jsonb, text) is
  'Encola una operacion canonica. Idempotente: el segundo intento devuelve el mensaje existente, no uno nuevo.';
comment on function public.integration_claim(text, text, integer) is
  'Reclama mensajes con for update skip locked: varios workers no se pisan ni se bloquean. Respeta el disyuntor.';
comment on function public.integration_fail(uuid, text) is
  'Backoff exponencial con jitter y disyuntor. Agotados los intentos, el mensaje va a la cola muerta.';
