-- =============================================================================
-- P14-SaaS · 6/7 — El MONITOR de integraciones
--
-- ## Que hace falta para que un fallo sea «visible y recuperable»
--
-- La Definition of Done de la fase pide dos cosas y las dos son operativas, no
-- de modelo: que la operacion de fallos se VEA y que se pueda RECUPERAR. Los
-- datos ya existen desde P12 —outbox, intentos, disyuntor— y aun asi no se ven,
-- porque verlos hoy es escribir cuatro consultas con `join` a mano.
--
-- Lo que falta, y es lo que hay aqui:
--
--   · `integration_monitor`        una fila por mensaje, con TODO lo que hay
--                                  que mirar junto: estado, intentos, proximo
--                                  reintento, hilo, disyuntor y destino con
--                                  nombre legible.
--   · `webhook_monitor`            lo mismo desde el otro eje: por endpoint y
--                                  por evento, con la cadena de reproducciones.
--   · `integration_health()`       el resumen por proveedor: cuanto hay parado,
--                                  cuando fue el ultimo exito, que circuitos
--                                  estan abiertos.
--   · `integration_message_detail` el detalle SANITIZADO de un mensaje.
--   · `integration_retry`          reintentar a mano, con permiso y con firma.
--   · `integration_circuit_reset`  cerrar un disyuntor a mano, idem.
--
-- ## Por que el detalle es una FUNCION y no una columna de la vista
--
-- Porque el payload de un mensaje es lo unico de todo esto que puede llevar
-- datos delicados dentro, y una columna en una vista se lleva en un `select *`
-- —a un CSV, a una captura, a un ticket—. Como funcion se pide de una en una,
-- pasa por `ebim.redact_sensitive` (tarjeta, P09) y por `ebim.redact_pii`
-- (correo, telefono, documento, P13), exige rol, y queda registrada en la
-- bitacora: mirar el contenido de un mensaje es un acto con autor.
--
-- ## Por que reintentar es un comando y no un UPDATE con policy
--
-- `integration_outbox` no tiene —ni tendra— GRANT de escritura para
-- `authenticated`. Una cola que el cliente puede reescribir no garantiza nada:
-- con un UPDATE se podria poner `attempts = 0` en un mensaje muerto y
-- reintentarlo infinitas veces, o marcarlo `succeeded` sin haberlo entregado.
-- El comando hace las tres cosas que van juntas —autorizar, mover el estado y
-- firmar quien lo hizo— y no deja elegir cual de las tres se omite.
--
-- Reintentar CONSERVA `attempts`. Ponerlo a cero seria borrar la unica prueba
-- de que ese mensaje ya fallo seis veces, y es justo el dato que hace falta
-- para decidir si el problema es el destino o el contenido. Lo que hace el
-- reintento manual es dar UN intento mas por encima del techo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- integration_monitor — la cola, mirada de frente
--
-- `security_invoker`: no amplia ni un permiso. Quien no puede leer
-- `integration_outbox` no ve nada aqui, y quien puede ve solo su tenant, por la
-- misma policy de siempre.
-- ---------------------------------------------------------------------------
create or replace view public.integration_monitor
with (security_invoker = on) as
select
  o.id,
  o.organization_id,
  o.company_id,
  o.provider_code,
  p.name                      as provider_name,
  p.kind::text                as provider_kind,
  o.operation,
  o.target,
  -- Nombre legible del destino. Para un webhook es el nombre del endpoint;
  -- para el resto, el proveedor entero. Sin esto la cola enseña uuids.
  coalesce(e.name, p.name)    as target_label,
  o.status::text              as status,
  o.attempts,
  o.max_attempts,
  o.next_retry_at,
  o.claimed_by,
  o.claimed_at,
  o.completed_at,
  o.correlation_id,
  o.created_at,
  o.updated_at,
  -- El error se recorta y pasa por la redaccion de correos: lo escribe nuestro
  -- trabajador, pero un mensaje de error de un destino ajeno acaba llevando
  -- dentro lo que se le mando.
  ebim.redact_text(o.last_error, 300) as last_error,
  coalesce(c.state::text, 'closed')   as circuit_state,
  c.consecutive_fail,
  c.opened_at                 as circuit_opened_at,
  -- La EDAD se calcula en el servidor, nunca en el navegador: con el reloj del
  -- portatil mal puesto, un mensaje de hace diez minutos parece de hace dos
  -- horas — y la respuesta a un incidente se decide justo por eso (P13).
  extract(epoch from (now() - o.created_at))::bigint as age_seconds,
  (o.status in ('pending', 'in_flight'))             as is_open,
  (o.status = 'dead')                                as is_dead,
  (o.status = 'pending' and o.attempts > 0)          as is_retrying
from public.integration_outbox o
join public.integration_providers p on p.code = o.provider_code
left join public.webhook_endpoints e
  on o.target <> '' and e.id::text = o.target
left join public.integration_circuit c
  on c.organization_id = o.organization_id
 and c.company_id      = o.company_id
 and c.provider_code   = o.provider_code
 and c.operation       = o.operation
 and c.target          = o.target;

-- ---------------------------------------------------------------------------
-- webhook_monitor — el mismo mundo por el eje del suscriptor
-- ---------------------------------------------------------------------------
create or replace view public.webhook_monitor
with (security_invoker = on) as
select
  d.id,
  d.organization_id,
  d.company_id,
  d.endpoint_id,
  e.name                as endpoint_name,
  e.url                 as endpoint_url,
  e.is_active           as endpoint_active,
  d.event_id,
  d.event_type,
  d.outbox_id,
  d.replay_of,
  d.replayed_by,
  d.replay_reason,
  (d.replay_of is not null) as is_replay,
  d.correlation_id,
  d.created_at,
  coalesce(o.status::text, 'unknown') as status,
  o.attempts,
  o.max_attempts,
  o.next_retry_at,
  o.completed_at,
  ebim.redact_text(o.last_error, 300) as last_error,
  -- Ultimo codigo HTTP visto. Es lo primero que se mira: un 401 dice «secreto
  -- mal configurado» y un 500 dice «su sistema esta roto», y son dos llamadas
  -- de telefono distintas.
  (select m.status_code
     from public.integration_messages m
    where m.outbox_id = o.id
    order by m.created_at desc
    limit 1)            as last_status_code,
  extract(epoch from (now() - d.created_at))::bigint as age_seconds
from public.webhook_deliveries d
join public.webhook_endpoints e on e.id = d.endpoint_id
left join public.integration_outbox o on o.id = d.outbox_id;

grant select on public.integration_monitor to authenticated;
grant select on public.webhook_monitor     to authenticated;
grant select on public.integration_monitor, public.webhook_monitor to service_role;

-- ---------------------------------------------------------------------------
-- public.integration_health — el resumen por proveedor
--
-- Misma forma y misma autorizacion que `ops_health` (P13): SECURITY DEFINER con
-- el tenant derivado del JWT y sin parametro que declararlo. Rol `owner`/`admin`
-- por dentro, no por policy, porque cuenta filas de cuatro tablas y la cuenta
-- tiene que ser la misma aunque las cuatro policies evolucionen distinto.
-- ---------------------------------------------------------------------------
create or replace function public.integration_health()
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
    raise exception 'SIN_PERMISO: la salud de las integraciones la ve owner o admin'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'organization_id', v_org,
    'company_id',      v_company,
    'generated_at',    now(),
    'providers', coalesce((
      select jsonb_agg(fila order by fila ->> 'provider_code')
      from (
        select jsonb_build_object(
          'provider_code', ti.provider_code,
          'provider_name', p.name,
          'provider_kind', p.kind::text,
          'is_active',     ti.is_active,
          'direction',     ti.direction::text,
          'pending',   (select count(*) from public.integration_outbox o
                         where o.organization_id = v_org and o.company_id = v_company
                           and o.provider_code = ti.provider_code and o.status = 'pending'),
          'in_flight', (select count(*) from public.integration_outbox o
                         where o.organization_id = v_org and o.company_id = v_company
                           and o.provider_code = ti.provider_code and o.status = 'in_flight'),
          'dead',      (select count(*) from public.integration_outbox o
                         where o.organization_id = v_org and o.company_id = v_company
                           and o.provider_code = ti.provider_code and o.status = 'dead'),
          'succeeded_24h', (select count(*) from public.integration_messages m
                             where m.organization_id = v_org and m.company_id = v_company
                               and m.provider_code = ti.provider_code and m.succeeded
                               and m.created_at > now() - interval '24 hours'),
          'failed_24h',    (select count(*) from public.integration_messages m
                             where m.organization_id = v_org and m.company_id = v_company
                               and m.provider_code = ti.provider_code and not m.succeeded
                               and m.created_at > now() - interval '24 hours'),
          'last_success_at', (select max(m.created_at) from public.integration_messages m
                               where m.organization_id = v_org and m.company_id = v_company
                                 and m.provider_code = ti.provider_code and m.succeeded),
          'last_failure_at', (select max(m.created_at) from public.integration_messages m
                               where m.organization_id = v_org and m.company_id = v_company
                                 and m.provider_code = ti.provider_code and not m.succeeded),
          'oldest_pending_seconds', (
            select extract(epoch from (now() - min(o.created_at)))::bigint
              from public.integration_outbox o
             where o.organization_id = v_org and o.company_id = v_company
               and o.provider_code = ti.provider_code and o.status = 'pending'),
          'open_circuits', (select count(*) from public.integration_circuit c
                             where c.organization_id = v_org and c.company_id = v_company
                               and c.provider_code = ti.provider_code and c.state <> 'closed')
        ) as fila
        from public.tenant_integrations ti
        join public.integration_providers p on p.code = ti.provider_code
        where ti.organization_id = v_org and ti.company_id = v_company
      ) filas), '[]'::jsonb),
    'circuits', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',             c.id,
               'provider_code',  c.provider_code,
               'operation',      c.operation,
               'target',         c.target,
               'target_label',   coalesce(e.name, c.provider_code),
               'state',          c.state::text,
               'consecutive_fail', c.consecutive_fail,
               'threshold',      c.threshold,
               'opened_at',      c.opened_at)
             order by c.provider_code, c.operation)
        from public.integration_circuit c
        left join public.webhook_endpoints e on c.target <> '' and e.id::text = c.target
       where c.organization_id = v_org and c.company_id = v_company
         and c.state <> 'closed'), '[]'::jsonb),
    'webhooks', jsonb_build_object(
      'endpoints', (select count(*) from public.webhook_endpoints e
                     where e.organization_id = v_org and e.company_id = v_company),
      'endpoints_active', (select count(*) from public.webhook_endpoints e
                            where e.organization_id = v_org and e.company_id = v_company
                              and e.is_active),
      'subscriptions', (select count(*) from public.webhook_subscriptions s
                         where s.organization_id = v_org and s.company_id = v_company
                           and s.is_active),
      'deliveries_24h', (select count(*) from public.webhook_deliveries d
                          where d.organization_id = v_org and d.company_id = v_company
                            and d.created_at > now() - interval '24 hours')),
    'api', jsonb_build_object(
      'clients',        (select count(*) from public.api_clients c
                          where c.organization_id = v_org and c.company_id = v_company),
      'clients_active', (select count(*) from public.api_clients c
                          where c.organization_id = v_org and c.company_id = v_company
                            and c.is_active),
      'requests_24h',   (select count(*) from public.api_requests r
                          where r.organization_id = v_org and r.company_id = v_company
                            and r.created_at > now() - interval '24 hours'),
      'errors_24h',     (select count(*) from public.api_requests r
                          where r.organization_id = v_org and r.company_id = v_company
                            and r.created_at > now() - interval '24 hours'
                            and coalesce(r.status, 0) >= 400))
  ) into v_result;

  return v_result;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.integration_message_detail — el contenido, sanitizado y con testigo
-- ---------------------------------------------------------------------------
create or replace function public.integration_message_detail(p_outbox_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_row      public.integration_outbox%rowtype;
  v_endpoint public.webhook_endpoints%rowtype;
  v_result   jsonb;
begin
  select * into v_row from public.integration_outbox o where o.id = p_outbox_id;
  if not found then
    raise exception 'MENSAJE_NO_ENCONTRADO: no existe ese mensaje'
      using errcode = '22023';
  end if;

  if not ebim.has_role(v_row.organization_id, v_row.company_id,
                       array['owner', 'admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: el contenido de un mensaje lo ve owner o admin'
      using errcode = '42501';
  end if;

  if v_row.target <> '' then
    select * into v_endpoint from public.webhook_endpoints e where e.id::text = v_row.target;
  end if;

  select jsonb_build_object(
    'id',            v_row.id,
    'provider_code', v_row.provider_code,
    'operation',     v_row.operation,
    'target',        v_row.target,
    'target_label',  v_endpoint.name,
    -- Destino sin la cadena de consulta: una URL con `?token=` dentro es el
    -- secreto que esta pantalla existe para no enseñar.
    'target_url',    split_part(coalesce(v_endpoint.url, ''), '?', 1),
    'status',        v_row.status::text,
    'attempts',      v_row.attempts,
    'max_attempts',  v_row.max_attempts,
    'next_retry_at', v_row.next_retry_at,
    'correlation_id', v_row.correlation_id,
    'created_at',    v_row.created_at,
    'last_error',    ebim.redact_text(v_row.last_error, 1000),
    -- DOS pasadas de redaccion, y las dos hacen falta: la de tarjeta (P09)
    -- tapa PAN y CVV; la de datos personales (P13), correo, telefono,
    -- documento y direccion.
    'payload',       ebim.redact_pii(ebim.redact_sensitive(v_row.payload)),
    'attempts_log', coalesce((
      select jsonb_agg(jsonb_build_object(
               'attempt',     m.attempt,
               'succeeded',   m.succeeded,
               'status_code', m.status_code,
               'latency_ms',  m.latency_ms,
               'error',       ebim.redact_text(m.error, 500),
               'at',          m.created_at)
             order by m.created_at)
        from public.integration_messages m
       where m.outbox_id = v_row.id), '[]'::jsonb)
  ) into v_result;

  -- Mirar el contenido de un mensaje es un ACTO, y la bitacora lo registra. Es
  -- la misma decision que P13 tomo con la exportacion de analitica: lo que se
  -- lleva la gente tambien se audita, no solo lo que cambia.
  perform ebim.audit(
    p_organization_id => v_row.organization_id,
    p_company_id      => v_row.company_id,
    p_action          => 'integration_message.inspected',
    p_entity_type     => 'integration_outbox',
    p_entity_id       => v_row.id,
    p_entity_label    => v_row.operation,
    p_metadata        => jsonb_build_object('provider_code', v_row.provider_code,
                                            'target', v_row.target));

  return v_result;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.integration_retry — un intento mas, ahora, y con nombre
-- ---------------------------------------------------------------------------
create or replace function public.integration_retry(
  p_outbox_id uuid,
  p_reason    text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_row    public.integration_outbox%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'MOTIVO_REQUERIDO: un reintento manual sin motivo no se puede auditar'
      using errcode = '22023';
  end if;

  select * into v_row from public.integration_outbox o where o.id = p_outbox_id;
  if not found then
    raise exception 'MENSAJE_NO_ENCONTRADO: no existe ese mensaje'
      using errcode = '22023';
  end if;

  if not ebim.has_role(v_row.organization_id, v_row.company_id,
                       array['owner', 'admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: reintentar un mensaje es cosa del propietario o un administrador'
      using errcode = '42501';
  end if;

  -- Un mensaje entregado NO se reintenta. Reintentar un exito es entregar dos
  -- veces, y la mitad de las operaciones canonicas de este catalogo no son
  -- idempotentes en el otro extremo.
  if v_row.status = 'succeeded' then
    raise exception 'MENSAJE_YA_ENTREGADO: ese mensaje ya se entrego, no se reintenta'
      using errcode = '22023';
  end if;
  if v_row.status = 'in_flight' then
    raise exception 'MENSAJE_EN_VUELO: ese mensaje se esta entregando ahora mismo'
      using errcode = '22023';
  end if;

  update public.integration_outbox
     set status        = 'pending',
         next_retry_at = now(),
         completed_at  = null,
         claimed_by    = null,
         claimed_at    = null,
         -- Un intento MAS por encima del techo, sin borrar el historico: los
         -- intentos gastados son la prueba de lo que paso.
         max_attempts  = least(20, greatest(v_row.max_attempts, v_row.attempts + 1))
   where id = p_outbox_id
  returning * into v_row;

  -- El disyuntor de ese destino se cierra: quien reintenta a mano esta
  -- afirmando que el destino ya responde. Si no responde, volvera a abrirse
  -- solo, que es exactamente para lo que existe.
  update public.integration_circuit
     set state = 'closed', consecutive_fail = 0, opened_at = null
   where organization_id = v_row.organization_id
     and company_id      = v_row.company_id
     and provider_code   = v_row.provider_code
     and operation       = v_row.operation
     and target          = v_row.target;

  perform ebim.audit(
    p_organization_id => v_row.organization_id,
    p_company_id      => v_row.company_id,
    p_action          => 'integration_message.retried',
    p_entity_type     => 'integration_outbox',
    p_entity_id       => v_row.id,
    p_entity_label    => v_row.operation,
    p_metadata        => jsonb_build_object('provider_code', v_row.provider_code,
                                            'target', v_row.target,
                                            'attempts', v_row.attempts,
                                            'reason', v_reason));

  return jsonb_build_object('id', v_row.id, 'status', v_row.status,
                            'attempts', v_row.attempts,
                            'max_attempts', v_row.max_attempts);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.integration_circuit_reset — cerrar el disyuntor a mano
-- ---------------------------------------------------------------------------
create or replace function public.integration_circuit_reset(
  p_circuit_id uuid,
  p_reason     text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_row    public.integration_circuit%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'MOTIVO_REQUERIDO: cerrar un disyuntor a mano exige decir por que'
      using errcode = '22023';
  end if;

  select * into v_row from public.integration_circuit c where c.id = p_circuit_id;
  if not found then
    raise exception 'CIRCUITO_NO_ENCONTRADO: no existe ese disyuntor'
      using errcode = '22023';
  end if;

  if not ebim.has_role(v_row.organization_id, v_row.company_id,
                       array['owner', 'admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: cerrar un disyuntor es cosa del propietario o un administrador'
      using errcode = '42501';
  end if;

  update public.integration_circuit
     set state = 'closed', consecutive_fail = 0, opened_at = null
   where id = p_circuit_id;

  perform ebim.audit(
    p_organization_id => v_row.organization_id,
    p_company_id      => v_row.company_id,
    p_action          => 'integration_circuit.reset',
    p_entity_type     => 'integration_circuit',
    p_entity_id       => v_row.id,
    p_entity_label    => v_row.provider_code || ':' || v_row.operation,
    p_metadata        => jsonb_build_object('target', v_row.target, 'reason', v_reason));

  return jsonb_build_object('id', v_row.id, 'state', 'closed');
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Permisos. Las tres funciones llegan con el JWT del usuario y comprueban rol
-- por dentro; `anon` no puede rozarlas.
-- ---------------------------------------------------------------------------
revoke execute on function
  public.integration_health(),
  public.integration_message_detail(uuid),
  public.integration_retry(uuid, text),
  public.integration_circuit_reset(uuid, text)
from public, anon;

grant execute on function
  public.integration_health(),
  public.integration_message_detail(uuid),
  public.integration_retry(uuid, text),
  public.integration_circuit_reset(uuid, text)
to authenticated, service_role;

comment on view public.integration_monitor is
  'La cola de integraciones con todo lo que hay que mirar junto. security_invoker: no amplia ni un permiso.';
comment on function public.integration_message_detail(uuid) is
  'Contenido de un mensaje con doble redaccion (tarjeta y datos personales), rol owner/admin y registro en la bitacora: mirarlo es un acto con autor.';
comment on function public.integration_retry(uuid, text) is
  'Reintento manual. Conserva los intentos gastados —son la prueba— y da uno mas por encima del techo. Un mensaje ya entregado no se reintenta.';
