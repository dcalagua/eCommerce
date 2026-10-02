-- =============================================================================
-- LIBRO DE RECLAMACIONES virtual (aprobado por el operador, 2026-10-02).
--
-- En Perú es obligatorio para todo comercio que vende al consumidor final
-- (Código de Protección y Defensa del Consumidor, art. 150, y su reglamento):
-- la hoja recoge al proveedor, al consumidor, el bien contratado, si es RECLAMO
-- (disconformidad con el producto o servicio) o QUEJA (malestar con la
-- atención), el detalle y el pedido; lleva un número correlativo y el comercio
-- responde por escrito en el plazo legal.
--
-- ## Cómo entra cada cosa
--
--   · El COMPRADOR —con o sin sesión— solo escribe por `submit_complaint`, una
--     función SECURITY DEFINER que resuelve la tienda por su slug PÚBLICO (nunca
--     un tenant que mande el navegador), acepta una lista cerrada de campos, los
--     valida y asigna el correlativo. No hay policy de escritura para nadie.
--   · El COMERCIO lee por RLS (`can_access`, default deny) y responde por
--     `respond_complaint`, que exige rol y deja rastro en `audit_log`.
--   · `anon` no tiene NINGÚN privilegio sobre la tabla: los datos personales
--     del reclamante no se leen desde la vitrina.
--
-- El correlativo es por TIENDA y AÑO («R-2026-000001»), asignado bajo un
-- candado transaccional para que dos reclamos simultáneos no empaten.
-- =============================================================================

create table public.complaints (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null,
  company_id       uuid        not null,
  store_id         uuid        not null,
  year             integer     not null,
  number           integer     not null,
  code             text        not null,
  kind             text        not null,
  -- Quien reclama
  consumer_name    text        not null,
  doc_type         text        not null,
  doc_number       text        not null,
  consumer_email   text        not null,
  consumer_phone   text,
  consumer_address text,
  is_minor         boolean     not null default false,
  guardian_name    text,
  -- Lo contratado
  item_kind        text        not null,
  item_description text        not null,
  amount           numeric(12, 2),
  order_reference  text,
  -- El reclamo
  detail           text        not null,
  request          text        not null,
  -- La respuesta del comercio
  status           text        not null default 'received',
  response         text,
  responded_at     timestamptz,
  responded_by     uuid,
  -- Quien lo envió, si tenía sesión (lo pone la función desde el JWT).
  user_id          uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint complaints_kind        check (kind in ('reclamo', 'queja')),
  constraint complaints_doc_type    check (doc_type in ('dni', 'ce', 'pasaporte', 'ruc')),
  constraint complaints_doc_number  check (doc_number ~ '^[0-9A-Za-z-]{6,20}$'),
  constraint complaints_name_len    check (char_length(btrim(consumer_name)) between 2 and 160),
  constraint complaints_email_fmt   check (char_length(consumer_email) <= 254
                                           and consumer_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint complaints_phone_fmt   check (consumer_phone is null or consumer_phone ~ '^\+?[0-9][0-9 ]{5,19}$'),
  constraint complaints_address_len check (consumer_address is null or char_length(btrim(consumer_address)) between 3 and 240),
  constraint complaints_guardian    check (not is_minor
                                           or (guardian_name is not null and char_length(btrim(guardian_name)) between 2 and 160)),
  constraint complaints_item_kind   check (item_kind in ('producto', 'servicio')),
  constraint complaints_item_len    check (char_length(btrim(item_description)) between 2 and 500),
  constraint complaints_amount      check (amount is null or amount between 0 and 9999999),
  constraint complaints_order_ref   check (order_reference is null or char_length(btrim(order_reference)) between 1 and 40),
  constraint complaints_detail_len  check (char_length(btrim(detail)) between 10 and 3000),
  constraint complaints_request_len check (char_length(btrim(request)) between 5 and 2000),
  constraint complaints_status      check (status in ('received', 'in_progress', 'answered')),
  constraint complaints_response    check (response is null or char_length(btrim(response)) between 10 and 3000),
  constraint complaints_answered    check (status <> 'answered' or (response is not null and responded_at is not null)),
  constraint complaints_number_pos  check (number > 0 and year between 2000 and 2999),

  constraint complaints_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint complaints_correlative unique (store_id, year, number),
  constraint complaints_code_unique unique (store_id, code)
);

create index complaints_tenant_idx on public.complaints (organization_id, company_id);
create index complaints_store_recent_idx on public.complaints (store_id, created_at desc);

create trigger complaints_set_updated_at
  before update on public.complaints
  for each row execute function ebim.set_updated_at();

alter table public.complaints enable row level security;
alter table public.complaints force row level security;

-- Default deny: solo quien opera ESTE tenant lee, con la membresía resuelta UNA
-- vez por consulta (forma initplan del repositorio). No hay policy de escritura.
create policy complaints_select_member on public.complaints
  for select to authenticated
  using (organization_id = (select ebim.org_id())
         and company_id = any ((select ebim.member_companies())::uuid[]));

-- Ningún rol escribe directo: los privilegios por defecto de `public` dan
-- INSERT/UPDATE/DELETE a `authenticated` en cada tabla nueva y se retiran. La
-- única puerta son `submit_complaint` y `respond_complaint`. `service_role`, con
-- privilegios EXPLÍCITOS (como `product_reviews`) para procesos de servidor.
revoke all on public.complaints from public, anon, authenticated;
grant select on public.complaints to authenticated;
grant select, insert, update, delete on public.complaints to service_role;

comment on table public.complaints is
  'Libro de Reclamaciones virtual. Escritura solo por submit_complaint (vitrina) y respond_complaint (comercio). anon sin privilegios.';

-- ---------------------------------------------------------------------------
-- ebim.complaint_text — texto obligatorio u opcional, recortado y acotado.
-- Admite saltos de línea si se pide; nunca otros caracteres de control.
-- ---------------------------------------------------------------------------
create or replace function ebim.complaint_text(
  p_value     jsonb,
  p_min       integer,
  p_max       integer,
  p_multiline boolean,
  p_required  boolean,
  p_field     text
)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v text;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    if p_required then
      raise exception 'CAMPO_REQUERIDO: falta %', p_field using errcode = '22023';
    end if;
    return null;
  end if;
  if jsonb_typeof(p_value) <> 'string' then
    raise exception 'CAMPO_INVALIDO: % debe ser texto', p_field using errcode = '22023';
  end if;
  v := btrim(p_value #>> '{}');
  if v = '' then
    if p_required then
      raise exception 'CAMPO_REQUERIDO: falta %', p_field using errcode = '22023';
    end if;
    return null;
  end if;
  if char_length(v) < p_min or char_length(v) > p_max then
    raise exception 'CAMPO_INVALIDO: % debe tener entre % y % caracteres', p_field, p_min, p_max
      using errcode = '22023';
  end if;
  if (p_multiline and v ~ '[\x01-\x09\x0B-\x1F\x7F]') or (not p_multiline and v ~ '[[:cntrl:]]') then
    raise exception 'CAMPO_INVALIDO: % contiene caracteres no permitidos', p_field using errcode = '22023';
  end if;
  return v;
end;
$fn$;

revoke execute on function ebim.complaint_text(jsonb, integer, integer, boolean, boolean, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- submit_complaint — la única puerta de escritura del consumidor.
-- ---------------------------------------------------------------------------
create or replace function public.submit_complaint(
  p_store_slug text,
  p_complaint  jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_store    public.stores%rowtype;
  v_year     integer := extract(year from (now() at time zone 'America/Lima'))::integer;
  v_number   integer;
  v_kind     text;
  v_doc_type text;
  v_item     text;
  v_minor    boolean;
  v_amount   numeric(12, 2);
  v_row      public.complaints%rowtype;
begin
  v_store := ebim.active_store_by_slug(p_store_slug);

  if p_complaint is null or jsonb_typeof(p_complaint) <> 'object' then
    raise exception 'DATOS_INVALIDOS: se espera un objeto con la hoja de reclamacion' using errcode = '22023';
  end if;

  -- Lista cerrada: `status`, `response`, `code`, `organization_id`... no se
  -- ignoran, se rechazan.
  if exists (
    select 1 from jsonb_object_keys(p_complaint) as k(key)
    where k.key not in (
      'kind', 'consumer_name', 'doc_type', 'doc_number', 'consumer_email', 'consumer_phone',
      'consumer_address', 'is_minor', 'guardian_name', 'item_kind', 'item_description',
      'amount', 'order_reference', 'detail', 'request')
  ) then
    raise exception 'CAMPO_NO_PERMITIDO: la hoja lleva solo los campos del formulario' using errcode = '22023';
  end if;

  v_kind := p_complaint ->> 'kind';
  if v_kind is null or v_kind not in ('reclamo', 'queja') then
    raise exception 'CAMPO_INVALIDO: kind es reclamo o queja' using errcode = '22023';
  end if;
  v_doc_type := p_complaint ->> 'doc_type';
  if v_doc_type is null or v_doc_type not in ('dni', 'ce', 'pasaporte', 'ruc') then
    raise exception 'CAMPO_INVALIDO: doc_type es dni, ce, pasaporte o ruc' using errcode = '22023';
  end if;
  v_item := p_complaint ->> 'item_kind';
  if v_item is null or v_item not in ('producto', 'servicio') then
    raise exception 'CAMPO_INVALIDO: item_kind es producto o servicio' using errcode = '22023';
  end if;
  if p_complaint ? 'is_minor' and jsonb_typeof(p_complaint -> 'is_minor') <> 'boolean' then
    raise exception 'CAMPO_INVALIDO: is_minor es booleano' using errcode = '22023';
  end if;
  v_minor := coalesce((p_complaint ->> 'is_minor')::boolean, false);
  if p_complaint ? 'amount' and jsonb_typeof(p_complaint -> 'amount') not in ('number', 'null') then
    raise exception 'CAMPO_INVALIDO: amount es un numero' using errcode = '22023';
  end if;
  v_amount := nullif(p_complaint ->> 'amount', '')::numeric(12, 2);

  -- Techo por tienda: un formulario público sin sesión es lo primero que
  -- automatiza un abuso. Configurable por el comercio (`rate_limits`).
  if ebim.public_rate_exceeded(v_store.id, 'complaints.submit', 60) then
    raise exception 'LIMITE_DE_TASA: la tienda recibe demasiados reclamos; intentalo mas tarde'
      using errcode = '22023';
  end if;

  -- El correlativo, bajo candado por tienda y año.
  perform pg_advisory_xact_lock(hashtextextended('complaints:' || v_store.id::text || ':' || v_year::text, 0));
  select coalesce(max(c.number), 0) + 1 into v_number
  from public.complaints c
  where c.store_id = v_store.id and c.year = v_year;

  insert into public.complaints as c (
    organization_id, company_id, store_id, year, number, code, kind,
    consumer_name, doc_type, doc_number, consumer_email, consumer_phone, consumer_address,
    is_minor, guardian_name, item_kind, item_description, amount, order_reference,
    detail, request, user_id
  ) values (
    v_store.organization_id, v_store.company_id, v_store.id, v_year, v_number,
    'R-' || v_year::text || '-' || lpad(v_number::text, 6, '0'), v_kind,
    ebim.complaint_text(p_complaint -> 'consumer_name', 2, 160, false, true, 'consumer_name'),
    v_doc_type,
    ebim.complaint_text(p_complaint -> 'doc_number', 6, 20, false, true, 'doc_number'),
    lower(ebim.complaint_text(p_complaint -> 'consumer_email', 5, 254, false, true, 'consumer_email')),
    ebim.complaint_text(p_complaint -> 'consumer_phone', 6, 20, false, false, 'consumer_phone'),
    ebim.complaint_text(p_complaint -> 'consumer_address', 3, 240, false, false, 'consumer_address'),
    v_minor,
    case when v_minor
         then ebim.complaint_text(p_complaint -> 'guardian_name', 2, 160, false, true, 'guardian_name') end,
    v_item,
    ebim.complaint_text(p_complaint -> 'item_description', 2, 500, false, true, 'item_description'),
    v_amount,
    ebim.complaint_text(p_complaint -> 'order_reference', 1, 40, false, false, 'order_reference'),
    ebim.complaint_text(p_complaint -> 'detail', 10, 3000, true, true, 'detail'),
    ebim.complaint_text(p_complaint -> 'request', 5, 2000, true, true, 'request'),
    ebim.user_id()
  )
  returning c.* into v_row;

  perform ebim.public_rate_record(v_store.id, 'complaints.submit', 1, 60);

  return jsonb_build_object('code', v_row.code, 'created_at', v_row.created_at, 'kind', v_row.kind);
end;
$fn$;

-- El llamador legítimo es la vitrina, con o sin sesión: por eso anon SÍ.
revoke execute on function public.submit_complaint(text, jsonb) from public;
grant  execute on function public.submit_complaint(text, jsonb) to anon, authenticated, service_role;

comment on function public.submit_complaint(text, jsonb) is
  'Registra una hoja del Libro de Reclamaciones en la tienda activa del slug. Campos de lista cerrada; correlativo por tienda y anio; devuelve {code, created_at, kind}. Tenant derivado de la tienda, nunca del cliente.';

-- ---------------------------------------------------------------------------
-- respond_complaint — el comercio cambia el estado y/o responde.
-- ---------------------------------------------------------------------------
create or replace function public.respond_complaint(
  p_complaint_id uuid,
  p_status       text,
  p_response     text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_user     uuid := ebim.user_id();
  v_row      public.complaints%rowtype;
  v_response text := nullif(btrim(coalesce(p_response, '')), '');
begin
  if v_user is null then
    raise exception 'NO_AUTENTICADO: hace falta sesion' using errcode = '42501';
  end if;

  select c.* into v_row from public.complaints c where c.id = p_complaint_id for update;

  if v_row.id is null or not ebim.can_access(v_row.organization_id, v_row.company_id) then
    raise exception 'RECLAMO_NO_ENCONTRADO: no hay ningun reclamo con ese id' using errcode = '22023';
  end if;
  if not ebim.has_role(v_row.organization_id, v_row.company_id,
                       array['owner', 'admin', 'orders']::public.app_role[]) then
    raise exception 'SIN_PERMISO: responder reclamos exige rol owner, admin u orders' using errcode = '42501';
  end if;
  if p_status not in ('in_progress', 'answered') then
    raise exception 'ESTADO_INVALIDO: in_progress o answered' using errcode = '22023';
  end if;
  if v_row.status = 'answered' then
    raise exception 'YA_RESPONDIDO: el reclamo ya tiene respuesta registrada' using errcode = '22023';
  end if;
  if p_status = 'answered' and (v_response is null or char_length(v_response) < 10
       or char_length(v_response) > 3000 or v_response ~ '[\x01-\x09\x0B-\x1F\x7F]') then
    raise exception 'RESPUESTA_REQUERIDA: responder exige un texto de 10 a 3000 caracteres'
      using errcode = '22023';
  end if;

  update public.complaints c
     set status       = p_status,
         response     = case when p_status = 'answered' then v_response else c.response end,
         responded_at = case when p_status = 'answered' then now() else c.responded_at end,
         responded_by = case when p_status = 'answered' then v_user else c.responded_by end
   where c.id = v_row.id
  returning c.* into v_row;

  perform ebim.audit(
    p_organization_id => v_row.organization_id,
    p_company_id      => v_row.company_id,
    p_action          => 'complaint.' || p_status,
    p_entity_type     => 'complaint',
    p_entity_id       => v_row.id,
    p_entity_label    => v_row.code,
    p_store_id        => v_row.store_id,
    p_changes         => jsonb_build_object('status', jsonb_build_object('to', p_status)));

  return jsonb_build_object('id', v_row.id, 'code', v_row.code, 'status', v_row.status,
                            'responded_at', v_row.responded_at);
end;
$fn$;

revoke execute on function public.respond_complaint(uuid, text, text) from public, anon;
grant  execute on function public.respond_complaint(uuid, text, text) to authenticated, service_role;

comment on function public.respond_complaint(uuid, text, text) is
  'Pasa un reclamo del tenant del JWT a in_progress o answered (con respuesta 10..3000). Exige owner/admin/orders. Deja rastro en audit_log.';
