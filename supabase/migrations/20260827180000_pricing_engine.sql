-- =============================================================================
-- P04-SaaS · Motor de precios: listas, escalas, vigencias y asignaciones
--
-- Hasta aqui el precio de eCommerce era `products.price` (mas `product_uoms.price`
-- para la caja y la herencia de la variante). Una columna escalar responde bien
-- a "cuanto cuesta esto" y no responde en absoluto a la pregunta que hace
-- cualquier negocio B2B: "cuanto cuesta esto PARA ESTE CLIENTE, POR ESTE CANAL,
-- EN ESTA CANTIDAD, HOY". Con una sola columna, la unica forma de contestarla
-- es duplicar el producto por canal —que es justo lo que la fase de canales
-- prohibio al no darle tienda propia a cada canal— o cablear un `if` por
-- cliente, que es lo que el principio 2 del contrato prohibe.
--
-- Cuatro tablas y un vocabulario:
--
--   customer_segments      · el grupo comercial al que pertenece un comprador.
--                            Vocabulario de la SOCIEDAD, como marcas y familias.
--   price_lists            · el acuerdo: moneda, vigencia y prioridad.
--   price_list_items       · el precio: producto/variante, presentacion y escala.
--   price_list_assignments · A QUIEN se le aplica: tienda, canal, segmento o
--                            cliente. Una lista sin asignacion no se aplica a
--                            nadie, y eso es deliberado.
--   price_change_events    · bitacora de cambios de precio.
--
-- Lo que esta migracion NO hace, y no por falta de sitio:
--
--  · **No toca `products.price`.** Sigue siendo el precio de catalogo y sigue
--    siendo el fallback cuando ninguna lista alcanza. Retirarlo obligaria a dar
--    de alta una lista antes de poder vender nada, y convertiria el alta de un
--    tenant en un proyecto.
--  · **No mezcla promociones.** Un descuento por campana o por cupon es OTRA
--    capa (P10) que recibe este resultado. Mezclarlas produce un motor que
--    nadie sabe explicar cuando un precio sale mal, que es exactamente el
--    momento en que hay que explicarlo.
--  · **No decide el precio en el navegador.** Aqui no hay nada que el cliente
--    pueda declarar: la resolucion vive en `20260827180100`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- customer_segments — el grupo comercial.
--
-- Sin `store_id`: es vocabulario de la sociedad, igual que marcas, familias y
-- unidades. "Mayorista" o "Institucional" no cambian de significado entre dos
-- tiendas de la misma empresa, y obligar a redefinirlos por tienda
-- multiplicaria el mantenimiento sin separar ninguna decision.
--
-- La tabla `customers` es P05. Este segmento existe ANTES que ella a proposito:
-- la asignacion por segmento es una capacidad del motor de precios, no de la
-- ficha del cliente, y sin ella P04 no podria demostrar la precedencia que
-- tiene que fijar. Cuando llegue P05, `customers` gana una FK hacia aqui.
-- ---------------------------------------------------------------------------
create table public.customer_segments (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  code            text        not null,
  name            text        not null,
  description     text,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint customer_segments_code_fmt check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint customer_segments_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint customer_segments_desc_len
    check (description is null or char_length(description) <= 500),
  constraint customer_segments_unique     unique (organization_id, company_id, code),
  constraint customer_segments_tenant_key unique (id, organization_id, company_id)
);

create index customer_segments_tenant_idx on public.customer_segments (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- price_lists — el ACUERDO, no el precio.
--
-- Cuatro columnas gobiernan el motor entero y ninguna es decorativa:
--
--  · `currency` — una lista vale para UNA moneda. Guardar precios de dos
--    monedas en la misma lista obligaria a llevar la moneda en cada renglon y a
--    resolver "que renglon vale" con una regla mas; asi, una lista en USD
--    simplemente no aplica a una tienda en PEN, y el diagnostico lo dice.
--  · `valid_from`/`valid_to` — la vigencia. Una lista de temporada se da de
--    alta antes y se apaga sola; retocar precios a mano el dia que arranca la
--    campana es como se factura la campana del ano pasado.
--  · `priority` — el desempate DENTRO del mismo alcance. Entre alcances manda
--    la especificidad (cliente > segmento > canal > tienda), que no es
--    configurable a proposito: si lo fuera, un precio negociado podria quedar
--    por debajo del precio general sin que nadie lo viera venir.
--  · `is_active` — el interruptor. Borrar una lista con historico detras es
--    perder la explicacion de lo que ya se cobro.
-- ---------------------------------------------------------------------------
create table public.price_lists (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  code            text        not null,
  name            text        not null,
  currency        char(3)     not null references public.currencies (code) on delete restrict,
  -- 0..1000. El rango existe para que "prioridad alta" signifique lo mismo en
  -- dos tiendas y para que nadie invente 999999 como forma de ganar siempre.
  priority        integer     not null default 0,
  valid_from      timestamptz not null default now(),
  valid_to        timestamptz,
  is_active       boolean     not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint price_lists_code_fmt       check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint price_lists_name_len       check (char_length(btrim(name)) between 1 and 120),
  constraint price_lists_priority_range check (priority between 0 and 1000),
  constraint price_lists_period         check (valid_to is null or valid_to > valid_from),
  constraint price_lists_notes_len      check (notes is null or char_length(notes) <= 1000),
  constraint price_lists_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint price_lists_code_unique unique (store_id, code),
  constraint price_lists_store_key   unique (id, store_id),
  constraint price_lists_tenant_key  unique (id, organization_id, company_id)
);

create index price_lists_tenant_idx on public.price_lists (organization_id, company_id);
-- El indice que usa la resolucion: de una tienda, las listas vivas.
create index price_lists_active_idx
  on public.price_lists (store_id, valid_from desc) where is_active;

-- Clave de apoyo para que una linea de precio no pueda apuntar a una variante
-- de OTRO producto. Es la misma tecnica del PIM: la FK compuesta hace imposible
-- el estado, en vez de confiar en que la pantalla no lo escriba.
alter table public.product_variants
  add constraint product_variants_product_key unique (id, product_id);

-- ---------------------------------------------------------------------------
-- price_list_items — el precio, con sus tres dimensiones.
--
--  1. QUE: `product_id` y, opcionalmente, `variant_id`. Sin variante, el precio
--     vale para todas las del producto; con variante, solo para esa.
--  2. EN QUE PRESENTACION: `uom_id`. NULL = precio de la unidad base, que se
--     multiplica por el factor de la presentacion pedida. Con valor = precio
--     ABSOLUTO de esa presentacion, que es lo que permite que la caja no valga
--     doce veces la unidad.
--  3. DESDE CUANTAS: `min_quantity`, la escala. Se mide SIEMPRE en unidades
--     base, nunca en unidades de venta: si se midiera en unidades de venta,
--     comprar 10 cajas de 12 no alcanzaria una escala de 100 y cambiar de
--     presentacion cambiaria el descuento sin que nadie lo hubiera decidido.
--
-- `unit_price` es el precio de UNA unidad base (o de una unidad de la
-- presentacion, si `uom_id` no es nulo). Nunca un total de linea: el total lo
-- calcula quien cotiza, y tenerlo aqui seria un segundo sitio donde el mismo
-- numero puede estar mal.
-- ---------------------------------------------------------------------------
create table public.price_list_items (
  id               uuid          primary key default gen_random_uuid(),
  organization_id  uuid          not null,
  company_id       uuid          not null,
  store_id         uuid          not null,
  price_list_id    uuid          not null,
  product_id       uuid          not null,
  variant_id       uuid,
  uom_id           uuid,
  min_quantity     numeric(18,6) not null default 1,
  unit_price       numeric(14,2) not null,
  -- Precio de REFERENCIA de esta lista: el tachado. Separado del de catalogo
  -- porque un mayorista y un minorista no comparan contra el mismo numero.
  compare_at_price numeric(14,2),
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now(),
  constraint price_list_items_min_quantity   check (min_quantity > 0),
  constraint price_list_items_price_positive check (unit_price >= 0),
  -- Un tachado por debajo del precio real anuncia un descuento negativo.
  constraint price_list_items_compare_above
    check (compare_at_price is null or compare_at_price >= unit_price),
  constraint price_list_items_list_fk foreign key (price_list_id, store_id)
    references public.price_lists (id, store_id) on delete cascade,
  constraint price_list_items_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  -- MATCH SIMPLE: con `variant_id` nulo la FK no se comprueba, que es
  -- exactamente lo que queremos (precio para todas las variantes). Con valor,
  -- obliga a que la variante sea DE ESE producto.
  constraint price_list_items_variant_fk foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete cascade,
  -- Idem: una presentacion solo se puede tarifar si ESE producto la tiene
  -- configurada. Referencia `product_uoms` y no `units_of_measure` justo por
  -- eso: el factor de conversion es del producto, no del vocabulario.
  constraint price_list_items_uom_fk foreign key (product_id, uom_id)
    references public.product_uoms (product_id, uom_id) on delete cascade,
  constraint price_list_items_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

-- Dos escalas iguales para lo mismo dentro de la misma lista es una ambiguedad
-- que ningun orden de filas puede resolver. Van en dos indices parciales y no
-- en uno solo porque la variante y el producto son dos espacios distintos:
-- "todas las variantes desde 10" y "la roja desde 10" conviven, y deben.
create unique index price_list_items_scale_product
  on public.price_list_items (price_list_id, product_id, coalesce(uom_id, product_id), min_quantity)
  where variant_id is null;
create unique index price_list_items_scale_variant
  on public.price_list_items (price_list_id, variant_id, coalesce(uom_id, variant_id), min_quantity)
  where variant_id is not null;

-- El indice de la resolucion: dada una lista y un producto, la escala. Es lo
-- que hace que cotizar un carrito de 50 lineas contra 5 listas siga siendo un
-- punado de accesos por indice y no un recorrido del catalogo.
create index price_list_items_lookup
  on public.price_list_items (price_list_id, product_id, min_quantity);
create index price_list_items_variant_idx
  on public.price_list_items (variant_id) where variant_id is not null;
create index price_list_items_tenant_idx
  on public.price_list_items (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- price_list_assignments — a quien se le aplica.
--
-- El alcance esta en columnas TIPADAS y no en un par (tipo, uuid) generico: con
-- el par generico no hay FK posible, y una asignacion que apunta a un canal
-- borrado se queda viva decidiendo precios. El CHECK obliga a que la columna
-- rellenada sea la que corresponde al alcance declarado.
--
-- `customer_id` va SIN FK y es la unica de las cuatro: la tabla `customers` es
-- P05. Es una deuda declarada, no un descuido — el aislamiento no depende de
-- ella (lo garantiza `store_id` via `stores`), ninguna resolucion la inventa
-- (solo aplica si el llamante SERVIDOR pasa un cliente concreto, y el
-- storefront anonimo nunca pasa ninguno), y P05 anade la FK con su migracion.
-- ---------------------------------------------------------------------------
create type public.price_scope as enum ('store', 'channel', 'segment', 'customer');

create table public.price_list_assignments (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  price_list_id   uuid        not null,
  scope           public.price_scope not null,
  channel_id      uuid,
  segment_id      uuid,
  customer_id     uuid,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint price_list_assignments_scope_target check (
    (scope = 'store'    and channel_id is null     and segment_id is null     and customer_id is null) or
    (scope = 'channel'  and channel_id is not null and segment_id is null     and customer_id is null) or
    (scope = 'segment'  and channel_id is null     and segment_id is not null and customer_id is null) or
    (scope = 'customer' and channel_id is null     and segment_id is null     and customer_id is not null)
  ),
  constraint price_list_assignments_list_fk foreign key (price_list_id, store_id)
    references public.price_lists (id, store_id) on delete cascade,
  constraint price_list_assignments_channel_fk foreign key (channel_id, store_id)
    references public.channels (id, store_id) on delete cascade,
  constraint price_list_assignments_segment_fk foreign key (segment_id, organization_id, company_id)
    references public.customer_segments (id, organization_id, company_id) on delete cascade,
  constraint price_list_assignments_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  -- `nulls not distinct`: sin esto la misma lista se podria asignar mil veces a
  -- la misma tienda, porque NULL <> NULL.
  constraint price_list_assignments_unique unique nulls not distinct
    (price_list_id, scope, channel_id, segment_id, customer_id)
);

create index price_list_assignments_list_idx  on public.price_list_assignments (price_list_id);
create index price_list_assignments_store_idx on public.price_list_assignments (store_id, scope) where is_active;
create index price_list_assignments_channel_idx  on public.price_list_assignments (channel_id)  where channel_id  is not null;
create index price_list_assignments_segment_idx  on public.price_list_assignments (segment_id)  where segment_id  is not null;
create index price_list_assignments_customer_idx on public.price_list_assignments (customer_id) where customer_id is not null;
create index price_list_assignments_tenant_idx on public.price_list_assignments (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- price_change_events — la bitacora.
--
-- Un precio mal puesto se descubre DESPUES, cuando alguien reclama por lo que
-- pago. Sin bitacora, la unica respuesta posible es "ahora dice esto"; con
-- ella, se puede decir quien lo cambio y desde que valor.
--
-- SIN FK hacia `price_lists` ni hacia `price_list_items` a proposito: la
-- bitacora tiene que sobrevivir al borrado de la lista, que es precisamente el
-- caso en que hace falta. Los ids se guardan como referencia historica, no como
-- enlace vivo.
--
-- Se escribe SOLO por trigger `SECURITY DEFINER` (contrato: bitacora por
-- funcion validada). `authenticated` puede leerla y no puede tocarla; `anon` no
-- tiene nada.
-- ---------------------------------------------------------------------------
create table public.price_change_events (
  id                 uuid          primary key default gen_random_uuid(),
  organization_id    uuid          not null,
  company_id         uuid          not null,
  store_id           uuid          not null,
  price_list_id      uuid,
  price_list_item_id uuid,
  product_id         uuid,
  variant_id         uuid,
  action             text          not null,
  old_unit_price     numeric(14,2),
  new_unit_price     numeric(14,2),
  old_min_quantity   numeric(18,6),
  new_min_quantity   numeric(18,6),
  -- Quien lo hizo, tal y como lo dice el JWT. NULL cuando lo hace el servidor
  -- (una importacion, una sincronizacion): tambien es informacion.
  actor_id           uuid,
  actor_email        text,
  occurred_at        timestamptz   not null default now(),
  created_at         timestamptz   not null default now(),
  constraint price_change_events_action check (action in ('insert', 'update', 'delete'))
);

create index price_change_events_tenant_idx on public.price_change_events (organization_id, company_id);
create index price_change_events_store_idx  on public.price_change_events (store_id, occurred_at desc);
create index price_change_events_list_idx   on public.price_change_events (price_list_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- El trigger de bitacora.
--
-- `SECURITY DEFINER` porque `price_change_events` no tiene policy de INSERT
-- para nadie: la unica escritura posible es esta, y asi una fila de bitacora no
-- se puede fabricar ni borrar desde el cliente. La autorizacion va DENTRO
-- (leccion esupplier-030): la funcion no acepta parametros, deriva el tenant de
-- la propia fila que se esta escribiendo —que ya paso por la RLS de
-- `price_list_items`— y el actor del JWT. No hay forma de usarla para escribir
-- en el tenant de al lado, porque no hay forma de decirle cual.
-- ---------------------------------------------------------------------------
create or replace function ebim.log_price_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.price_list_items := coalesce(new, old);
begin
  insert into public.price_change_events (
    organization_id, company_id, store_id,
    price_list_id, price_list_item_id, product_id, variant_id,
    action, old_unit_price, new_unit_price, old_min_quantity, new_min_quantity,
    actor_id, actor_email
  ) values (
    v_row.organization_id, v_row.company_id, v_row.store_id,
    v_row.price_list_id, v_row.id, v_row.product_id, v_row.variant_id,
    lower(tg_op), old.unit_price, new.unit_price, old.min_quantity, new.min_quantity,
    ebim.user_id(), ebim.email()
  );
  return coalesce(new, old);
end;
$fn$;

-- En UPDATE se compara antes de anotar: un update que no toca precio ni escala
-- no es un cambio de precio, y anotarlo llenaria la bitacora de ruido hasta
-- hacerla inutil, que es la forma habitual de perder una bitacora.
create trigger price_list_items_audit_insert
  after insert on public.price_list_items
  for each row execute function ebim.log_price_change();

create trigger price_list_items_audit_update
  after update on public.price_list_items
  for each row
  when (old.unit_price is distinct from new.unit_price
        or old.min_quantity is distinct from new.min_quantity
        or old.compare_at_price is distinct from new.compare_at_price)
  execute function ebim.log_price_change();

create trigger price_list_items_audit_delete
  after delete on public.price_list_items
  for each row execute function ebim.log_price_change();

revoke execute on function ebim.log_price_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create trigger customer_segments_set_updated_at before update on public.customer_segments
  for each row execute function ebim.set_updated_at();
create trigger price_lists_set_updated_at before update on public.price_lists
  for each row execute function ebim.set_updated_at();
create trigger price_list_items_set_updated_at before update on public.price_list_items
  for each row execute function ebim.set_updated_at();
create trigger price_list_assignments_set_updated_at before update on public.price_list_assignments
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS · default deny en las cinco tablas.
--
-- Escritura: rol (owner/admin/catalog) **Y** capacidad `pricing.lists`. Los dos
-- ejes, como manda el diseno de capacidades: un `admin` de un tenant que no
-- contrato el modulo no puede crear listas, y un `viewer` de uno que si lo
-- contrato, tampoco.
--
-- Lectura: solo `ebim.can_access`, sin capacidad. Si un tenant deja de pagar el
-- modulo, sus listas dejan de APLICARSE (lo comprueba la resolucion) pero se
-- siguen VIENDO: esconderlas convertiria una baja comercial en una perdida de
-- datos aparente, y quien atiende la baja necesita poder mirarlas.
--
-- `anon` no tiene ni un GRANT sobre ninguna de estas tablas. La vitrina publica
-- ve precios YA RESUELTOS a traves de las vistas de `20260827180100`, nunca la
-- lista ni a quien se le aplica: que el vecino tenga un precio negociado es
-- informacion comercial de la sociedad, no del catalogo.
-- ---------------------------------------------------------------------------
alter table public.customer_segments      enable row level security;
alter table public.customer_segments      force  row level security;
alter table public.price_lists            enable row level security;
alter table public.price_lists            force  row level security;
alter table public.price_list_items       enable row level security;
alter table public.price_list_items       force  row level security;
alter table public.price_list_assignments enable row level security;
alter table public.price_list_assignments force  row level security;
alter table public.price_change_events    enable row level security;
alter table public.price_change_events    force  row level security;

revoke all on public.customer_segments      from public, anon, authenticated;
revoke all on public.price_lists            from public, anon, authenticated;
revoke all on public.price_list_items       from public, anon, authenticated;
revoke all on public.price_list_assignments from public, anon, authenticated;
revoke all on public.price_change_events    from public, anon, authenticated;

grant select, insert, update, delete on public.customer_segments      to authenticated;
grant select, insert, update, delete on public.price_lists            to authenticated;
grant select, insert, update, delete on public.price_list_items       to authenticated;
grant select, insert, update, delete on public.price_list_assignments to authenticated;
-- La bitacora no se escribe desde el cliente, ni con el rol mas alto.
grant select on public.price_change_events to authenticated;

grant all on public.customer_segments, public.price_lists, public.price_list_items,
             public.price_list_assignments, public.price_change_events
  to service_role;

create policy customer_segments_select_member on public.customer_segments
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy customer_segments_insert_admin on public.customer_segments
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

create policy customer_segments_update_admin on public.customer_segments
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

create policy customer_segments_delete_admin on public.customer_segments
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

create policy price_lists_select_member on public.price_lists
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy price_lists_insert_admin on public.price_lists
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

create policy price_lists_update_admin on public.price_lists
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

create policy price_lists_delete_admin on public.price_lists
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

create policy price_list_items_select_member on public.price_list_items
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy price_list_items_insert_admin on public.price_list_items
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

create policy price_list_items_update_admin on public.price_list_items
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

create policy price_list_items_delete_admin on public.price_list_items
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

-- La asignacion es la decision comercial de a QUIEN se le cobra distinto, asi
-- que se reserva a owner/admin: `catalog` puede mantener precios, no decidir
-- que cliente entra en que acuerdo.
create policy price_list_assignments_select_member on public.price_list_assignments
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy price_list_assignments_insert_admin on public.price_list_assignments
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

create policy price_list_assignments_update_admin on public.price_list_assignments
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

create policy price_list_assignments_delete_admin on public.price_list_assignments
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'pricing.lists')
  );

-- La bitacora: se lee, no se toca. No hay policy de INSERT/UPDATE/DELETE para
-- `authenticated` y eso es la mitad de la garantia; la otra mitad es que el
-- GRANT tampoco existe.
create policy price_change_events_select_member on public.price_change_events
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- ---------------------------------------------------------------------------
comment on table public.customer_segments is
  'Grupo comercial de la sociedad (mayorista, institucional...). Vocabulario compartido por sus tiendas; P05 le cuelga los clientes.';
comment on table public.price_lists is
  'Acuerdo de precio: moneda, vigencia y prioridad. Una lista sin asignacion no se aplica a nadie.';
comment on column public.price_lists.priority is
  'Desempate DENTRO del mismo alcance. Entre alcances manda la especificidad (cliente > segmento > canal > tienda) y no es configurable.';
comment on table public.price_list_items is
  'Precio por producto/variante, presentacion y escala. min_quantity se mide SIEMPRE en unidades base.';
comment on column public.price_list_items.uom_id is
  'NULL = precio de la unidad base (se multiplica por el factor). Con valor = precio ABSOLUTO de esa presentacion.';
comment on column public.price_list_items.min_quantity is
  'Escala en UNIDADES BASE. Medirla en unidades de venta haria que cambiar de presentacion cambiara el descuento.';
comment on table public.price_list_assignments is
  'A quien se aplica una lista: tienda, canal, segmento o cliente. El alcance va en columnas tipadas para que exista FK.';
comment on column public.price_list_assignments.customer_id is
  'Sin FK: la tabla customers es P05, que la anade. El aislamiento no depende de esta columna sino de store_id.';
comment on table public.price_change_events is
  'Bitacora de cambios de precio. Sin FK a proposito: tiene que sobrevivir al borrado de la lista. Se escribe solo por trigger DEFINER.';
