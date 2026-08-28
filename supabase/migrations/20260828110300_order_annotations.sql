-- =============================================================================
-- P08-SaaS · 4/7 — Lo que el equipo escribe encima del pedido, y lo que otros
--                  sistemas escriben sobre el
--
-- Tres tablas pequeñas que resuelven tres problemas concretos de operacion, y
-- ninguna de las tres es «por si acaso»:
--
-- ## 1 · `order_notes` — la nota interna deja de pisar la del comprador
--
-- `orders.notes` la escribe `create_order` con lo que puso el COMPRADOR («dejar
-- con el portero») y la reescribe el backoffice desde P07 historico al cambiar
-- de estado. Son dos cosas distintas compartiendo una columna: cada anotacion
-- del equipo borra la instruccion de entrega del cliente. Separarlas es la
-- correccion, y la nota interna nace ademas como HILO —muchas filas con autor y
-- fecha— porque una sola columna de texto obliga a que el segundo que anota
-- borre al primero.
--
-- ## 2 · `order_tags` — triage, no taxonomia
--
-- «fraude», «urgente», «reclamo», «revisar direccion». Etiquetas planas, sin
-- jerarquia y sin catalogo previo: un tag que hay que dar de alta antes de
-- usarlo no se usa el dia que hace falta. El unico control es el formato, para
-- que «Urgente» y «urgente» no sean dos etiquetas distintas en el filtro.
--
-- ## 3 · `order_external_refs` — el pedido en los OTROS sistemas
--
-- Copia exacta del patron de `customer_external_ids` (P05), y por las mismas
-- razones: **el identificador externo es atributo, nunca clave**. No es unico
-- entre sistemas, cambia con la version del ERP y no existe para el pedido de
-- ayer. Por eso no hay una columna `erp_order_id` en `orders`: la primera
-- integracion la llenaria y la segunda tendria que inventarse otra.
--
-- `system_code` **sin FK** a `integration_providers`, igual que en P05: un
-- sistema del que todavia no hay conector declarado tambien emite numeros de
-- pedido, y no poder anotarlos hasta que exista el conector convierte una
-- limitacion de catalogo en una perdida de informacion.
--
-- `ref_type` es TEXTO y no un enum a proposito. El enum se puede cerrar cuando
-- se sabe la lista completa; aqui no se sabe y no se puede saber —factura,
-- guia, cobro, picking, nota de credito, expediente de aduanas—, y un enum
-- incompleto obliga a una migracion cada vez que un cliente conecta un sistema
-- nuevo. `system_code` si tiene formato cerrado porque identifica al SISTEMA,
-- que si es un conjunto que esta app conoce.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- order_notes — hilo interno del pedido
-- ---------------------------------------------------------------------------
create table public.order_notes (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  order_id        uuid        not null,
  body            text        not null,
  author_id       uuid,
  author_email    text,
  created_at      timestamptz not null default now(),
  constraint order_notes_body_len  check (char_length(btrim(body)) between 1 and 4000),
  constraint order_notes_email_len check (author_email is null or char_length(author_email) <= 320),
  constraint order_notes_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade,
  constraint order_notes_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete restrict
);

create index order_notes_order_idx  on public.order_notes (order_id, created_at desc);
create index order_notes_tenant_idx on public.order_notes (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- order_tags
-- ---------------------------------------------------------------------------
create table public.order_tags (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  order_id        uuid        not null,
  tag             text        not null,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  -- Minusculas obligatorias en el propio CHECK y no «por convencion en la app»:
  -- normalizar en el cliente deja el dia que alguien escriba por PostgREST dos
  -- etiquetas que el filtro trata como distintas.
  constraint order_tags_fmt check (tag ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  constraint order_tags_unique unique (order_id, tag),
  constraint order_tags_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade,
  constraint order_tags_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete restrict
);

create index order_tags_order_idx  on public.order_tags (order_id);
create index order_tags_lookup_idx on public.order_tags (store_id, tag);
create index order_tags_tenant_idx on public.order_tags (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- order_external_refs
-- ---------------------------------------------------------------------------
create table public.order_external_refs (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  order_id        uuid        not null,
  system_code     text        not null,
  ref_type        text        not null default 'order',
  external_id     text        not null,
  -- Enlace directo al documento en el sistema de origen, si lo hay. Ahorra el
  -- viaje de «copia el numero y buscalo alla».
  external_url    text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint order_external_refs_system_fmt
    check (system_code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint order_external_refs_type_fmt
    check (ref_type ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint order_external_refs_value_len
    check (char_length(btrim(external_id)) between 1 and 120),
  constraint order_external_refs_url_len
    check (external_url is null or char_length(external_url) between 8 and 2000),
  constraint order_external_refs_url_scheme
    check (external_url is null or external_url ~* '^https?://'),
  constraint order_external_refs_notes_len
    check (notes is null or char_length(notes) <= 500),
  -- Un pedido tiene UNA factura en el ERP y UNA guia en el transportista, pero
  -- puede tener las dos: la unicidad es por (sistema, tipo), no por sistema.
  constraint order_external_refs_one_per_kind unique (order_id, system_code, ref_type),
  constraint order_external_refs_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade,
  constraint order_external_refs_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete restrict
);

create index order_external_refs_order_idx  on public.order_external_refs (order_id);
create index order_external_refs_tenant_idx on public.order_external_refs (organization_id, company_id);
-- La consulta inversa —«¿que pedido es el 4500012345 del ERP?»— es la que hace
-- util la tabla cuando llega un webhook y solo trae el numero ajeno.
create unique index order_external_refs_lookup_idx
  on public.order_external_refs (organization_id, company_id, system_code, ref_type, lower(external_id));

create trigger order_external_refs_updated_at before update on public.order_external_refs
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- ebim.stamp_order_annotation — el tenant y el autor NO se envian, se derivan
--
-- El cliente manda `order_id` y el contenido; `organization_id`, `company_id`,
-- `store_id` y el autor salen de la fila del pedido y del JWT. Es la forma
-- estructural de la regla «el tenant siempre del token»: aunque alguien mande
-- los tres uuids en el cuerpo, se sobreescriben antes de tocar disco.
-- ---------------------------------------------------------------------------
create or replace function ebim.stamp_order_annotation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders o where o.id = new.order_id;

  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con ese identificador'
      using errcode = '22023';
  end if;

  new.organization_id := v_order.organization_id;
  new.company_id      := v_order.company_id;
  new.store_id        := v_order.store_id;

  if tg_table_name = 'order_notes' then
    new.author_id    := ebim.user_id();
    new.author_email := left(ebim.email(), 320);
  elsif tg_table_name = 'order_tags' then
    new.created_by := ebim.user_id();
    new.tag        := lower(btrim(new.tag));
  end if;

  return new;
end;
$fn$;

create trigger order_notes_stamp before insert on public.order_notes
  for each row execute function ebim.stamp_order_annotation();
create trigger order_tags_stamp before insert on public.order_tags
  for each row execute function ebim.stamp_order_annotation();
create trigger order_external_refs_stamp before insert on public.order_external_refs
  for each row execute function ebim.stamp_order_annotation();

revoke execute on function ebim.stamp_order_annotation() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS · default deny en las tres. Lectura: miembro del tenant. Escritura: rol.
--
-- `anon` no recibe NADA de ninguna de las tres, y es la parte importante: la
-- nota interna «cliente moroso, exigir pago adelantado» y el tag «fraude» son
-- exactamente lo que no puede salir por la puerta del comprador. La funcion
-- `public.order_by_token` (P11 historico) no las lee ni las leera.
-- ---------------------------------------------------------------------------
alter table public.order_notes         enable row level security;
alter table public.order_notes         force  row level security;
alter table public.order_tags          enable row level security;
alter table public.order_tags          force  row level security;
alter table public.order_external_refs enable row level security;
alter table public.order_external_refs force  row level security;

revoke all on public.order_notes, public.order_tags, public.order_external_refs
  from public, anon, authenticated;

grant select on public.order_notes, public.order_tags, public.order_external_refs
  to authenticated;
grant insert on public.order_notes, public.order_tags, public.order_external_refs
  to authenticated;
grant delete on public.order_notes, public.order_tags, public.order_external_refs
  to authenticated;
-- UPDATE solo en las referencias externas: un numero de factura se corrige
-- cuando el ERP lo reemite. Una nota escrita NO se reescribe —para eso esta
-- borrarla y escribir otra, que deja fecha nueva— y un tag es un booleano con
-- nombre: se pone o se quita.
grant update (external_id, external_url, notes) on public.order_external_refs to authenticated;

grant all on public.order_notes, public.order_tags, public.order_external_refs to service_role;

create policy order_notes_select_member on public.order_notes
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy order_notes_insert_orders_role on public.order_notes
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

-- Borrar la nota de OTRO es reescribir el relato de otra persona. Solo el autor,
-- o quien administra el tenant y responde por el.
create policy order_notes_delete_author on public.order_notes
  for delete to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (author_id = ebim.user_id()
         or ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  );

create policy order_tags_select_member on public.order_tags
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy order_tags_write_orders_role on public.order_tags
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy order_tags_delete_orders_role on public.order_tags
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy order_external_refs_select_member on public.order_external_refs
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy order_external_refs_insert_orders_role on public.order_external_refs
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy order_external_refs_update_orders_role on public.order_external_refs
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy order_external_refs_delete_orders_role on public.order_external_refs
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

comment on table public.order_notes is
  'Hilo interno del pedido. Separado de orders.notes, que es la instruccion del COMPRADOR y no puede pisarse cada vez que el equipo anota algo. Sin acceso para anon.';
comment on table public.order_tags is
  'Etiquetas planas de triage. Normalizadas a minusculas por CHECK y por trigger: no hay dos "urgente" distintos. Sin acceso para anon.';
comment on table public.order_external_refs is
  'Como se llama este pedido en cada sistema externo. Atributo, nunca clave. system_code sin FK a integration_providers: un sistema sin conector tambien emite numeros.';
comment on column public.order_external_refs.ref_type is
  'Que documento identifica la referencia (order, invoice, shipment, payment...). TEXTO y no enum: la lista no se puede cerrar sin obligar a una migracion por cada sistema nuevo.';
