-- =============================================================================
-- P12-SaaS · 5/7 — DEVOLUCIONES: solicitud, motivos, decision, items y
--                  evidencia
--
-- ## El alcance de la fase base, escrito antes que el modelo
--
-- El encargo lo enumera y esta migracion no añade ni quita: solicitud, motivos,
-- aprobacion/rechazo, estado, items con cantidades, evidencia opcional segura y
-- la integracion financiera **por un puerto**. Lo que NO entra —y no entra a
-- proposito— es la nota de credito de ningun ERP concreto (regla 9): aqui se
-- publica un hecho canonico con el importe y quien lo convierta en documento
-- fiscal es un adaptador, no este esquema.
--
-- ## Por que una devolucion no es un pedido negativo
--
-- Es la tentacion clasica y sale cara. Un pedido negativo no tiene estado
-- propio —no existe «pendiente de recibir»—, no tiene motivo por linea, no
-- distingue «llego roto» de «no lo quiero», no admite que se aprueben dos de
-- tres unidades y, sobre todo, reescribe la historia del pedido original. La
-- devolucion es una entidad con su propio ciclo, que APUNTA al pedido:
--
--     return_request ──► order          y no al reves
--
-- Es la tercera vez que este repositorio toma la misma decision —cobros (P09),
-- entregas (150100) y ahora devoluciones— y por la misma razon: `orders` no
-- gana ni una columna, asi que conectar un ERP nuevo no obliga a migrar el
-- dominio de pedidos.
--
-- ## Las cinco piezas
--
--   return_reasons    EL VOCABULARIO del comercio. Es configuracion: cada
--                     tienda decide sus motivos, cuales exigen foto y cuales
--                     devuelven la unidad al stock. No hay lista fija en el
--                     codigo, que seria decidir por el tenant.
--   return_requests   LA SOLICITUD, con su RMA, su estado y su decision.
--   return_items      QUE unidades vuelven, en que estado llegaron y si se
--                     reponen. La cantidad es por linea, no por pedido.
--   return_events     LA BITACORA append-only de la devolucion.
--   return_evidence   LA FOTO. Ruta en un bucket PRIVADO por tenant; el archivo
--                     no se guarda aqui y no hay URL publica ni para el dueño.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 · El vocabulario.
-- ---------------------------------------------------------------------------

-- Ciclo de la solicitud. `in_transit` y `received` son estados distintos porque
-- entre «lo mando de vuelta» y «lo tengo» pasan dias y en esos dias el dinero
-- todavia no se devuelve: fundirlos obligaria a reembolsar contra una promesa.
create type public.return_state as enum (
  'requested',   -- el comprador la pidio; nadie la ha mirado
  'approved',    -- autorizada; se espera la mercancia
  'rejected',    -- denegada, con motivo
  'in_transit',  -- el comprador la envio de vuelta
  'received',    -- llego al comercio
  'inspected',   -- se reviso pieza a pieza
  'completed',   -- cerrada: resolucion aplicada
  'cancelled'    -- la retiro el comprador o el comercio antes de decidir
);

-- Que se le da al comprador a cambio. Es una DECISION comercial y por eso es
-- un campo y no una consecuencia: el mismo motivo puede resolverse de cuatro
-- formas segun el caso y segun lo que el comprador acepte.
create type public.return_resolution as enum (
  'refund',        -- dinero de vuelta
  'exchange',      -- otra unidad
  'store_credit',  -- saldo en la tienda
  'repair'
);

-- Como llego la unidad. Decide si se repone al stock, y por eso no es texto:
-- de este valor cuelga un movimiento de inventario.
create type public.return_item_condition as enum (
  'pending',   -- todavia no se ha inspeccionado
  'sellable',  -- vuelve al stock
  'damaged',
  'used',
  'missing'    -- se aprobo y nunca llego
);

-- Por donde entro la solicitud. Misma idea que `order_source_channel` (P08):
-- cuando algo sale mal la pregunta operativa es siempre «¿de donde salio esto?».
create type public.return_source as enum ('storefront', 'backoffice', 'api');

-- ---------------------------------------------------------------------------
-- 2 · El contador de RMA, hermano del de pedidos.
--
-- Va en `stores` y no en una tabla aparte por la misma razon que `order_seq`:
-- el numero es POR TIENDA y correlativo, y un contador en otra tabla obliga a
-- un segundo bloqueo en la ruta caliente de la solicitud.
-- ---------------------------------------------------------------------------
alter table public.stores
  add column return_seq bigint not null default 0;

comment on column public.stores.return_seq is
  'Contador correlativo de RMA por tienda. Hermano de order_seq: el numero de devolucion es de la tienda, no global.';

-- ---------------------------------------------------------------------------
-- 3 · return_reasons — el vocabulario del comercio.
--
-- `requires_evidence` y `restock_default` son las dos propiedades que cambian
-- la operacion: un motivo «llego roto» pide foto y NO repone; un motivo «no me
-- gusto» no pide foto y si repone. Dejar eso a criterio de quien atiende
-- produce dos almacenes distintos segun quien estuviera de turno.
-- ---------------------------------------------------------------------------
create table public.return_reasons (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  code            text        not null,
  label           text        not null,
  description     text,
  -- ¿Hace falta una foto para poder pedirla?
  requires_evidence boolean   not null default false,
  -- ¿La unidad vuelve al stock cuando llega en buen estado?
  restock_default boolean     not null default true,
  is_active       boolean     not null default true,
  position        integer     not null default 100,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint return_reasons_code_fmt check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint return_reasons_label_len check (char_length(btrim(label)) between 1 and 120),
  constraint return_reasons_desc_len
    check (description is null or char_length(description) <= 1000),
  constraint return_reasons_position check (position between 0 and 9999),
  constraint return_reasons_code_unique unique (store_id, code),
  constraint return_reasons_store_key unique (id, store_id),
  constraint return_reasons_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index return_reasons_tenant on public.return_reasons (organization_id, company_id);
create index return_reasons_store_active
  on public.return_reasons (store_id, position) where is_active;

create trigger return_reasons_set_updated_at before update on public.return_reasons
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4 · return_requests — la solicitud.
--
-- `refund_amount` es lo que el comercio DECIDIO devolver y no lo que la suma de
-- las lineas dice: hay descuentos, portes no reembolsables y acuerdos, y una
-- cifra calculada al vuelo por la pantalla no se puede conciliar con nada.
-- Nace en cero y la escribe el comando de inspeccion.
--
-- **No hay `payment_id` ni `credit_note_id`.** El enlace con el dinero es un
-- HECHO publicado (`return.completed`) que un adaptador consume. Ponerlo aqui
-- ataria este esquema a que exista un cobro en linea, que es falso para la
-- mitad de los comercios de esta region.
-- ---------------------------------------------------------------------------
create table public.return_requests (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  order_id        uuid        not null,
  -- Numero que el comprador cita. Correlativo por tienda, como el del pedido.
  rma_number      text        not null,
  state           public.return_state not null default 'requested',
  resolution      public.return_resolution not null default 'refund',
  source          public.return_source not null default 'storefront',
  -- Motivo PRINCIPAL. Texto y no FK viva: es snapshot, igual que el nombre del
  -- producto en la linea del pedido. El comercio puede retirar el motivo
  -- mañana y esta solicitud tiene que seguir diciendo por que se pidio.
  reason_code     text        not null,
  reason_label    text        not null,
  -- Lo que escribio el comprador. Se guarda tal cual y se pinta como TEXTO:
  -- nunca como marcado (regla del CMS, P11).
  customer_note   text,
  customer_email  text        not null,
  -- La decision, con nombre y apellido.
  decided_at      timestamptz,
  decided_by      uuid,
  decided_email   text,
  decision_note   text,
  currency        char(3)     not null,
  -- Lo que se decidio devolver. Cero hasta que alguien lo decide.
  refund_amount   numeric(14,2) not null default 0,
  received_at     timestamptz,
  inspected_at    timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint return_requests_reason_fmt check (reason_code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint return_requests_reason_label_len
    check (char_length(btrim(reason_label)) between 1 and 120),
  constraint return_requests_note_len
    check (customer_note is null or char_length(customer_note) <= 2000),
  constraint return_requests_decision_len
    check (decision_note is null or char_length(decision_note) <= 2000),
  constraint return_requests_email_fmt check (position('@' in customer_email) > 1),
  constraint return_requests_decided_email_len
    check (decided_email is null or char_length(decided_email) <= 320),
  constraint return_requests_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint return_requests_amount_non_negative check (refund_amount >= 0),
  -- Una decision sin fecha es una decision que nadie puede fechar. `cancelled`
  -- queda fuera de la regla en los dos sentidos: se puede anular una solicitud
  -- que nadie miro (sin fecha) y tambien una ya aprobada (con la suya).
  constraint return_requests_decision_shape check (
    state = 'requested' and decided_at is null
    or state = 'cancelled'
    or (state not in ('requested', 'cancelled') and decided_at is not null)
  ),
  -- Rechazar sin motivo deja una devolucion denegada que nadie sabe explicar.
  constraint return_requests_rejection_shape check (
    state <> 'rejected' or decision_note is not null
  ),
  constraint return_requests_rma_unique unique (store_id, rma_number),
  constraint return_requests_store_key unique (id, store_id),
  constraint return_requests_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade,
  constraint return_requests_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index return_requests_tenant on public.return_requests (organization_id, company_id);
create index return_requests_order on public.return_requests (order_id, created_at desc);
-- La cola del backoffice: «que devoluciones hay que atender en esta tienda».
create index return_requests_store_state
  on public.return_requests (store_id, state, created_at desc);
create index return_requests_email
  on public.return_requests (store_id, lower(customer_email));

create trigger return_requests_set_updated_at before update on public.return_requests
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5 · return_items — que unidades vuelven.
--
-- Motivo POR LINEA ademas del principal: en una devolucion de tres articulos,
-- uno llego roto y dos no gustaron, y con un solo motivo el analisis de
-- calidad del catalogo es imposible.
--
-- `restock` se decide en la INSPECCION y no al pedir: hasta que no se ve la
-- unidad no se sabe si vuelve al stock. Nace con el valor por defecto del
-- motivo, que es una sugerencia, no la decision.
-- ---------------------------------------------------------------------------
create table public.return_items (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,
  company_id        uuid        not null,
  store_id          uuid        not null,
  return_request_id uuid        not null,
  order_item_id     uuid        not null,
  quantity          integer     not null,
  -- Cuantas se recibieron de verdad. Puede ser menos que lo pedido.
  received_quantity integer     not null default 0,
  reason_code       text        not null,
  condition         public.return_item_condition not null default 'pending',
  restock           boolean     not null default false,
  -- Importe imputado a esta linea. Suma <= `return_requests.refund_amount`, y
  -- lo escribe la inspeccion: la pantalla no reparte dinero.
  refund_amount     numeric(14,2) not null default 0,
  -- Movimiento de inventario que repuso esta linea, si lo hubo. Enlace, no
  -- copia: la cifra vive en el asiento de P06.
  restock_movement_id uuid,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint return_items_qty check (quantity > 0 and quantity <= 100000),
  constraint return_items_received_qty
    check (received_quantity >= 0 and received_quantity <= quantity),
  constraint return_items_reason_fmt check (reason_code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint return_items_amount_non_negative check (refund_amount >= 0),
  constraint return_items_note_len check (note is null or char_length(note) <= 1000),
  -- Lo que no llego no se repone. Sin esto, una unidad «missing» marcada para
  -- reponer sumaria existencia que nadie tiene.
  constraint return_items_restock_shape check (
    not restock or condition = 'sellable'
  ),
  constraint return_items_unique unique (return_request_id, order_item_id),
  constraint return_items_key unique (id, store_id),
  constraint return_items_request_fk foreign key (return_request_id, store_id)
    references public.return_requests (id, store_id) on delete cascade,
  constraint return_items_order_item_fk foreign key (order_item_id, store_id)
    references public.order_items (id, store_id) on delete cascade,
  constraint return_items_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index return_items_tenant on public.return_items (organization_id, company_id);
create index return_items_request on public.return_items (return_request_id);
create index return_items_order_item on public.return_items (order_item_id);

create trigger return_items_set_updated_at before update on public.return_items
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6 · return_events — la bitacora de la devolucion.
--
-- Append-only incluso para `service_role`, igual que la de pagos y la de
-- seguimiento. Es donde se lee quien aprobo, quien rechazo y con que motivo, y
-- una bitacora editable no responde a ninguna de las tres preguntas.
-- ---------------------------------------------------------------------------
create table public.return_events (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,
  company_id        uuid        not null,
  store_id          uuid        not null,
  return_request_id uuid        not null,
  event_type        text        not null,
  from_state        public.return_state,
  to_state          public.return_state,
  note              text,
  payload           jsonb       not null default '{}'::jsonb,
  actor_id          uuid,
  actor_email       text,
  created_at        timestamptz not null default now(),
  constraint return_events_type_fmt
    check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint return_events_note_len check (note is null or char_length(note) <= 2000),
  constraint return_events_email_len
    check (actor_email is null or char_length(actor_email) <= 320),
  constraint return_events_payload_shape check (jsonb_typeof(payload) = 'object'),
  constraint return_events_payload_safe check (ebim.jsonb_is_card_safe(payload)),
  constraint return_events_request_fk foreign key (return_request_id, store_id)
    references public.return_requests (id, store_id) on delete cascade,
  constraint return_events_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index return_events_tenant on public.return_events (organization_id, company_id);
create index return_events_request on public.return_events (return_request_id, created_at, id);

-- ---------------------------------------------------------------------------
-- 7 · return_evidence — la foto, y por que «segura» no es un adjetivo.
--
-- Tres propiedades, y ninguna es opcional:
--
-- 1. **El bucket es PRIVADO.** No hay URL publica ni para el dueño: se accede
--    con una URL firmada que caduca. Un bucket publico daria lectura a
--    cualquier ruta, incluida la de otro tenant.
-- 2. **La ruta LLEVA el tenant** —`{organization_id}/{store_id}/...`— y un
--    trigger comprueba que la ruta escrita coincide con el tenant de la fila.
--    Sin esa comprobacion, la ruta seria un dato declarado por quien sube.
-- 3. **`anon` no escribe.** Un comprador anonimo con permiso de INSERT sobre
--    Storage es un punto de subida abierto a internet. La foto la adjunta el
--    comercio —que es quien la recibe por su canal— o un comprador con sesion
--    desde su area de cuenta. Dar al comprador anonimo una subida directa exige
--    una URL firmada emitida por una Edge Function que valide el token del
--    pedido, y eso no se improvisa aqui.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('return-evidence', 'return-evidence', false)
on conflict (id) do nothing;

create table public.return_evidence (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,
  company_id        uuid        not null,
  store_id          uuid        not null,
  return_request_id uuid        not null,
  -- Solo la RUTA. El archivo vive en Storage; duplicarlo aqui como bytes seria
  -- meter fotos en una tabla que se lee entera en cada listado.
  storage_path      text        not null,
  content_type      text        not null,
  size_bytes        integer     not null,
  caption           text,
  uploaded_by       uuid,
  uploaded_email    text,
  created_at        timestamptz not null default now(),
  constraint return_evidence_path_len check (char_length(storage_path) between 8 and 500),
  -- Solo imagen o PDF. Un ejecutable «de evidencia» no existe, y la lista
  -- blanca es mas corta de mantener que la negra.
  constraint return_evidence_type check (
    content_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf')
  ),
  constraint return_evidence_size check (size_bytes between 1 and 10485760),
  constraint return_evidence_caption_len
    check (caption is null or char_length(caption) <= 300),
  constraint return_evidence_email_len
    check (uploaded_email is null or char_length(uploaded_email) <= 320),
  constraint return_evidence_path_unique unique (storage_path),
  constraint return_evidence_request_fk foreign key (return_request_id, store_id)
    references public.return_requests (id, store_id) on delete cascade,
  constraint return_evidence_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index return_evidence_tenant on public.return_evidence (organization_id, company_id);
create index return_evidence_request on public.return_evidence (return_request_id, created_at);

-- La ruta no la declara quien sube: se comprueba contra el tenant DE LA FILA.
create or replace function ebim.assert_evidence_path()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if position(new.organization_id::text || '/' || new.store_id::text || '/'
              in new.storage_path) <> 1
  then
    raise exception 'EVIDENCIA_RUTA_INVALIDA: la ruta debe empezar por {organization_id}/{store_id}/'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

create trigger return_evidence_path
  before insert or update on public.return_evidence
  for each row execute function ebim.assert_evidence_path();

-- ---------------------------------------------------------------------------
-- 8 · No se devuelve mas de lo que se compro.
--
-- Mismo razonamiento que el trigger de despacho: un CHECK no puede mirar otras
-- filas y una comprobacion dentro del comando se salta con un INSERT directo.
--
-- Las solicitudes RECHAZADAS y CANCELADAS no cuentan: una devolucion denegada
-- devuelve sus unidades al saldo devolvible, o un comprador al que se le dijo
-- que no nunca podria volver a pedirla.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_return_quantity()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_ordered  integer;
  v_returned integer;
begin
  select oi.quantity into v_ordered
  from public.order_items oi where oi.id = new.order_item_id;

  if v_ordered is null then
    raise exception 'LINEA_NO_ENCONTRADA: la linea de pedido no existe'
      using errcode = '22023';
  end if;

  select coalesce(sum(ri.quantity), 0) into v_returned
  from public.return_items ri
  join public.return_requests rr on rr.id = ri.return_request_id
  where ri.order_item_id = new.order_item_id
    and rr.state not in ('rejected', 'cancelled')
    and ri.id is distinct from new.id;

  if v_returned + new.quantity > v_ordered then
    raise exception
      'DEVOLUCION_CANTIDAD_EXCEDIDA: se piden % de una linea de % con % ya en devolucion',
      new.quantity, v_ordered, v_returned
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

create trigger return_items_quantity
  before insert or update on public.return_items
  for each row execute function ebim.assert_return_quantity();

-- ---------------------------------------------------------------------------
-- 9 · La maquina de estados de la devolucion.
-- ---------------------------------------------------------------------------
create or replace function ebim.return_allowed_next(p_from public.return_state)
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select case p_from
    when 'requested'  then array['approved','rejected','cancelled']
    -- De `approved` se puede saltar directo a `received`: en un recojo en
    -- tienda el comprador aparece con la caja y no hubo transito.
    when 'approved'   then array['in_transit','received','cancelled']
    when 'in_transit' then array['received','cancelled']
    when 'received'   then array['inspected','cancelled']
    -- Una inspeccion puede terminar en rechazo: la unidad llego usada y el
    -- motivo declarado no se sostiene. Cerrar solo hacia `completed` obligaria
    -- a reembolsar lo que no procede.
    when 'inspected'  then array['completed','rejected']
    else array[]::text[]
  end;
$fn$;

revoke execute on function ebim.return_allowed_next(public.return_state) from public;
grant execute on function ebim.return_allowed_next(public.return_state)
  to anon, authenticated, service_role;

create or replace function ebim.assert_return_transition()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.state is distinct from old.state
     and not (new.state::text = any (ebim.return_allowed_next(old.state))) then
    raise exception 'DEVOLUCION_TRANSICION_INVALIDA: % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  if new.state in ('approved','rejected','in_transit','received','inspected','completed')
     and new.decided_at is null then
    new.decided_at := now();
  end if;
  if new.state = 'received'  and new.received_at  is null then new.received_at  := now(); end if;
  if new.state = 'inspected' and new.inspected_at is null then new.inspected_at := now(); end if;
  if new.state = 'completed' and new.completed_at is null then new.completed_at := now(); end if;
  if new.state = 'cancelled' and new.cancelled_at is null then new.cancelled_at := now(); end if;

  -- El RMA y el pedido de una devolucion no se reescriben: son su identidad.
  if (new.rma_number, new.order_id, new.currency)
     is distinct from (old.rma_number, old.order_id, old.currency) then
    raise exception 'DEVOLUCION_IDENTIDAD_INMUTABLE: el RMA, el pedido y la moneda no se cambian'
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

create trigger return_requests_transition before update on public.return_requests
  for each row execute function ebim.assert_return_transition();

create or replace function ebim.reject_return_log_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'BITACORA_INMUTABLE: los hechos de una devolucion no se modifican ni se borran'
    using errcode = '42501';
end;
$fn$;

create trigger return_events_append_only
  before update or delete on public.return_events
  for each row execute function ebim.reject_return_log_rewrite();

-- ---------------------------------------------------------------------------
-- 10 · RLS. Default deny, `force`.
--
-- `return_reasons` es CONFIGURACION y la escribe el backoffice; el comprador
-- anonimo la LEE, porque sin motivos no puede rellenar la solicitud. Todo lo
-- demas se lee desde el backoffice y se mueve por los comandos de la migracion
-- 150500 — incluida la evidencia, que se adjunta con un comando para que la
-- fila y el objeto de Storage no puedan separarse.
-- ---------------------------------------------------------------------------
alter table public.return_reasons  enable row level security;
alter table public.return_reasons  force  row level security;
alter table public.return_requests enable row level security;
alter table public.return_requests force  row level security;
alter table public.return_items    enable row level security;
alter table public.return_items    force  row level security;
alter table public.return_events   enable row level security;
alter table public.return_events   force  row level security;
alter table public.return_evidence enable row level security;
alter table public.return_evidence force  row level security;

revoke all on public.return_reasons, public.return_requests, public.return_items,
              public.return_events, public.return_evidence
  from public, anon, authenticated;

grant all on public.return_reasons, public.return_requests, public.return_items,
             public.return_events, public.return_evidence
  to service_role;

grant select on public.return_requests, public.return_items, public.return_events,
                public.return_evidence
  to authenticated;
grant select, insert, update, delete on public.return_reasons to authenticated;

grant select (id, store_id, code, label, description, requires_evidence, position)
  on public.return_reasons to anon;

create policy return_reasons_select_member on public.return_reasons
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));
create policy return_reasons_write_admin on public.return_reasons
  for all to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));
create policy return_reasons_select_public on public.return_reasons
  for select to anon
  using (
    is_active
    and exists (
      select 1 from public.stores s
      where s.id = return_reasons.store_id and s.status = 'active'
    )
  );

create policy return_requests_select_member on public.return_requests
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy return_items_select_member on public.return_items
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy return_events_select_member on public.return_events
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy return_evidence_select_member on public.return_evidence
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- ---------------------------------------------------------------------------
-- 11 · Storage: el bucket de evidencia.
--
-- El layout es `{organization_id}/{store_id}/...`, el MISMO que los otros dos
-- buckets, asi que `ebim.can_write_store_object` (P02) vale tal cual y no hace
-- falta una segunda funcion que derive el tenant de una ruta. Lo que cambia es
-- el ROL: escribir evidencia es operar pedidos, no editar catalogo.
-- ---------------------------------------------------------------------------
create or replace function ebim.can_write_return_object(p_name text)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.stores s
    where s.id              = ebim.storage_store(p_name)
      and s.organization_id = ebim.storage_org(p_name)
      and ebim.has_role(s.organization_id, s.company_id,
                        array['owner','admin','orders']::public.app_role[])
  );
$fn$;

revoke execute on function ebim.can_write_return_object(text) from public;
grant execute on function ebim.can_write_return_object(text) to authenticated, service_role;

create policy ebim_objects_select_returns on storage.objects
  for select to authenticated
  using (bucket_id = 'return-evidence' and ebim.can_write_return_object(name));

create policy ebim_objects_insert_returns on storage.objects
  for insert to authenticated
  with check (bucket_id = 'return-evidence' and ebim.can_write_return_object(name));

create policy ebim_objects_delete_returns on storage.objects
  for delete to authenticated
  using (bucket_id = 'return-evidence' and ebim.can_write_return_object(name));

-- NO hay policy `to anon` sobre este bucket, ni de lectura ni de escritura, y
-- es la decision descrita arriba: la evidencia de una devolucion es un dato
-- personal de un comprador y no se publica.

-- ---------------------------------------------------------------------------
-- 12 · Comentarios.
-- ---------------------------------------------------------------------------
comment on table public.return_reasons is
  'Vocabulario de devolucion del comercio. Cada motivo decide si exige foto y si repone stock: no hay lista fija en el codigo.';
comment on table public.return_requests is
  'La solicitud de devolucion con su RMA y su ciclo. Apunta al pedido; el pedido no apunta a ella, y no hay enlace a ningun documento de ERP.';
comment on column public.return_requests.refund_amount is
  'Lo que el comercio DECIDIO devolver, no la suma de las lineas: hay portes no reembolsables y acuerdos. Lo escribe la inspeccion.';
comment on table public.return_items is
  'Que unidades vuelven, en que estado llegaron y si se reponen. El motivo es por linea: un pedido puede volver por dos razones distintas.';
comment on table public.return_evidence is
  'Ruta en un bucket PRIVADO por tenant. Ni el archivo ni una URL publica viven aqui; se accede con URL firmada que caduca.';
