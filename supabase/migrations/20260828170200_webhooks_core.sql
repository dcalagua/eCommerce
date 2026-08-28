-- =============================================================================
-- P14-SaaS · 3/7 — Webhooks salientes: suscripcion, entrega y reproduccion
--
-- ## La decision central: un webhook ES un mensaje del outbox
--
-- No hay cola de webhooks. Hay `integration_outbox` con `provider_code =
-- 'webhook'` y `target = <id del endpoint>`, exactamente el mismo transporte
-- que entrega a un ERP o a una pasarela. De ahi salen gratis, y sin escribirlas
-- otra vez, las seis propiedades que la fase pide: idempotencia por clave,
-- reintentos con backoff exponencial y jitter, cola muerta al agotar intentos,
-- disyuntor (ahora POR endpoint, gracias a `target`), bitacora append-only de
-- cada intento y visibilidad en el monitor.
--
-- Lo que estas tres tablas anaden es lo UNICO que el transporte no sabe:
--
--   · `webhook_endpoints`      a que URL, con que secreto y con que version;
--   · `webhook_subscriptions`  que eventos quiere ese endpoint;
--   · `webhook_deliveries`     la IDENTIDAD del evento entregado, que es lo que
--                              permite al receptor deduplicar y a nosotros
--                              reproducir sin duplicar.
--
-- ## Por que la identidad del evento es `domain_events.id` y no un uuid nuevo
--
-- Porque `domain_events` ya es idempotente por `dedupe_key`: republicar el
-- mismo hecho devuelve la fila que existe y no inserta otra. Si el id del
-- evento del webhook fuera nuevo en cada intento de publicacion, un reintento
-- del checkout entregaria «pedido creado» dos veces con dos identidades
-- distintas y el receptor no tendria forma de saber que es el mismo hecho.
-- Colgando la identidad del hecho de dominio, la deduplicacion del receptor
-- funciona por construccion y no por disciplina.
--
-- Y por eso la REPRODUCCION conserva el `event_id`: reproducir es «vuelve a
-- intentar entregarme ESTE hecho», no «invéntate uno nuevo». El receptor que
-- deduplica correctamente lo descarta; el que perdio el mensaje lo procesa. Las
-- dos son la respuesta correcta y ninguna depende de nosotros.
--
-- ## Por que el fan-out NO puede levantar una excepcion
--
-- Cuelga de un trigger `after insert` sobre `domain_events`, y `domain_events`
-- se escribe DENTRO de la transaccion del pedido (P07). Una excepcion aqui
-- tumbaria la venta. Un webhook no entregado es un incidente; una venta perdida
-- porque el endpoint del cliente estaba mal escrito es un desastre. Cada
-- encolado va en su propio bloque de excepcion y lo que falla se registra en
-- `ops_events`, que es donde el monitor lo enseña.
--
-- ## HTTPS y direcciones privadas: se rechazan en la BASE
--
-- El CHECK de la URL exige `https://` y rechaza localhost, enlace-local y los
-- tres rangos privados de RFC 1918. Es defensa en profundidad contra SSRF: el
-- trabajador que entrega corre con credenciales de servidor y dentro de la red
-- del proyecto, asi que un endpoint apuntando a `http://169.254.169.254/` seria
-- una forma de pedirnos que leamos metadatos de la instancia y se los mandemos
-- firmados. La comprobacion vive en la base y no solo en el borde porque el
-- borde se puede desplegar mal; un CHECK, no.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- El conector, en el catalogo GLOBAL del producto. `event.publish` es su unica
-- operacion canonica: la plataforma publica un HECHO y el endpoint del cliente
-- decide que hacer con el. Ningun nombre de sistema receptor aparece aqui.
-- ---------------------------------------------------------------------------
insert into public.integration_providers (code, kind, name, capabilities) values
  ('webhook', 'webhook', 'Webhooks salientes', '{event.publish}')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- webhook_endpoints — a donde entrega esta sociedad
-- ---------------------------------------------------------------------------
create table public.webhook_endpoints (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  -- Opcional: hay integraciones de toda la sociedad y otras de una tienda.
  store_id        uuid,
  -- Nombre ESTABLE y legible. Es lo que se pinta en el monitor junto al
  -- destino; sin el, la cola enseñaria uuids y nadie sabria cual endpoint es.
  name            text        not null,
  url             text        not null,
  -- REFERENCIA al secreto de firma en el vault del despliegue, jamas el
  -- secreto. Mismo formato y misma razon que `tenant_integrations.secret_ref`:
  -- una tabla con secretos dentro es una filtracion esperando un select.
  secret_ref      text        not null,
  -- Version del contrato de evento que este endpoint entiende. Un receptor no
  -- se actualiza el dia que nosotros publicamos: sin esto, cambiar la forma de
  -- un evento rompe a todos los suscriptores a la vez.
  api_version     text        not null default 'v1',
  description     text,
  is_active       boolean     not null default true,
  max_attempts    integer     not null default 6,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint webhook_endpoints_name_fmt
    check (name ~ '^[a-z0-9][a-z0-9_-]{1,60}$'),
  constraint webhook_endpoints_secret_ref_fmt
    check (secret_ref ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  constraint webhook_endpoints_version_fmt
    check (api_version ~ '^v[0-9]{1,3}$'),
  constraint webhook_endpoints_url_https
    check (url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?(/[^\s]*)?$'),
  -- Defensa contra SSRF, en la base. Los rangos son los de RFC 1918, el
  -- enlace-local de RFC 3927 (de donde cuelgan los metadatos de instancia de
  -- todo proveedor de nube) y el bucle local.
  constraint webhook_endpoints_url_public
    check (url !~* '^https://(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[)'
       and url !~* '^https://[A-Za-z0-9.-]*\.(local|internal|localdomain)([:/]|$)'),
  constraint webhook_endpoints_url_len
    check (char_length(url) between 12 and 500),
  constraint webhook_endpoints_desc_len
    check (description is null or char_length(description) <= 300),
  constraint webhook_endpoints_attempts
    check (max_attempts between 1 and 20),
  constraint webhook_endpoints_unique
    unique (organization_id, company_id, name),
  -- Clave de apoyo para que los hijos no puedan declarar otro tenant.
  constraint webhook_endpoints_tenant_key
    unique (id, organization_id, company_id),
  constraint webhook_endpoints_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index webhook_endpoints_tenant_idx
  on public.webhook_endpoints (organization_id, company_id);
create index webhook_endpoints_active_idx
  on public.webhook_endpoints (organization_id, company_id) where is_active;

-- ---------------------------------------------------------------------------
-- webhook_subscriptions — que eventos quiere cada endpoint
--
-- El comodin es de SEGUNDO nivel (`order.*`) o total (`*`). No se admite
-- `*.created`: suscribirse a «lo que se cree en cualquier dominio» es como se
-- acaba entregando el ciclo de vida entero del sistema a un endpoint que solo
-- queria saber de pedidos.
-- ---------------------------------------------------------------------------
create table public.webhook_subscriptions (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  endpoint_id     uuid        not null,
  event_type      text        not null,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint webhook_subscriptions_type_fmt
    check (event_type = '*' or event_type ~ '^[a-z][a-z0-9_]*\.([a-z][a-z0-9_]*|\*)$'),
  constraint webhook_subscriptions_unique unique (endpoint_id, event_type),
  constraint webhook_subscriptions_endpoint_fk
    foreign key (endpoint_id, organization_id, company_id)
    references public.webhook_endpoints (id, organization_id, company_id) on delete cascade
);

create index webhook_subscriptions_tenant_idx
  on public.webhook_subscriptions (organization_id, company_id);
create index webhook_subscriptions_type_idx
  on public.webhook_subscriptions (organization_id, company_id, event_type) where is_active;

-- ---------------------------------------------------------------------------
-- webhook_deliveries — la identidad de lo entregado
--
-- No guarda el payload ni el resultado: eso ya vive en `integration_outbox`
-- (el mensaje) y en `integration_messages` (cada intento, con su codigo HTTP y
-- su hilo). Duplicarlo aqui crearia una segunda verdad que se desincroniza el
-- primer dia. Lo que esta tabla APORTA es el vinculo evento ↔ endpoint y la
-- cadena de reproducciones.
-- ---------------------------------------------------------------------------
create table public.webhook_deliveries (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  endpoint_id     uuid        not null,
  -- IDENTIDAD del evento. Se conserva en cada reproduccion: es lo que permite
  -- al receptor deduplicar.
  event_id        uuid        not null,
  event_type      text        not null,
  outbox_id       uuid references public.integration_outbox (id) on delete set null,
  -- Reproduccion: de que entrega es repeticion, quien la ordeno y por que.
  replay_of       uuid references public.webhook_deliveries (id) on delete set null,
  replayed_by     uuid,
  replay_reason   text,
  correlation_id  text        default ebim.correlation_id(),
  created_at      timestamptz not null default now(),

  constraint webhook_deliveries_type_fmt
    check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint webhook_deliveries_reason_len
    check (replay_reason is null or char_length(btrim(replay_reason)) between 3 and 300),
  -- Una reproduccion sin autor, o un autor sin reproduccion, son filas que
  -- mienten sobre quien ordeno reenviar datos a un tercero.
  constraint webhook_deliveries_replay_shape
    check ((replay_of is null and replayed_by is null and replay_reason is null)
        or (replay_of is not null and replayed_by is not null and replay_reason is not null)),
  constraint webhook_deliveries_correlation_fmt
    check (correlation_id is null or correlation_id ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  constraint webhook_deliveries_endpoint_fk
    foreign key (endpoint_id, organization_id, company_id)
    references public.webhook_endpoints (id, organization_id, company_id) on delete cascade
);

create index webhook_deliveries_tenant_idx
  on public.webhook_deliveries (organization_id, company_id, created_at desc);
create index webhook_deliveries_endpoint_idx
  on public.webhook_deliveries (endpoint_id, created_at desc);
create index webhook_deliveries_event_idx
  on public.webhook_deliveries (event_id);

-- UNA entrega original por (endpoint, evento). Las reproducciones quedan fuera
-- del indice a proposito: si entraran, reproducir seria imposible.
create unique index webhook_deliveries_once
  on public.webhook_deliveries (endpoint_id, event_id) where replay_of is null;

-- ---------------------------------------------------------------------------
-- Al dar de alta un endpoint, el transporte queda habilitado para la sociedad.
--
-- `integration_enqueue` exige que el proveedor este ACTIVO en
-- `tenant_integrations` (regla de P12, y es la correcta: nadie entrega a un
-- sistema que la sociedad no habilito). Pedirle a quien crea un endpoint que
-- ademas se acuerde de habilitar «webhook» en otra pantalla es un paso que se
-- olvida y que se manifiesta como «mi webhook no llega» sin ninguna pista.
-- Crear el endpoint ES habilitar el transporte.
--
-- `do nothing` y no `do update`: si un administrador desactivo el transporte a
-- proposito, crear un endpoint nuevo NO lo vuelve a encender a sus espaldas.
-- ---------------------------------------------------------------------------
create or replace function ebim.webhook_enable_transport()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.tenant_integrations
    (organization_id, company_id, provider_code, direction, is_active)
  values (new.organization_id, new.company_id, 'webhook', 'outbound', true)
  on conflict (organization_id, company_id, provider_code) do nothing;
  return new;
end;
$fn$;

create trigger webhook_endpoints_enable_transport
  before insert on public.webhook_endpoints
  for each row execute function ebim.webhook_enable_transport();

-- ---------------------------------------------------------------------------
-- ebim.webhook_matches — ¿la suscripcion cubre este tipo de evento?
--
-- Funcion y no un `like` incrustado: la regla del comodin se escribe una vez y
-- la usan el fan-out, el monitor y los tests. Un `like` repetido en tres sitios
-- se convierte en tres reglas distintas.
-- ---------------------------------------------------------------------------
create or replace function ebim.webhook_matches(p_pattern text, p_event_type text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select p_pattern = '*'
      or p_pattern = p_event_type
      or (right(p_pattern, 2) = '.*'
          and split_part(p_event_type, '.', 1) = left(p_pattern, length(p_pattern) - 2));
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.webhook_fanout — de UN hecho a N mensajes del outbox
--
-- Devuelve cuantas entregas encolo. Nunca levanta: ver la cabecera del archivo.
-- ---------------------------------------------------------------------------
create or replace function ebim.webhook_fanout(
  p_organization_id uuid,
  p_company_id      uuid,
  p_event_id        uuid,
  p_event_type      text,
  p_payload         jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_endpoint  record;
  v_delivery  uuid;
  v_outbox    uuid;
  v_count     integer := 0;
  v_body      jsonb;
begin
  -- Transporte no habilitado para la sociedad: no hay nada que entregar y no
  -- es un error. Es exactamente lo que pasa hoy en todo tenant sin webhooks.
  if not exists (
    select 1 from public.tenant_integrations ti
    where ti.organization_id = p_organization_id
      and ti.company_id      = p_company_id
      and ti.provider_code   = 'webhook'
      and ti.is_active
  ) then
    return 0;
  end if;

  -- El cuerpo pasa por la redaccion de datos de TARJETA (P09) antes de salir
  -- del sistema. Los datos de contacto NO se redactan: el receptor es el
  -- sistema del propio tenant y un pedido sin correo del comprador no sirve
  -- para nada. Un PAN, en cambio, no tiene ninguna razon legitima para viajar.
  v_body := ebim.redact_sensitive(coalesce(p_payload, '{}'::jsonb));

  for v_endpoint in
    select distinct e.id, e.max_attempts
    from public.webhook_endpoints e
    join public.webhook_subscriptions s
      on s.endpoint_id = e.id and s.is_active
    where e.organization_id = p_organization_id
      and e.company_id      = p_company_id
      and e.is_active
      and ebim.webhook_matches(s.event_type, p_event_type)
  loop
    begin
      insert into public.webhook_deliveries
        (organization_id, company_id, endpoint_id, event_id, event_type)
      values (p_organization_id, p_company_id, v_endpoint.id, p_event_id, p_event_type)
      on conflict do nothing
      returning id into v_delivery;

      -- Ya habia una entrega original para este endpoint y este evento: el
      -- hecho se republico (misma `dedupe_key`) y no se entrega dos veces.
      if v_delivery is null then
        continue;
      end if;

      v_outbox := public.integration_enqueue(
        p_organization_id,
        p_company_id,
        'webhook',
        'event.publish',
        jsonb_build_object(
          'event_id',    p_event_id,
          'event_type',  p_event_type,
          'delivery_id', v_delivery,
          'occurred_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'data',        v_body),
        'wh:' || v_delivery::text,
        v_endpoint.id::text);

      update public.webhook_deliveries set outbox_id = v_outbox where id = v_delivery;
      update public.integration_outbox
         set max_attempts = v_endpoint.max_attempts
       where id = v_outbox;

      v_count := v_count + 1;
    exception when others then
      -- Un webhook que no se pudo encolar NO puede tumbar la venta que lo
      -- origino. Queda como incidente, que es donde el monitor lo enseña.
      perform ebim.record_ops_event(
        p_organization_id, p_company_id,
        'integration_failed', 'WEBHOOK_NO_ENCOLADO',
        'wh-enqueue:' || v_endpoint.id::text || ':' || p_event_id::text,
        'error',
        'No se pudo encolar la entrega del evento ' || p_event_type,
        'db', 'event.publish', null, 'webhook_endpoint', v_endpoint.id);
    end;
  end loop;

  return v_count;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- El puente: todo hecho de dominio publicado se reparte a quien lo pidio.
--
-- `after insert` y no `after insert or update`: `domain_events` se actualiza en
-- cada intento de proceso (estado, intentos, error) y repartir en cada uno
-- entregaria el mismo hecho una vez por reintento del OTRO consumidor.
-- ---------------------------------------------------------------------------
create or replace function ebim.webhook_on_domain_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform ebim.webhook_fanout(
    new.organization_id, new.company_id, new.id, new.event_type, new.payload);
  return null;
end;
$fn$;

create trigger domain_events_webhook_fanout
  after insert on public.domain_events
  for each row execute function ebim.webhook_on_domain_event();

-- ---------------------------------------------------------------------------
-- ebim.assert_integrations_enterprise — la puerta del modulo vendible
--
-- Misma forma que `ebim.assert_analytics_advanced` (P13) y por la misma razon:
-- levanta `SIN_MODULO` en vez de devolver vacio, porque «no hay endpoints» y
-- «no lo tienes contratado» son dos incidencias distintas para quien da
-- soporte.
--
-- El MONITOR no pasa por aqui: ver por que fallan tus integraciones es
-- observabilidad y no se vende (decision de P13, area de plataforma). Lo que se
-- vende es PUBLICAR: endpoints, suscripciones y credenciales de API.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_integrations_enterprise()
returns void
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_org     uuid := ebim.org_id();
  v_company uuid := ebim.active_company();
begin
  if v_org is null or v_company is null then
    raise exception 'SIN_PERMISO: el token no trae la jerarquia de tenant'
      using errcode = '42501';
  end if;
  if not ebim.has_capability(v_org, v_company, 'integrations.enterprise') then
    raise exception 'SIN_MODULO: las integraciones empresariales no estan activas para esta sociedad'
      using errcode = '42501';
  end if;
end;
$fn$;

revoke execute on function ebim.assert_integrations_enterprise() from public;
grant  execute on function ebim.assert_integrations_enterprise() to authenticated, service_role;

revoke execute on function ebim.webhook_matches(text, text) from public;
grant  execute on function ebim.webhook_matches(text, text) to authenticated, service_role;

revoke execute on function
  ebim.webhook_fanout(uuid, uuid, uuid, text, jsonb),
  ebim.webhook_enable_transport(),
  ebim.webhook_on_domain_event()
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.webhook_replay — reproducir una entrega, con permiso y con firma
--
-- Tres cosas pasan juntas y por eso es un comando y no un INSERT con policy:
-- se autoriza (rol Y modulo), se conserva la IDENTIDAD del evento y se registra
-- quien lo ordeno y por que. Reenviar datos de negocio a un tercero es una
-- accion que tiene que tener nombre y apellido en la bitacora.
-- ---------------------------------------------------------------------------
create or replace function public.webhook_replay(
  p_delivery_id uuid,
  p_reason      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_src      public.webhook_deliveries%rowtype;
  v_endpoint public.webhook_endpoints%rowtype;
  v_payload  jsonb;
  v_new      uuid;
  v_outbox   uuid;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'MOTIVO_REQUERIDO: una reproduccion sin motivo no se puede auditar'
      using errcode = '22023';
  end if;

  select * into v_src from public.webhook_deliveries where id = p_delivery_id;
  if not found then
    raise exception 'ENTREGA_NO_ENCONTRADA: no existe esa entrega'
      using errcode = '22023';
  end if;

  if not ebim.has_role(v_src.organization_id, v_src.company_id,
                       array['owner','admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: reproducir una entrega es cosa del propietario o un administrador'
      using errcode = '42501';
  end if;

  if not ebim.has_capability(v_src.organization_id, v_src.company_id, 'integrations.enterprise') then
    raise exception 'SIN_MODULO: las integraciones empresariales no estan activas para esta sociedad'
      using errcode = '42501';
  end if;

  select * into v_endpoint from public.webhook_endpoints where id = v_src.endpoint_id;
  if not found or not v_endpoint.is_active then
    raise exception 'ENDPOINT_INACTIVO: el destino de esa entrega esta desactivado'
      using errcode = '22023';
  end if;

  -- El cuerpo sale del mensaje original: reproducir es reenviar LO MISMO, no
  -- recomponer el hecho con el estado de hoy. Si el mensaje ya no existe, se
  -- reconstruye desde el hecho de dominio, que es la fuente.
  select o.payload into v_payload
  from public.integration_outbox o
  where o.id = v_src.outbox_id;

  if v_payload is null then
    select jsonb_build_object(
             'event_id',   d.id,
             'event_type', d.event_type,
             'occurred_at', to_char(d.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'data',       ebim.redact_sensitive(d.payload))
      into v_payload
      from public.domain_events d
     where d.id = v_src.event_id;
  end if;

  if v_payload is null then
    raise exception 'EVENTO_NO_DISPONIBLE: el contenido original ya no esta disponible'
      using errcode = '22023';
  end if;

  insert into public.webhook_deliveries
    (organization_id, company_id, endpoint_id, event_id, event_type,
     replay_of, replayed_by, replay_reason)
  values (v_src.organization_id, v_src.company_id, v_src.endpoint_id,
          v_src.event_id, v_src.event_type, v_src.id, ebim.user_id(), v_reason)
  returning id into v_new;

  -- Clave de idempotencia NUEVA (es un mensaje nuevo) con el `event_id`
  -- INTACTO dentro del cuerpo: el receptor que deduplica lo descarta y el que
  -- lo perdio lo procesa. Las dos son correctas.
  v_outbox := public.integration_enqueue(
    v_src.organization_id, v_src.company_id, 'webhook', 'event.publish',
    v_payload || jsonb_build_object('delivery_id', v_new, 'replay_of', v_src.id),
    'wh:' || v_new::text,
    v_src.endpoint_id::text);

  update public.webhook_deliveries set outbox_id = v_outbox where id = v_new;

  perform ebim.audit(
    p_organization_id => v_src.organization_id,
    p_company_id      => v_src.company_id,
    p_action          => 'webhook_delivery.replayed',
    p_entity_type     => 'webhook_delivery',
    p_entity_id       => v_new,
    p_entity_label    => v_endpoint.name,
    p_metadata        => jsonb_build_object(
                           'replay_of',  v_src.id,
                           'event_id',   v_src.event_id,
                           'event_type', v_src.event_type,
                           'reason',     v_reason));

  return jsonb_build_object('delivery_id', v_new, 'outbox_id', v_outbox,
                            'event_id', v_src.event_id);
end;
$fn$;

revoke execute on function public.webhook_replay(uuid, text) from public, anon;
grant  execute on function public.webhook_replay(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS — default deny. Nada de esto lo toca `anon` jamas.
-- ---------------------------------------------------------------------------
alter table public.webhook_endpoints     enable row level security;
alter table public.webhook_endpoints     force  row level security;
alter table public.webhook_subscriptions enable row level security;
alter table public.webhook_subscriptions force  row level security;
alter table public.webhook_deliveries    enable row level security;
alter table public.webhook_deliveries    force  row level security;

revoke all on public.webhook_endpoints, public.webhook_subscriptions,
              public.webhook_deliveries
  from public, anon, authenticated;

grant all on public.webhook_endpoints, public.webhook_subscriptions,
             public.webhook_deliveries
  to service_role;

-- Leer: cualquier miembro de la sociedad. Es lo que hace visible el monitor.
grant select on public.webhook_endpoints     to authenticated;
grant select on public.webhook_subscriptions to authenticated;
grant select on public.webhook_deliveries    to authenticated;

-- Escribir endpoints y suscripciones: rol Y modulo. Las ENTREGAS no se
-- escriben a mano por nadie: las escribe el fan-out o el comando de
-- reproduccion, dentro de su transaccion.
grant insert, update, delete on public.webhook_endpoints     to authenticated;
grant insert, update, delete on public.webhook_subscriptions to authenticated;

create policy webhook_endpoints_select_member on public.webhook_endpoints
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy webhook_endpoints_insert_admin on public.webhook_endpoints
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
              and ebim.has_capability(organization_id, company_id, 'integrations.enterprise'));

create policy webhook_endpoints_update_admin on public.webhook_endpoints
  for update to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
              and ebim.has_capability(organization_id, company_id, 'integrations.enterprise'))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
              and ebim.has_capability(organization_id, company_id, 'integrations.enterprise'));

create policy webhook_endpoints_delete_admin on public.webhook_endpoints
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy webhook_subscriptions_select_member on public.webhook_subscriptions
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy webhook_subscriptions_insert_admin on public.webhook_subscriptions
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
              and ebim.has_capability(organization_id, company_id, 'integrations.enterprise'));

create policy webhook_subscriptions_update_admin on public.webhook_subscriptions
  for update to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
              and ebim.has_capability(organization_id, company_id, 'integrations.enterprise'))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
              and ebim.has_capability(organization_id, company_id, 'integrations.enterprise'));

create policy webhook_subscriptions_delete_admin on public.webhook_subscriptions
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy webhook_deliveries_select_member on public.webhook_deliveries
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create trigger webhook_endpoints_updated_at before update on public.webhook_endpoints
  for each row execute function ebim.set_updated_at();
create trigger webhook_subscriptions_updated_at before update on public.webhook_subscriptions
  for each row execute function ebim.set_updated_at();

-- Bitacora: dar de alta un destino al que salen datos de negocio, cambiarle la
-- URL o cambiarle el secreto son las tres acciones mas sensibles de esta fase.
create trigger webhook_endpoints_audit
  after insert or update or delete on public.webhook_endpoints
  for each row execute function ebim.audit_row('webhook_endpoint', 'name');

create trigger webhook_subscriptions_audit
  after insert or update or delete on public.webhook_subscriptions
  for each row execute function ebim.audit_row('webhook_subscription', 'event_type');

comment on table public.webhook_endpoints is
  'Destino de webhooks de la sociedad. Solo https y solo direcciones publicas: el CHECK es defensa contra SSRF, no cosmetica.';
comment on column public.webhook_endpoints.secret_ref is
  'REFERENCIA al secreto de firma en el vault, nunca el secreto. Quien firma es el trabajador del borde.';
comment on table public.webhook_deliveries is
  'Vinculo evento ↔ endpoint. El payload y los intentos viven en integration_outbox e integration_messages: aqui no se duplican.';
comment on function public.webhook_replay(uuid, text) is
  'Reproduce una entrega conservando el event_id, con rol owner/admin, modulo contratado, motivo obligatorio y registro en la bitacora.';
comment on function ebim.webhook_fanout(uuid, uuid, uuid, text, jsonb) is
  'De un hecho de dominio a N mensajes del outbox. NUNCA levanta: cuelga de la transaccion del pedido.';
