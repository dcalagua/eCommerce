-- =============================================================================
-- P13-SaaS · 4/6 — La bitacora transversal: quien hizo que, cuando y con que hilo
--
-- `docs/architecture.md` lleva desde P02 diciendo «pendiente de fases
-- siguientes: `audit_log`». Esta es esa fase.
--
-- ## Por que la auditoria son TRIGGERS y no llamadas dentro de cada comando
--
-- La alternativa era anadir una llamada a `ebim.audit(...)` dentro de
-- `payment_refund_request`, `sync_platform_context`, `gift_card_issue`,
-- `store_domain_claim` y otras veinte funciones. Tres razones para no hacerlo,
-- y la tercera es la que decide:
--
--   1. Reescribir veinte funciones ya aplicadas es exactamente el cambio que la
--      regla 4 del contrato de ejecucion prohibe.
--   2. La veintiuna se olvida. Y la que se olvida es siempre la que hace falta.
--   3. **Un trigger no se puede rodear.** Registra la escritura venga de donde
--      venga: de un comando, de un `update` directo del backoffice, de un
--      `service_role` desde el borde o de una consola. Una llamada dentro del
--      comando solo registra a quien pasa por el comando.
--
-- ## El actor NO es un parametro
--
-- `ebim.audit_actor()` lo deriva del JWT (`sub`, `email`) igual que se deriva
-- el tenant. Si el actor pudiera pasarse como argumento, la bitacora seria un
-- campo de texto que quien opera rellena, que es lo contrario de una bitacora.
--
-- ## Que NO se registra aqui
--
--   · **El pedido.** Tiene su propia linea de tiempo desde P08 (`order_events`,
--     cuatro ejes, actor y motivo). Duplicarla aqui daria dos relatos del mismo
--     hecho que se separarian en la primera discrepancia.
--   · **El precio de una lista.** `price_change_events` (P04) ya lo hace, con
--     el detalle que un diff generico no sabe dar.
--   · **Secretos.** El payload pasa por `ebim.redact_pii`, que hereda las
--     claves prohibidas de P09 (`token`, `secret`, `api_key`, `password`,
--     `private_key`…) y suma las de PII. Y hay un test que escribe un secreto
--     en una tabla auditada y comprueba que no aparece.
--
-- ## Append-only, de verdad
--
-- Ni UPDATE ni DELETE, ni siquiera para `service_role`: un trigger los rechaza,
-- igual que en `tracking_events` (P12) y `payment_events` (P09). Una bitacora
-- que el propio sistema puede reescribir no es prueba de nada.
--
-- La consecuencia se asume a sabiendas: **no hay purga**. Establecer una
-- politica de retencion es una decision de negocio y de cumplimiento, no un
-- efecto colateral de un `delete`; el dia que exista sera una migracion propia
-- con su propia autorizacion, y quedara escrita.
--
-- Corolario tecnico: `audit_log` **no tiene FK**. Una FK con `on delete
-- cascade` borraria el registro de una baja justo cuando se produce la baja, y
-- una con `restrict` haria imposible dar de baja nada. Es la misma decision, y
-- por el mismo motivo, que `price_change_events` («sin FK: sobrevive a la
-- lista»). El tenant lo estampa el trigger desde la propia fila.
-- =============================================================================

create type public.audit_actor_kind as enum (
  'user',     -- una persona con sesion del tenant
  'service',  -- codigo de servidor sin sesion de persona (Edge Function, job)
  'support',  -- el Super Admin de suite (contrato §13)
  'system'    -- la propia base: caducidades, deducciones de trigger
);

create table public.audit_log (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid,
  occurred_at     timestamptz not null default now(),

  -- ---- ACTOR -------------------------------------------------------------
  actor_id        uuid,
  -- El correo del actor SI se guarda, y es la unica PII deliberada de esta
  -- base de datos. La razon es la definicion misma de auditoria: «registrar
  -- actor». Un uuid no sirve para atender un incidente a las tres de la
  -- mañana, y el correo del operador no es dato del comprador. La guarda de
  -- PII sigue aplicandose entera al PAYLOAD, que es donde el dato personal
  -- entraria sin que nadie lo hubiera decidido.
  actor_email     text,
  actor_kind      public.audit_actor_kind not null,
  actor_role      text,

  -- ---- QUE ---------------------------------------------------------------
  -- Verbo CANONICO en pasado y en la forma `entidad.verbo`, igual que
  -- `domain_events.event_type`. Un nombre de funcion aqui («sync_platform_context»)
  -- ataria la bitacora a la implementacion de hoy.
  action          text        not null,
  entity_type     text        not null,
  entity_id       uuid,
  -- Como se llamaba la cosa. Sin esto, un borrado deja un uuid que ya no
  -- resuelve contra nada y el registro no dice que se borro.
  entity_label    text,
  changes         jsonb       not null default '{}'::jsonb,
  metadata        jsonb       not null default '{}'::jsonb,

  -- ---- HILO --------------------------------------------------------------
  correlation_id  text        default ebim.correlation_id(),
  request_id      text        default ebim.request_id(),

  -- ---- SOPORTE CRUZADO ---------------------------------------------------
  -- «Soporte cross-tenant, si existe, requiere trazabilidad explicita.» Hoy
  -- esta app NO tiene ningun camino de lectura cruzada: la RLS lo impide y no
  -- hay funcion que lo rodee. Estas dos columnas existen para que, si algun dia
  -- lo hubiera, el rastro sea obligatorio desde el primer commit y no un
  -- añadido posterior — y para que `service_role`, que si cruza tenants por
  -- construccion, quede marcado cuando actua fuera del tenant de su JWT.
  cross_tenant    boolean     not null default false,
  support_reason  text,

  created_at      timestamptz not null default now(),

  constraint audit_log_action_fmt
    check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint audit_log_entity_fmt check (entity_type ~ '^[a-z][a-z0-9_]{0,60}$'),
  constraint audit_log_label_len
    check (entity_label is null or char_length(entity_label) <= 200),
  constraint audit_log_email_len
    check (actor_email is null or char_length(actor_email) <= 320),
  constraint audit_log_role_fmt
    check (actor_role is null or actor_role ~ '^[a-z_]{1,40}$'),
  constraint audit_log_changes_object  check (jsonb_typeof(changes) = 'object'),
  constraint audit_log_metadata_object check (jsonb_typeof(metadata) = 'object'),
  -- La guarda de secretos, como CHECK y no solo en el trigger: el trigger se
  -- puede reemplazar, y `service_role` puede insertar aqui directamente.
  constraint audit_log_changes_clean   check (ebim.jsonb_is_pii_free(changes)),
  constraint audit_log_metadata_clean  check (ebim.jsonb_is_pii_free(metadata)),
  constraint audit_log_correlation_fmt
    check (correlation_id is null or correlation_id ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  constraint audit_log_request_fmt
    check (request_id is null or request_id ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  constraint audit_log_support_reason_len
    check (support_reason is null or char_length(support_reason) between 4 and 500)
);

create index audit_log_tenant_idx on public.audit_log (organization_id, company_id);
create index audit_log_time_idx
  on public.audit_log (organization_id, company_id, occurred_at desc);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index audit_log_actor_idx  on public.audit_log (actor_id) where actor_id is not null;
create index audit_log_action_idx
  on public.audit_log (organization_id, company_id, action, occurred_at desc);
create index audit_log_correlation_idx
  on public.audit_log (correlation_id) where correlation_id is not null;
-- El indice de la pregunta incomoda: «¿alguien de fuera toco esto?».
create index audit_log_cross_tenant_idx
  on public.audit_log (organization_id, company_id, occurred_at desc) where cross_tenant;

-- ---------------------------------------------------------------------------
-- ebim.audit_actor — quien esta actuando, derivado del JWT y de nada mas.
-- ---------------------------------------------------------------------------
create or replace function ebim.audit_actor(p_organization_id uuid, p_company_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'id',    ebim.user_id(),
    'email', ebim.email(),
    'kind',  case
               when ebim.user_id() is null then 'service'
               when ebim.is_suite_super_admin() then 'support'
               else 'user'
             end,
    'role',  (select ebim.member_role(p_organization_id, p_company_id))::text,
    -- Cruza tenant quien tiene un JWT de OTRA organizacion. `service_role` no
    -- trae `org_id`, asi que no cruza «por descuido»: cruza cuando alguien con
    -- sesion mira algo que no es suyo, que es justo el caso que hay que ver.
    'cross_tenant',
      coalesce(ebim.org_id() is not null and ebim.org_id() <> p_organization_id, false)
  );
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.audit — LA escritura. SECURITY DEFINER porque `audit_log` esta en
-- default deny y nadie tiene policy de INSERT: la bitacora no se escribe a
-- mano.
--
-- Nunca levanta. Si la fila no entra —un CHECK, un payload imposible— escribe
-- una version minima con el motivo dentro, y si tampoco entra se rinde en
-- silencio. La razon es dura pero correcta: un fallo de la BITACORA no puede
-- tumbar la operacion de NEGOCIO que la produjo. Lo contrario significa que un
-- bug en el redactor deja al comercio sin poder cobrar.
-- ---------------------------------------------------------------------------
create or replace function ebim.audit(
  p_organization_id uuid,
  p_company_id      uuid,
  p_action          text,
  p_entity_type     text,
  p_entity_id       uuid    default null,
  p_entity_label    text    default null,
  p_store_id        uuid    default null,
  p_changes         jsonb   default '{}'::jsonb,
  p_metadata        jsonb   default '{}'::jsonb,
  p_actor_kind      public.audit_actor_kind default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor jsonb := ebim.audit_actor(p_organization_id, p_company_id);
  v_kind  public.audit_actor_kind :=
            coalesce(p_actor_kind, (v_actor ->> 'kind')::public.audit_actor_kind);
  v_id    uuid;
begin
  if p_organization_id is null or p_company_id is null then
    return null;
  end if;

  begin
    insert into public.audit_log (
      organization_id, company_id, store_id,
      actor_id, actor_email, actor_kind, actor_role,
      action, entity_type, entity_id, entity_label,
      changes, metadata, cross_tenant, support_reason
    ) values (
      p_organization_id, p_company_id, p_store_id,
      ebim.safe_uuid(v_actor ->> 'id'),
      ebim.email(),
      v_kind,
      nullif(v_actor ->> 'role', ''),
      p_action, p_entity_type, p_entity_id,
      ebim.redact_text(p_entity_label, 200),
      ebim.redact_pii(coalesce(p_changes, '{}'::jsonb)),
      ebim.redact_pii(coalesce(p_metadata, '{}'::jsonb)),
      coalesce((v_actor ->> 'cross_tenant')::boolean, false),
      nullif(btrim(coalesce(current_setting('ebim.support_reason', true), '')), '')
    )
    returning id into v_id;
  exception when others then
    -- Segundo intento, sin payload. Que se pierda el detalle es malo; que se
    -- pierda el HECHO de que alguien hizo algo, mucho peor.
    begin
      insert into public.audit_log (
        organization_id, company_id, store_id,
        actor_id, actor_email, actor_kind,
        action, entity_type, entity_id,
        metadata, cross_tenant
      ) values (
        p_organization_id, p_company_id, p_store_id,
        ebim.safe_uuid(v_actor ->> 'id'), ebim.email(), v_kind,
        p_action, p_entity_type, p_entity_id,
        jsonb_build_object('audit_degraded', true),
        coalesce((v_actor ->> 'cross_tenant')::boolean, false)
      )
      returning id into v_id;
    exception when others then
      v_id := null;
    end;
  end;

  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.audit_row — el trigger GENERICO.
--
-- Se instala con dos argumentos: el `entity_type` canonico y el nombre de la
-- columna que sirve de etiqueta legible. Es lo que permite auditar doce tablas
-- con una funcion en vez de con doce.
--
-- En un UPDATE registra SOLO lo que cambio. Guardar la fila entera en cada
-- toque convierte la bitacora en una copia de la tabla y hace que leerla sea
-- inutil: el diff ES la informacion.
-- ---------------------------------------------------------------------------
create or replace function ebim.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_entity  text := coalesce(tg_argv[0], lower(tg_table_name));
  v_label_c text := tg_argv[1];
  v_row     jsonb;
  v_old     jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_action  text;
  v_label   text;
  v_i       integer;
  v_col     text;
begin
  v_row := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
  end if;

  -- Columnas TAPADAS por instalacion del trigger (tg_argv[2..]).
  --
  -- Existe por un caso concreto y no por prolijidad: `gift_cards.code` es un
  -- secreto de portador —quien lo tiene, gasta el saldo— y por eso P10 no le
  -- dio GRANT de lectura a NADIE. Sin esta lista, el diff generico lo copiaria
  -- a `audit_log`, que si leen `owner` y `admin`: la bitacora se convertiria en
  -- la puerta trasera del secreto que la tabla protege.
  --
  -- No se resuelve ampliando `ebim.sensitive_json_keys()` (P09) porque `code`
  -- es un nombre legitimo en media docena de tablas —cupon, tienda, canal,
  -- almacen— donde es dato de negocio y taparlo dejaria la bitacora sin decir
  -- QUE cambio.
  if tg_nargs > 2 then
    for v_i in 2 .. tg_nargs - 1 loop
      v_col := tg_argv[v_i];
      if v_row ? v_col then
        v_row := jsonb_set(v_row, array[v_col], '"[redactado]"'::jsonb);
      end if;
      if v_old is not null and v_old ? v_col then
        v_old := jsonb_set(v_old, array[v_col], '"[redactado]"'::jsonb);
      end if;
    end loop;
  end if;

  if tg_op = 'DELETE' then
    v_action := v_entity || '.deleted';
    v_changes := jsonb_build_object('before', ebim.redact_pii(v_row));
  elsif tg_op = 'INSERT' then
    v_action := v_entity || '.created';
    v_changes := jsonb_build_object('after', ebim.redact_pii(v_row));
  else
    v_action := v_entity || '.updated';
    select coalesce(jsonb_object_agg(
             campo.key,
             jsonb_build_object('from', v_old -> campo.key, 'to', v_row -> campo.key)),
           '{}'::jsonb)
      into v_changes
      from jsonb_each(v_row) campo
     where v_row -> campo.key is distinct from v_old -> campo.key
       -- `updated_at` cambia en TODAS las filas y no dice nada: dejarlo dentro
       -- haria que cada registro tuviera al menos un cambio y que un UPDATE que
       -- no cambio nada pareciera que si.
       and campo.key <> 'updated_at';

    -- Un UPDATE que no dejo ni una diferencia real no es un hecho: no se
    -- registra. Es lo que evita que un formulario guardado sin tocar nada
    -- llene la bitacora.
    if v_changes = '{}'::jsonb then
      return null;
    end if;
    v_changes := jsonb_build_object('changed', ebim.redact_pii(v_changes));
  end if;

  if v_label_c is not null then
    v_label := v_row ->> v_label_c;
  end if;

  perform ebim.audit(
    p_organization_id => ebim.safe_uuid(v_row ->> 'organization_id'),
    p_company_id      => ebim.safe_uuid(v_row ->> 'company_id'),
    p_action          => v_action,
    p_entity_type     => v_entity,
    p_entity_id       => ebim.safe_uuid(v_row ->> 'id'),
    p_entity_label    => v_label,
    p_store_id        => ebim.safe_uuid(v_row ->> 'store_id'),
    p_changes         => v_changes);

  return null;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.audit_record — la puerta del BORDE.
--
-- Existe porque hay operaciones sensibles que no dejan fila: exportar la
-- analitica, firmar una URL de evidencia, forzar una sincronizacion con el hub,
-- reintentar un mensaje de integracion. Sin esto, la auditoria solo veria lo
-- que cambia el esquema y no lo que se lleva la gente.
--
-- Solo `service_role`. Si el navegador pudiera escribir aqui, la bitacora seria
-- redactable por quien la protagoniza.
-- ---------------------------------------------------------------------------
create or replace function public.audit_record(
  p_organization_id uuid,
  p_company_id      uuid,
  p_action          text,
  p_entity_type     text,
  p_entity_id       uuid  default null,
  p_entity_label    text  default null,
  p_store_id        uuid  default null,
  p_metadata        jsonb default '{}'::jsonb
)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $fn$
  select ebim.audit(
    p_organization_id, p_company_id, p_action, p_entity_type,
    p_entity_id, p_entity_label, p_store_id, '{}'::jsonb, p_metadata);
$fn$;

-- =============================================================================
-- Las ONCE tablas auditadas.
--
-- La lista no es «todas». Auditar todo produce una bitacora que nadie lee, y
-- una bitacora que nadie lee no protege nada. Entra una tabla cuando tocarla
-- cambia QUIEN PUEDE, CUANTO CUESTA o QUE SE LLEVA:
--
--   quien puede : tenant_members · tenant_entitlements · tenant_feature_flags
--                 · tenant_integrations
--   cuanto cuesta: payment_methods · refunds · gift_cards · delivery_rates
--   que se lleva : customers
--   la tienda    : stores · store_settings
--
-- Fuera, y por escrito, porque su dominio YA lleva su propia bitacora y tres
-- relatos del mismo hecho se separan en la primera discrepancia:
--
--   orders                        `order_events` (P08), con los cuatro ejes
--   price_lists/price_list_items  `price_change_events` (P04)
--   promotions/coupons            `promotion_events` (P10) — de hecho el
--                                 trigger `coupons_audit` ya existe ahi
--   fulfillments/shipments        `tracking_events` (P12)
--   return_requests               `return_events` (P12)
--   payment_intents/payments      `payment_events` (P09)
-- =============================================================================
create trigger tenant_members_audit
  after insert or update or delete on public.tenant_members
  for each row execute function ebim.audit_row('tenant_member', 'role');

create trigger tenant_entitlements_audit
  after insert or update or delete on public.tenant_entitlements
  for each row execute function ebim.audit_row('entitlement', 'entitlement_code');

create trigger tenant_feature_flags_audit
  after insert or update or delete on public.tenant_feature_flags
  for each row execute function ebim.audit_row('feature_flag', 'flag_key');

create trigger tenant_integrations_audit
  after insert or update or delete on public.tenant_integrations
  for each row execute function ebim.audit_row('integration', 'provider_code');

create trigger stores_audit
  after insert or update or delete on public.stores
  for each row execute function ebim.audit_row('store', 'name');

create trigger store_settings_audit
  after insert or update or delete on public.store_settings
  for each row execute function ebim.audit_row('store_settings');

create trigger payment_methods_audit
  after insert or update or delete on public.payment_methods
  for each row execute function ebim.audit_row('payment_method', 'display_name');

create trigger refunds_audit
  after insert or update or delete on public.refunds
  for each row execute function ebim.audit_row('refund', 'status');

create trigger gift_cards_audit
  after insert or update or delete on public.gift_cards
  -- Tercer argumento: `code` es un secreto de portador y no entra en la
  -- bitacora ni redactado por accidente. `code_last4` si: es lo unico que P10
  -- deja enseñar y es lo que permite reconocer la tarjeta al atender una queja.
  for each row execute function ebim.audit_row('gift_card', 'status', 'code');

create trigger delivery_rates_audit
  after insert or update or delete on public.delivery_rates
  for each row execute function ebim.audit_row('delivery_rate');

create trigger customers_audit
  after insert or update or delete on public.customers
  for each row execute function ebim.audit_row('customer', 'kind');

-- =============================================================================
-- RLS — se LEE con rol fuerte, no se escribe nunca, no se corrige jamas
-- =============================================================================
alter table public.audit_log enable row level security;
alter table public.audit_log force  row level security;

revoke all on public.audit_log from public, anon, authenticated;
grant  select, insert on public.audit_log to service_role;
grant  select on public.audit_log to authenticated;

-- `owner` y `admin`, no cualquier miembro. Un `viewer` que puede leer la
-- bitacora ve el correo de todos los operadores y el rastro de las decisiones
-- comerciales; eso es «autorizacion fuerte» y no una preferencia.
create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner', 'admin']::public.app_role[]));

create or replace function ebim.reject_audit_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'BITACORA_INMUTABLE: la auditoria no se modifica ni se borra'
    using errcode = '42501';
end;
$fn$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function ebim.reject_audit_rewrite();

revoke execute on function
  ebim.audit(uuid, uuid, text, text, uuid, text, uuid, jsonb, jsonb, public.audit_actor_kind),
  ebim.audit_row(), ebim.audit_actor(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  ebim.audit(uuid, uuid, text, text, uuid, text, uuid, jsonb, jsonb, public.audit_actor_kind),
  ebim.audit_actor(uuid, uuid)
to service_role;

revoke execute on function
  public.audit_record(uuid, uuid, text, text, uuid, text, uuid, jsonb)
from public, anon, authenticated;
grant execute on function
  public.audit_record(uuid, uuid, text, text, uuid, text, uuid, jsonb)
to service_role;

comment on table public.audit_log is
  'Bitacora transversal de operaciones sensibles: actor, accion, entidad, momento, tenant y correlation id. Append-only para todos, incluido service_role. Sin FK: sobrevive al borrado de lo que registra.';
comment on column public.audit_log.actor_email is
  'Unica PII deliberada de esta base: sin el correo del actor, la auditoria no cumple su definicion. El PAYLOAD si pasa por la guarda entera.';
comment on column public.audit_log.cross_tenant is
  'El actor traia un JWT de OTRA organizacion. Hoy ningun camino de esta app lo permite; la columna existe para que, si alguna vez lo hubiera, el rastro sea obligatorio desde el primer dia.';
comment on function ebim.audit_row() is
  'Trigger generico de auditoria. En UPDATE registra solo el diff, sin updated_at, y no registra nada si no cambio nada.';
