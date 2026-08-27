-- =============================================================================
-- P12 · Framework de integraciones (F0 · cimientos)
-- 26/26 — Cubre 4.1.3-a y 4.1.3-b del RFP, y sostiene los adaptadores SAP, de
--         pagos, de facturacion, de logistica y de mensajeria.
--
-- La idea que ahorra la mitad del trabajo: integraciones y pagos son la MISMA
-- forma. El tenant habilita un proveedor, la plataforma habla un contrato
-- canonico, un adaptador traduce, el outbox entrega con reintentos y todo queda
-- auditado. SAP no es un modulo: es un adaptador del contrato `erp`. Libelula
-- lo es del contrato `payment`. GusuSoft, del de `invoicing`.
--
-- Por que importa para el pliego: AA0004 exige que la personalizacion sea
-- «mediante configuracion, no modificacion de codigo» y no supere el 20 % del
-- core. Con adaptadores la respuesta es «0 % de codigo a medida: SAP es un
-- conector del catalogo estandar». Y 4.1.3-b —preparado para S/4HANA sin
-- reimplementar— se cumple por diseno: migrar es cambiar el adaptador, porque el
-- nombre `BAPI_SALESORDER_CREATEFROMDAT2` no aparece en ninguna otra parte.
--
-- El TRANSPORTE vive aqui, en la base, y no en la Edge Function: la funcion
-- puede reintentarse, desplegarse mal o invocarse desde otro sitio, mientras que
-- una transaccion de Postgres no entrega dos veces el mismo mensaje.
-- =============================================================================

create type public.integration_kind as enum
  ('erp', 'payment', 'invoicing', 'logistics', 'messaging', 'identity');

create type public.integration_direction as enum ('outbound', 'inbound', 'bidirectional');

create type public.outbox_status as enum
  ('pending', 'in_flight', 'succeeded', 'failed', 'dead');

create type public.circuit_state as enum ('closed', 'open', 'half_open');

-- ---------------------------------------------------------------------------
-- integration_providers — catalogo GLOBAL del producto, no dato de tenant.
-- Que exista un conector para SAP R/3 es una capacidad del producto, no una
-- preferencia de cliente. Los tenants habilitan un subconjunto.
-- ---------------------------------------------------------------------------
create table public.integration_providers (
  code         text        primary key,
  kind         public.integration_kind not null,
  name         text        not null,
  -- Operaciones canonicas que implementa. La plataforma NUNCA nombra una BAPI:
  -- habla `order.create` y el adaptador sabe que eso es
  -- BAPI_SALESORDER_CREATEFROMDAT2 en R/3 y otra cosa en S/4HANA.
  capabilities text[]      not null default '{}',
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  constraint integration_providers_code_fmt check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint integration_providers_name_len check (char_length(btrim(name)) between 1 and 120)
);

insert into public.integration_providers (code, kind, name, capabilities) values
  ('sap_r3',   'erp',       'SAP R/3',
   '{customer.read,product.read,price.read,stock.read,order.create,order.read,invoice.create}'),
  ('sap_s4',   'erp',       'SAP S/4HANA',
   '{customer.read,product.read,price.read,stock.read,order.create,order.read,invoice.create}'),
  ('gurusoft', 'invoicing', 'GusuSoft',        '{invoice.issue,invoice.read}'),
  ('libelula', 'payment',   'Libélula',        '{payment.authorize,payment.capture,payment.refund}'),
  ('bisa',     'payment',   'Banco Bisa',      '{payment.authorize,payment.capture}'),
  ('bcp',      'payment',   'Banco BCP',       '{payment.authorize,payment.capture}'),
  ('drivein',  'logistics', 'DriveIn',         '{shipment.create,shipment.track}'),
  ('cognos',   'messaging', 'Cognos',          '{message.email,message.sms,message.whatsapp}');

-- ---------------------------------------------------------------------------
-- tenant_integrations — que habilita cada sociedad y con que configuracion.
-- ---------------------------------------------------------------------------
create table public.tenant_integrations (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  provider_code   text        not null references public.integration_providers (code) on delete restrict,
  direction       public.integration_direction not null default 'outbound',
  is_active       boolean     not null default false,
  -- Config NO sensible: endpoints, timeouts, mapeos. Las CREDENCIALES no viven
  -- aqui: solo la REFERENCIA al secreto del vault. Una tabla con contrasenas
  -- dentro es una filtracion esperando a que alguien haga un select.
  config          jsonb       not null default '{}'::jsonb,
  secret_ref      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint tenant_integrations_unique unique (organization_id, company_id, provider_code),
  constraint tenant_integrations_secret_ref_fmt
    check (secret_ref is null or secret_ref ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  -- Una config con pinta de credencial se rechaza en la base, no en la revision
  -- de codigo: es el error que se comete una vez y se paga durante anos.
  constraint tenant_integrations_no_secrets check (
    not (config ?| array['password', 'secret', 'api_key', 'apikey', 'token',
                         'client_secret', 'private_key'])
  )
);

create index tenant_integrations_tenant on public.tenant_integrations (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- integration_outbox — la cola de salida.
--
-- Patron outbox: el mensaje se encola en la MISMA transaccion que el cambio de
-- negocio que lo origina. Si el pedido se crea, su envio a SAP existe; si la
-- transaccion revienta, no queda ni pedido ni mensaje fantasma. Es lo que hace
-- imposible el estado «pedido creado pero SAP nunca se entero».
-- ---------------------------------------------------------------------------
create table public.integration_outbox (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  provider_code   text        not null references public.integration_providers (code) on delete restrict,
  -- Operacion CANONICA (`order.create`), nunca el nombre del sistema destino.
  operation       text        not null,
  payload         jsonb       not null default '{}'::jsonb,
  -- Clave de idempotencia: encolar dos veces la misma operacion sobre la misma
  -- entidad es un solo mensaje. Sin esto, un reintento del llamante duplica el
  -- pedido en SAP.
  idempotency_key text        not null,
  status          public.outbox_status not null default 'pending',
  attempts        integer     not null default 0,
  max_attempts    integer     not null default 6,
  next_retry_at   timestamptz not null default now(),
  last_error      text,
  -- Identifica al trabajador que reclamo el mensaje: si un worker muere sin
  -- completar, se sabe cual y el mensaje puede rescatarse.
  claimed_by      text,
  claimed_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint integration_outbox_operation_fmt check (operation ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint integration_outbox_attempts   check (attempts >= 0 and max_attempts between 1 and 20),
  constraint integration_outbox_idem_len   check (char_length(idempotency_key) between 8 and 200),
  constraint integration_outbox_unique     unique (organization_id, company_id, idempotency_key)
);

create index integration_outbox_tenant on public.integration_outbox (organization_id, company_id);
-- Indice de la ruta caliente: «dame lo siguiente que toca enviar».
create index integration_outbox_due
  on public.integration_outbox (provider_code, next_retry_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- integration_inbox — lo que entra (webhooks, callbacks).
-- Deduplicado por la referencia externa: una pasarela que reintenta su webhook
-- no puede cobrar dos veces.
-- ---------------------------------------------------------------------------
create table public.integration_inbox (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  provider_code   text        not null references public.integration_providers (code) on delete restrict,
  event_type      text        not null,
  external_id     text        not null,
  payload         jsonb       not null default '{}'::jsonb,
  processed_at    timestamptz,
  created_at      timestamptz not null default now(),
  constraint integration_inbox_unique unique (provider_code, external_id)
);

create index integration_inbox_tenant on public.integration_inbox (organization_id, company_id);
create index integration_inbox_pending on public.integration_inbox (created_at) where processed_at is null;

-- ---------------------------------------------------------------------------
-- integration_messages — bitacora append-only de cada intento.
-- Es la «trazabilidad de mensajes» que pide 4.1.3-a literalmente.
-- ---------------------------------------------------------------------------
create table public.integration_messages (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  outbox_id       uuid        references public.integration_outbox (id) on delete set null,
  provider_code   text        not null,
  operation       text        not null,
  attempt         integer     not null,
  succeeded       boolean     not null,
  latency_ms      integer,
  error           text,
  created_at      timestamptz not null default now()
);

create index integration_messages_tenant on public.integration_messages (organization_id, company_id);
create index integration_messages_outbox on public.integration_messages (outbox_id, created_at desc);

-- ---------------------------------------------------------------------------
-- integration_circuit — el disyuntor, por proveedor y operacion.
-- Si SAP esta caido, no tiene sentido lanzarle mil mensajes: se abre el circuito,
-- se deja de intentar durante un tiempo y se prueba con uno solo (half_open).
-- ---------------------------------------------------------------------------
create table public.integration_circuit (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null,
  company_id       uuid        not null,
  provider_code    text        not null,
  operation        text        not null,
  state            public.circuit_state not null default 'closed',
  consecutive_fail integer     not null default 0,
  threshold        integer     not null default 5,
  opened_at        timestamptz,
  cooldown_seconds integer     not null default 60,
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  constraint integration_circuit_unique unique (organization_id, company_id, provider_code, operation),
  constraint integration_circuit_threshold check (threshold between 1 and 100),
  constraint integration_circuit_cooldown  check (cooldown_seconds between 5 and 3600)
);

create index integration_circuit_tenant on public.integration_circuit (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- RLS — default deny. Nada de esto lo toca `anon` jamas.
-- ---------------------------------------------------------------------------
alter table public.integration_providers  enable row level security;
alter table public.integration_providers  force  row level security;
alter table public.tenant_integrations    enable row level security;
alter table public.tenant_integrations    force  row level security;
alter table public.integration_outbox     enable row level security;
alter table public.integration_outbox     force  row level security;
alter table public.integration_inbox      enable row level security;
alter table public.integration_inbox      force  row level security;
alter table public.integration_messages   enable row level security;
alter table public.integration_messages   force  row level security;
alter table public.integration_circuit    enable row level security;
alter table public.integration_circuit    force  row level security;

revoke all on public.integration_providers, public.tenant_integrations,
              public.integration_outbox, public.integration_inbox,
              public.integration_messages, public.integration_circuit
  from public, anon, authenticated;

grant all on public.integration_providers, public.tenant_integrations,
             public.integration_outbox, public.integration_inbox,
             public.integration_messages, public.integration_circuit
  to service_role;

-- El catalogo de conectores lo ve cualquiera con sesion: es lo que se pinta en
-- la pantalla de «integraciones disponibles». Escribirlo, solo el servidor.
grant select on public.integration_providers to authenticated;

-- El backoffice configura sus integraciones y MIRA su cola: el monitor de
-- integraciones es una pantalla que se consulta a diario. Pero la cola no se
-- escribe a mano: la escribe la operacion de negocio dentro de su transaccion.
grant select, insert, update, delete on public.tenant_integrations to authenticated;
grant select on public.integration_outbox    to authenticated;
grant select on public.integration_inbox     to authenticated;
grant select on public.integration_messages  to authenticated;
grant select on public.integration_circuit   to authenticated;

create policy integration_providers_select on public.integration_providers
  for select to authenticated
  using (is_active);

create policy tenant_integrations_select_member on public.tenant_integrations
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy tenant_integrations_insert_admin on public.tenant_integrations
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tenant_integrations_update_admin on public.tenant_integrations
  for update to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tenant_integrations_delete_admin on public.tenant_integrations
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy integration_outbox_select_member on public.integration_outbox
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy integration_inbox_select_member on public.integration_inbox
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy integration_messages_select_member on public.integration_messages
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy integration_circuit_select_member on public.integration_circuit
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create trigger tenant_integrations_updated_at before update on public.tenant_integrations
  for each row execute function ebim.set_updated_at();
create trigger integration_outbox_updated_at before update on public.integration_outbox
  for each row execute function ebim.set_updated_at();
create trigger integration_circuit_updated_at before update on public.integration_circuit
  for each row execute function ebim.set_updated_at();

comment on table public.integration_providers is
  'Catalogo global de conectores del producto. SAP es un adaptador del contrato erp, no un modulo.';
comment on column public.tenant_integrations.secret_ref is
  'REFERENCIA al secreto del vault, nunca el secreto. Un CHECK rechaza config con pinta de credencial.';
comment on table public.integration_outbox is
  'Cola de salida. Se encola en la misma transaccion que el cambio de negocio: no existe «pedido creado y SAP sin enterarse».';
comment on column public.integration_outbox.operation is
  'Operacion CANONICA (order.create). El nombre de la BAPI vive dentro del adaptador y en ningun otro sitio.';
comment on table public.integration_messages is
  'Bitacora append-only de cada intento. Es la trazabilidad de mensajes que pide el RFP 4.1.3-a.';
