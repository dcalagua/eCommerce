-- =============================================================================
-- P12-SaaS · 2/7 — El DESPACHO: fulfillments, envios, lineas y seguimiento
--
-- ## La distincion que sostiene la fase entera
--
-- **Un pedido no es un fulfillment.** Son entidades relacionadas y no la misma
-- (regla 1 del encargo), y la diferencia se ve en cuanto un pedido de tres
-- lineas sale en dos cajas desde dos almacenes en dos dias distintos: eso es
-- UN pedido y DOS fulfillments, cada uno con su almacen, su ventana, su estado
-- y su transportista. Modelarlo como un solo estado en `orders` obliga a elegir
-- cual de los dos es «el» estado, y no hay respuesta correcta.
--
-- Por eso la direccion de las claves es la que es, y no la contraria:
--
--     fulfillment ──► order          (tres FK del despacho al pedido)
--     order       ─X─► fulfillment   (CERO columnas nuevas en `orders`)
--
-- Es la misma decision que P09 tomo con los cobros y por la misma razon:
-- añadir un operador logistico nuevo no puede exigir una migracion sobre el
-- dominio de pedidos. Lo que `orders` si conserva es `fulfillment_status`, que
-- P08 ya tenia: un ESPEJO derivado de las cantidades despachadas, escrito por
-- `ebim.fulfillment_sync_order` (migracion 150300) — no una fuente de verdad.
--
-- ## Las cuatro piezas y por que son cuatro
--
--   fulfillments      LA PROMESA DE ENTREGA de una parte del pedido: desde
--                     donde sale, como llega, cuando y cuanto costo. Existe
--                     aunque no haya transportista —un recojo en tienda es un
--                     fulfillment completo— y por eso no se llama «envio».
--   fulfillment_items QUE UNIDADES de cada linea entran en esa promesa. Es lo
--                     que hace posible el despacho PARCIAL (regla 2), y lo que
--                     un trigger impide que sume mas de lo que se compro.
--   shipments         EL BULTO que un operador movio, con su guia y su coste
--                     real. Un fulfillment puede tener dos —el primero se
--                     perdio— y sin tabla aparte el segundo pisaria al primero.
--   tracking_events   LO QUE PASO POR EL CAMINO, normalizado. Append-only y
--                     deduplicado por el identificador del evento del operador:
--                     un webhook reenviado veinte veces es UNA fila.
--
-- ## El vocabulario canonico de seguimiento
--
-- `tracking_status` es el traductor universal (regla 5). Cada operador tiene su
-- jerga —«EN RUTA», «OUT_FOR_DEL», codigo 47— y ninguna entra en esta base como
-- estado: entra en `provider_status`, que se guarda TAL CUAL para diagnosticar,
-- y el adaptador dice a cual de los diez estados canonicos corresponde. Sin
-- esa traduccion, la pantalla del backoffice tendria un `switch` por operador.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 · El vocabulario.
-- ---------------------------------------------------------------------------

-- Ciclo de la PROMESA de entrega. `ready` es de primera clase y no un
-- `packed` con matiz: en un recojo significa «el comprador ya puede venir», que
-- es cuando se le avisa, y en un envio «esperando a que pase el operador».
create type public.fulfillment_state as enum (
  'pending',     -- creado; todavia no se sabe de donde sale
  'allocated',   -- almacen o punto asignado
  'picking',     -- se esta preparando
  'packed',      -- preparado
  'ready',       -- listo para salir o para que lo recojan
  'in_transit',  -- en camino
  'delivered',   -- entregado o recogido
  'failed',      -- no se pudo entregar; se puede reintentar
  'cancelled'
);

-- Ciclo del BULTO. Se parece al anterior y NO es el mismo: un fulfillment
-- puede estar `in_transit` con su primer envio ya `returned` y el segundo
-- `created`. Fundirlos obligaria a que el reintento borrara la historia.
create type public.shipment_state as enum (
  'draft',
  'created',           -- guia emitida
  'picked_up',         -- el operador lo recogio
  'in_transit',
  'out_for_delivery',  -- reparto del ultimo tramo
  'delivered',
  'failed',
  'returned',
  'cancelled'
);

-- El vocabulario CANONICO al que se traduce cualquier operador (regla 5).
-- `info` existe para que un aviso que no mueve nada —«documentacion recibida»—
-- se pueda registrar sin inventarle un estado que si mueve.
create type public.tracking_status as enum (
  'label_created',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivery_attempted',
  'delivered',
  'exception',
  'returned',
  'cancelled',
  'info'
);

-- De donde salio el hecho de seguimiento. `provider_webhook` es lo unico que
-- puede mover un envio sin que nadie lo pida; `provider_poll` es la consulta
-- que hacemos nosotros, y distinguirlas importa cuando hay que explicar por que
-- un estado llego tarde.
create type public.tracking_source as enum (
  'provider_webhook',
  'provider_poll',
  'operator',
  'system'
);

-- ---------------------------------------------------------------------------
-- 2 · Clave de apoyo sobre `order_items`.
--
-- Permite que `fulfillment_items` exija con una FK COMPUESTA —no con un
-- trigger— que la linea despachada sea de la misma tienda que el fulfillment.
-- Sin ella, una FK simple contra `order_items (id)` dejaria pasar la linea de
-- un pedido de otra tienda del mismo tenant. Es el mismo patron que ya usan
-- `orders (id, store_id)` y `payment_methods (id, store_id)`.
-- ---------------------------------------------------------------------------
alter table public.order_items
  add constraint order_items_store_key unique (id, store_id);

-- ---------------------------------------------------------------------------
-- 3 · fulfillments — la promesa de entrega.
--
-- Todo lo que aqui se guarda del metodo (`strategy`, `provider_code`,
-- `shipping_cost`, plazos) es SNAPSHOT y no referencia viva, por la misma razon
-- que el snapshot del pedido en P08: si mañana el comercio cambia de operador o
-- sube la tarifa, lo que se prometio ayer tiene que seguir diciendo la verdad.
-- `delivery_method_id` se conserva para poder navegar, pero nada se recalcula
-- desde el.
-- ---------------------------------------------------------------------------
create table public.fulfillments (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null,
  company_id         uuid        not null,
  store_id           uuid        not null,
  order_id           uuid        not null,
  -- 1, 2, 3... dentro del pedido. Es lo que la pantalla enseña como
  -- «Entrega 2 de 3» y lo que hace que un despacho parcial se pueda nombrar.
  sequence           integer     not null,
  -- Referencia viva al metodo, solo para navegar. Puede quedar en NULL si el
  -- comercio retira el metodo; el snapshot de al lado sigue intacto.
  delivery_method_id uuid,
  -- ---- SNAPSHOT del metodo, congelado al planificar ----------------------
  method_code        text        not null,
  method_name        text        not null,
  strategy           public.delivery_strategy not null,
  -- Operador con el que se prometio. NULL = recojo, reparto propio o digital.
  provider_code      text,
  -- ---- De donde sale ------------------------------------------------------
  warehouse_id       uuid,
  pickup_point_id    uuid,
  -- ---- Cuando -------------------------------------------------------------
  window_date        date,
  window_starts_at   time,
  window_ends_at     time,
  -- Plazo prometido, ya resuelto a fecha. Es contra esto contra lo que se mide
  -- si se llego tarde; el plazo en dias del metodo puede cambiar mañana.
  promised_from      date,
  promised_to        date,
  -- ---- Cuanto -------------------------------------------------------------
  currency           char(3)     not null,
  -- Lo que se le COBRO al comprador por esta entrega. Es la parte de
  -- `orders.shipping_total` que corresponde a este fulfillment.
  shipping_cost      numeric(14,2) not null default 0,
  -- Peso declarado del bulto, si el catalogo lo sabe. NULL no es cero.
  weight             numeric(12,3),
  -- ---- A donde ------------------------------------------------------------
  -- Copia de la direccion en el momento de planificar. `orders.shipping_address`
  -- sigue siendo editable por el backoffice (GRANT de P02) y esta copia no:
  -- corregir un portal antes de despachar es legitimo, reescribir a donde se
  -- entrego algo que ya salio no lo es.
  address            jsonb       not null default '{}'::jsonb,
  contact_name       text,
  contact_phone      text,
  state              public.fulfillment_state not null default 'pending',
  cancel_reason      text,
  allocated_at       timestamptz,
  shipped_at         timestamptz,
  delivered_at       timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint fulfillments_sequence check (sequence between 1 and 1000),
  constraint fulfillments_method_code_fmt check (method_code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint fulfillments_method_name_len
    check (char_length(btrim(method_name)) between 1 and 120),
  constraint fulfillments_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint fulfillments_cost_non_negative check (shipping_cost >= 0),
  constraint fulfillments_weight_non_negative check (weight is null or weight >= 0),
  constraint fulfillments_address_shape check (jsonb_typeof(address) = 'object'),
  constraint fulfillments_contact_len check (
    (contact_name is null or char_length(contact_name) <= 200)
    and (contact_phone is null or char_length(contact_phone) <= 40)
  ),
  constraint fulfillments_cancel_reason_len
    check (cancel_reason is null or char_length(cancel_reason) <= 1000),
  constraint fulfillments_window_shape check (
    (window_starts_at is null) = (window_ends_at is null)
    and (window_ends_at is null or window_ends_at > window_starts_at)
  ),
  constraint fulfillments_promise_shape check (
    promised_from is null or promised_to is null or promised_to >= promised_from
  ),
  -- Un recojo SIN punto de recojo es una promesa que nadie puede cumplir: el
  -- comprador no sabe a donde ir. Se impide en la base y no en el formulario.
  constraint fulfillments_pickup_shape check (
    strategy <> 'pickup' or pickup_point_id is not null
  ),
  -- Nadie transporta un recojo ni una descarga (mismo CHECK que el metodo).
  constraint fulfillments_provider_shape check (
    provider_code is null or strategy = 'ship'
  ),
  constraint fulfillments_order_unique unique (order_id, sequence),
  -- Claves de apoyo para las FK compuestas de los hijos.
  constraint fulfillments_store_key unique (id, store_id),
  constraint fulfillments_order_key unique (id, order_id),
  constraint fulfillments_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade,
  constraint fulfillments_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint fulfillments_method_fk foreign key (delivery_method_id, store_id)
    references public.delivery_methods (id, store_id) on delete set null,
  constraint fulfillments_point_fk foreign key (pickup_point_id, store_id)
    references public.pickup_points (id, store_id) on delete set null,
  constraint fulfillments_warehouse_fk foreign key (warehouse_id, organization_id, company_id)
    references public.warehouses (id, organization_id, company_id) on delete set null,
  constraint fulfillments_provider_fk foreign key (provider_code)
    references public.integration_providers (code) on delete restrict
);

create index fulfillments_tenant on public.fulfillments (organization_id, company_id);
create index fulfillments_order on public.fulfillments (order_id, sequence);
-- La cola de trabajo del backoffice: «que hay pendiente en esta tienda».
create index fulfillments_store_state
  on public.fulfillments (store_id, state, created_at desc);
create index fulfillments_warehouse
  on public.fulfillments (warehouse_id, state) where warehouse_id is not null;
create index fulfillments_window
  on public.fulfillments (store_id, window_date) where window_date is not null;

create trigger fulfillments_set_updated_at before update on public.fulfillments
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4 · fulfillment_items — que unidades entran en la promesa.
--
-- Esta tabla ES el despacho parcial. Sin ella, «se envio parte» seria un texto
-- en una nota y nadie podria responder «¿que falta?» sin abrir el correo.
--
-- `quantity` es entero como `order_items.quantity`: se despachan unidades de
-- venta, no unidades base. La conversion a unidades base para el inventario ya
-- vive en `order_items.base_quantity` (P03) y no se repite aqui.
-- ---------------------------------------------------------------------------
create table public.fulfillment_items (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  fulfillment_id  uuid        not null,
  order_item_id   uuid        not null,
  quantity        integer     not null,
  created_at      timestamptz not null default now(),
  constraint fulfillment_items_qty check (quantity > 0 and quantity <= 100000),
  constraint fulfillment_items_unique unique (fulfillment_id, order_item_id),
  constraint fulfillment_items_key unique (id, store_id),
  constraint fulfillment_items_fulfillment_fk foreign key (fulfillment_id, store_id)
    references public.fulfillments (id, store_id) on delete cascade,
  constraint fulfillment_items_order_item_fk foreign key (order_item_id, store_id)
    references public.order_items (id, store_id) on delete cascade,
  constraint fulfillment_items_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index fulfillment_items_tenant on public.fulfillment_items (organization_id, company_id);
create index fulfillment_items_fulfillment on public.fulfillment_items (fulfillment_id);
create index fulfillment_items_order_item on public.fulfillment_items (order_item_id);

-- ---------------------------------------------------------------------------
-- 5 · shipments — el bulto que movio un operador.
--
-- Tabla aparte del fulfillment porque un reintento es un SEGUNDO envio y no una
-- correccion del primero: el primero se perdio, tiene su guia, su coste y su
-- historia, y sobrescribirlo borraria la unica prueba de que se pago dos veces
-- por el mismo pedido.
--
-- `provider_code` + `tracking_number` es UNICO en toda la base y ese indice es
-- la ruta caliente del webhook: «¿de quien es esta guia?». Unico porque una
-- guia que apuntara a dos envios haria imposible decidir cual mover, y porque
-- de esa fila —no del aviso— sale el tenant.
-- ---------------------------------------------------------------------------
create table public.shipments (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null,
  company_id         uuid        not null,
  store_id           uuid        not null,
  fulfillment_id     uuid        not null,
  -- Copia del operador del fulfillment en el momento de crear el envio.
  provider_code      text,
  -- Servicio dentro del catalogo del operador ("express", "48h"). Texto porque
  -- es vocabulario del operador y no del producto.
  service_code       text,
  state              public.shipment_state not null default 'draft',
  -- La guia que el comprador copia en la web del operador.
  tracking_number    text,
  tracking_url       text,
  -- REFERENCIA a la etiqueta en Storage o en el operador. Nunca el PDF.
  label_ref          text,
  currency           char(3),
  -- Coste REAL del envio, el que factura el operador. No es
  -- `fulfillments.shipping_cost`, que es lo que se le cobro al comprador: la
  -- diferencia entre los dos es el margen de envio, y con una sola columna no
  -- se puede calcular.
  cost               numeric(14,2),
  weight             numeric(12,3),
  estimated_delivery date,
  shipped_at         timestamptz,
  delivered_at       timestamptz,
  -- Codigo del operador SIN traducir. Se guarda para poder llamar al call
  -- center citandolo; el texto que ve una persona sale de i18n.
  last_error_code    text,
  last_error_detail  text,
  -- La clave con la que se pidio la guia. Repetirla no vuelve a pedirla.
  idempotency_key    text        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint shipments_currency_fmt check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint shipments_cost_non_negative check (cost is null or cost >= 0),
  constraint shipments_weight_non_negative check (weight is null or weight >= 0),
  constraint shipments_tracking_len
    check (tracking_number is null or char_length(btrim(tracking_number)) between 1 and 120),
  constraint shipments_tracking_url_len
    check (tracking_url is null or char_length(tracking_url) <= 2000),
  constraint shipments_label_ref_len
    check (label_ref is null or char_length(label_ref) <= 500),
  constraint shipments_service_len
    check (service_code is null or char_length(btrim(service_code)) between 1 and 60),
  constraint shipments_error_len
    check (last_error_detail is null or char_length(last_error_detail) <= 2000),
  constraint shipments_idem_fmt check (char_length(idempotency_key) between 8 and 200),
  -- Un envio con coste tiene que decir en que moneda: un importe sin moneda no
  -- se puede sumar ni comparar con lo que se cobro.
  constraint shipments_cost_currency check (cost is null or currency is not null),
  -- Una guia no puede parecer un numero de tarjeta (guarda PCI de P09, aqui
  -- porque una referencia externa es exactamente donde se pega lo que no toca).
  constraint shipments_tracking_safe
    check (tracking_number is null or not ebim.looks_like_pan(tracking_number)),
  constraint shipments_idem_unique unique (fulfillment_id, idempotency_key),
  constraint shipments_store_key unique (id, store_id),
  constraint shipments_fulfillment_fk foreign key (fulfillment_id, store_id)
    references public.fulfillments (id, store_id) on delete cascade,
  constraint shipments_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint shipments_provider_fk foreign key (provider_code)
    references public.integration_providers (code) on delete restrict
);

create index shipments_tenant on public.shipments (organization_id, company_id);
create index shipments_fulfillment on public.shipments (fulfillment_id, created_at desc);
create index shipments_store_state on public.shipments (store_id, state, created_at desc);
-- La ruta caliente del webhook. Unica en toda la base a proposito.
create unique index shipments_provider_tracking
  on public.shipments (provider_code, tracking_number)
  where provider_code is not null and tracking_number is not null;

create trigger shipments_set_updated_at before update on public.shipments
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6 · shipment_items — que va dentro del bulto.
--
-- Existe por el mismo motivo que `fulfillment_items` y a otro nivel: un
-- fulfillment de cinco unidades puede salir en dos cajas, y sin esta tabla la
-- segunda no sabria que le toca llevar.
-- ---------------------------------------------------------------------------
create table public.shipment_items (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null,
  company_id          uuid        not null,
  store_id            uuid        not null,
  shipment_id         uuid        not null,
  fulfillment_item_id uuid        not null,
  quantity            integer     not null,
  created_at          timestamptz not null default now(),
  constraint shipment_items_qty check (quantity > 0 and quantity <= 100000),
  constraint shipment_items_unique unique (shipment_id, fulfillment_item_id),
  constraint shipment_items_shipment_fk foreign key (shipment_id, store_id)
    references public.shipments (id, store_id) on delete cascade,
  constraint shipment_items_line_fk foreign key (fulfillment_item_id, store_id)
    references public.fulfillment_items (id, store_id) on delete cascade,
  constraint shipment_items_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index shipment_items_tenant on public.shipment_items (organization_id, company_id);
create index shipment_items_shipment on public.shipment_items (shipment_id);
create index shipment_items_line on public.shipment_items (fulfillment_item_id);

-- ---------------------------------------------------------------------------
-- 7 · tracking_events — lo que paso por el camino.
--
-- Append-only y DEDUPLICADO. Las dos propiedades juntas son la regla 6 del
-- encargo («los webhooks de operador son idempotentes y auditados») convertida
-- en estructura: el mismo aviso reenviado cae sobre la misma fila por el indice
-- unico, y ninguna fila se puede editar despues ni siquiera con `service_role`.
--
-- `external_event_id` es NOT NULL a proposito. Un operador que no manda
-- identificador de evento obliga al adaptador a SINTETIZARLO —de forma
-- determinista, a partir del contenido del aviso— y eso es mejor que dejar la
-- columna vacia: con NULL, la deduplicacion desaparece justo para el operador
-- que peor se porta.
-- ---------------------------------------------------------------------------
create table public.tracking_events (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null,
  company_id         uuid        not null,
  store_id           uuid        not null,
  shipment_id        uuid        not null,
  -- Identificador del evento DEL LADO DEL OPERADOR. Ancla la deduplicacion.
  external_event_id  text        not null,
  provider_code      text,
  -- Estado CANONICO. Es a esto a lo que traduce el adaptador.
  status             public.tracking_status not null,
  -- Estado del operador TAL CUAL, sin traducir ni normalizar. Se guarda para
  -- diagnosticar y para poder citarlo; nada decide con el.
  provider_status    text,
  occurred_at        timestamptz not null,
  description        text,
  location           text,
  source             public.tracking_source not null default 'provider_webhook',
  -- ¿Venia firmado y la firma valido? Un aviso sin firma verificada NO puede
  -- mover un envio (lo impone el comando de la migracion 150300); se registra
  -- igual para que quede constancia del intento.
  signature_verified boolean     not null default false,
  -- El sobre del operador, redactado. El CHECK rechaza credenciales y datos de
  -- tarjeta a cualquier profundidad (guarda de P09, reusada).
  payload            jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  constraint tracking_events_external_len
    check (char_length(btrim(external_event_id)) between 1 and 200),
  constraint tracking_events_provider_status_len
    check (provider_status is null or char_length(provider_status) <= 120),
  constraint tracking_events_description_len
    check (description is null or char_length(description) <= 1000),
  constraint tracking_events_location_len
    check (location is null or char_length(location) <= 200),
  constraint tracking_events_payload_shape check (jsonb_typeof(payload) = 'object'),
  constraint tracking_events_payload_safe check (ebim.jsonb_is_card_safe(payload)),
  -- La deduplicacion, hecha estructura.
  constraint tracking_events_dedupe unique (shipment_id, external_event_id),
  constraint tracking_events_shipment_fk foreign key (shipment_id, store_id)
    references public.shipments (id, store_id) on delete cascade,
  constraint tracking_events_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index tracking_events_tenant on public.tracking_events (organization_id, company_id);
-- `id` desempata: dos avisos del mismo segundo sin desempate se pintarian en
-- orden aleatorio, que es exactamente lo que una linea de tiempo no puede hacer.
create index tracking_events_shipment on public.tracking_events (shipment_id, occurred_at, id);

-- ---------------------------------------------------------------------------
-- 8 · Las maquinas de estado.
--
-- Viven en triggers y no en el comando por la razon de siempre: un UPDATE
-- directo con `service_role` tambien tiene que pasar por ellas. Un comando que
-- comprueba y una tabla que no es una comprobacion opcional.
-- ---------------------------------------------------------------------------
-- Las dos tablas de transiciones viven en una FUNCION y no dentro del trigger
-- porque tienen dos lectores: el trigger, que PROHIBE, y el ingestor de
-- seguimiento (migracion 150300), que necesita PREGUNTAR antes de intentar —un
-- operador puede avisar «entregado» y despues «en transito», y eso no es un
-- error que deba tumbar la ingesta, es un aviso desordenado que se ignora—.
-- Con la tabla escrita dos veces, el dia que una cambie el ingestor empezaria a
-- intentar movimientos que el trigger rechaza.
create or replace function ebim.fulfillment_allowed_next(p_from public.fulfillment_state)
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  -- `picking`, `packed` y `ready` son OPCIONALES en el camino, y eso no es
  -- laxitud: un comercio pequeño no ficha cada paso, y el aviso del operador
  -- —«recogido»— llega igual. Si `allocated` solo pudiera ir a `picking`, ese
  -- aviso legitimo se descartaria y la entrega se quedaria parada mientras el
  -- paquete ya va en camino. Lo que NO se permite es saltar hacia atras ni
  -- salir de un estado terminal, que es lo que la maquina existe para impedir.
  select case p_from
    when 'pending'    then array['allocated','cancelled']
    when 'allocated'  then array['picking','packed','ready','in_transit','cancelled','failed']
    when 'picking'    then array['packed','ready','in_transit','cancelled','failed']
    when 'packed'     then array['ready','in_transit','cancelled','failed']
    -- `ready` -> `delivered` es el recojo: el comprador vino y se lo llevo,
    -- sin transito por medio.
    when 'ready'      then array['in_transit','delivered','cancelled','failed']
    when 'in_transit' then array['delivered','failed','cancelled']
    -- Un intento fallido se reintenta. Cerrarlo aqui obligaria a crear un
    -- segundo fulfillment por cada timbre que nadie contesto.
    when 'failed'     then array['in_transit','ready','delivered','cancelled']
    else array[]::text[]
  end;
$fn$;

create or replace function ebim.shipment_allowed_next(p_from public.shipment_state)
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select case p_from
    when 'draft'            then array['created','cancelled']
    when 'created'          then array['picked_up','in_transit','failed','cancelled']
    when 'picked_up'        then array['in_transit','failed','returned']
    when 'in_transit'       then array['out_for_delivery','delivered','failed','returned']
    when 'out_for_delivery' then array['delivered','failed','in_transit','returned']
    when 'failed'           then array['in_transit','out_for_delivery','returned','cancelled']
    -- Un envio entregado todavia puede volver: es la devolucion, y es el unico
    -- camino que sale de `delivered`.
    when 'delivered'        then array['returned']
    else array[]::text[]
  end;
$fn$;

revoke execute on function
  ebim.fulfillment_allowed_next(public.fulfillment_state),
  ebim.shipment_allowed_next(public.shipment_state)
from public;
grant execute on function
  ebim.fulfillment_allowed_next(public.fulfillment_state),
  ebim.shipment_allowed_next(public.shipment_state)
to anon, authenticated, service_role;

create or replace function ebim.assert_fulfillment_transition()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_allowed text[];
begin
  if new.state is distinct from old.state then
    v_allowed := ebim.fulfillment_allowed_next(old.state);

    if not (new.state::text = any (v_allowed)) then
      raise exception 'ENTREGA_TRANSICION_INVALIDA: % -> %', old.state, new.state
        using errcode = '23514';
    end if;
  end if;

  -- Las marcas de tiempo las pone el trigger y no la aplicacion: una fecha de
  -- entrega escrita a mano es una fecha de entrega que puede mentir.
  if new.state = 'allocated' and new.allocated_at is null then
    new.allocated_at := now();
  end if;
  if new.state = 'in_transit' and new.shipped_at is null then
    new.shipped_at := now();
  end if;
  if new.state = 'delivered' and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  if new.state = 'cancelled' and new.cancelled_at is null then
    new.cancelled_at := now();
  end if;

  -- El importe cobrado por la entrega NO se reescribe: es la parte de
  -- `orders.shipping_total` que corresponde a este fulfillment, y ese total es
  -- inmutable desde P02. Dos cifras que tienen que cuadrar y solo una editable
  -- es la forma segura de que dejen de cuadrar.
  if new.shipping_cost is distinct from old.shipping_cost
     or new.currency is distinct from old.currency then
    raise exception 'ENTREGA_IMPORTE_INMUTABLE: el coste cobrado de una entrega no se cambia'
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

create trigger fulfillments_transition before update on public.fulfillments
  for each row execute function ebim.assert_fulfillment_transition();

create or replace function ebim.assert_shipment_transition()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_allowed text[];
begin
  if new.state is distinct from old.state then
    v_allowed := ebim.shipment_allowed_next(old.state);

    if not (new.state::text = any (v_allowed)) then
      raise exception 'ENVIO_TRANSICION_INVALIDA: % -> %', old.state, new.state
        using errcode = '23514';
    end if;
  end if;

  if new.state in ('picked_up', 'in_transit') and new.shipped_at is null then
    new.shipped_at := now();
  end if;
  if new.state = 'delivered' and new.delivered_at is null then
    new.delivered_at := now();
  end if;

  return new;
end;
$fn$;

create trigger shipments_transition before update on public.shipments
  for each row execute function ebim.assert_shipment_transition();

-- ---------------------------------------------------------------------------
-- 9 · No se despacha mas de lo que se compro.
--
-- El CHECK no puede hacerlo —necesita mirar otras filas— y una comprobacion
-- dentro del comando se salta con un INSERT directo. El trigger es lo unico que
-- alcanza a los tres caminos.
--
-- Los fulfillments CANCELADOS no cuentan: una entrega que se anulo devuelve sus
-- unidades al saldo pendiente, o un pedido que fallo una vez no se podria
-- volver a despachar nunca.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_fulfillment_quantity()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_ordered   integer;
  v_committed integer;
begin
  select oi.quantity into v_ordered
  from public.order_items oi
  where oi.id = new.order_item_id;

  if v_ordered is null then
    raise exception 'LINEA_NO_ENCONTRADA: la linea de pedido no existe'
      using errcode = '22023';
  end if;

  select coalesce(sum(fi.quantity), 0) into v_committed
  from public.fulfillment_items fi
  join public.fulfillments f on f.id = fi.fulfillment_id
  where fi.order_item_id = new.order_item_id
    and f.state <> 'cancelled'
    and fi.id is distinct from new.id;

  if v_committed + new.quantity > v_ordered then
    raise exception
      'ENTREGA_CANTIDAD_EXCEDIDA: se intenta despachar % de una linea de % con % ya comprometidas',
      new.quantity, v_ordered, v_committed
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

create trigger fulfillment_items_quantity
  before insert or update on public.fulfillment_items
  for each row execute function ebim.assert_fulfillment_quantity();

-- La misma regla un nivel mas abajo: un bulto no puede llevar mas unidades de
-- las que la entrega comprometio.
create or replace function ebim.assert_shipment_quantity()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_planned  integer;
  v_shipped  integer;
begin
  select fi.quantity into v_planned
  from public.fulfillment_items fi
  where fi.id = new.fulfillment_item_id;

  if v_planned is null then
    raise exception 'LINEA_NO_ENCONTRADA: la linea de entrega no existe'
      using errcode = '22023';
  end if;

  select coalesce(sum(si.quantity), 0) into v_shipped
  from public.shipment_items si
  join public.shipments s on s.id = si.shipment_id
  where si.fulfillment_item_id = new.fulfillment_item_id
    and s.state <> 'cancelled'
    and si.id is distinct from new.id;

  if v_shipped + new.quantity > v_planned then
    raise exception
      'ENVIO_CANTIDAD_EXCEDIDA: se intentan enviar % de una linea de % con % ya en camino',
      new.quantity, v_planned, v_shipped
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

create trigger shipment_items_quantity
  before insert or update on public.shipment_items
  for each row execute function ebim.assert_shipment_quantity();

-- ---------------------------------------------------------------------------
-- 10 · El seguimiento es append-only, tambien para `service_role`.
--
-- Misma decision que la bitacora de pagos (P09) y el snapshot del pedido (P08):
-- `force row level security` no basta porque `service_role` tiene BYPASSRLS.
-- Un trigger si le alcanza. Un COMENTARIO que dijera «append-only» no impide
-- nada (leccion esupplier-030).
-- ---------------------------------------------------------------------------
create or replace function ebim.reject_tracking_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'BITACORA_INMUTABLE: los hechos de seguimiento no se modifican ni se borran'
    using errcode = '42501';
end;
$fn$;

create trigger tracking_events_append_only
  before update or delete on public.tracking_events
  for each row execute function ebim.reject_tracking_rewrite();

-- ---------------------------------------------------------------------------
-- 11 · RLS. Default deny, `force`, y NADIE con sesion despacha con un UPDATE.
--
-- Las cinco tablas se LEEN desde el backoffice y se mueven por los comandos de
-- la migracion 150300. Es la misma decision que P08 tomo con los ejes del
-- pedido y P09 con el dinero, por la misma razon: autorizacion + maquina de
-- estados + linea de tiempo + hecho de dominio tienen que pasar juntos o no
-- pasar, y un GRANT de UPDATE permite la mitad.
-- ---------------------------------------------------------------------------
alter table public.fulfillments      enable row level security;
alter table public.fulfillments      force  row level security;
alter table public.fulfillment_items enable row level security;
alter table public.fulfillment_items force  row level security;
alter table public.shipments         enable row level security;
alter table public.shipments         force  row level security;
alter table public.shipment_items    enable row level security;
alter table public.shipment_items    force  row level security;
alter table public.tracking_events   enable row level security;
alter table public.tracking_events   force  row level security;

revoke all on public.fulfillments, public.fulfillment_items, public.shipments,
              public.shipment_items, public.tracking_events
  from public, anon, authenticated;

grant all on public.fulfillments, public.fulfillment_items, public.shipments,
             public.shipment_items, public.tracking_events
  to service_role;

grant select on public.fulfillments, public.fulfillment_items, public.shipments,
                public.shipment_items, public.tracking_events
  to authenticated;

create policy fulfillments_select_member on public.fulfillments
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy fulfillment_items_select_member on public.fulfillment_items
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy shipments_select_member on public.shipments
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy shipment_items_select_member on public.shipment_items
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy tracking_events_select_member on public.tracking_events
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- ---------------------------------------------------------------------------
-- 12 · Comentarios.
-- ---------------------------------------------------------------------------
comment on table public.fulfillments is
  'La promesa de entrega de una PARTE del pedido. Un pedido puede tener varias: pedido y fulfillment no son la misma entidad.';
comment on column public.fulfillments.shipping_cost is
  'Lo que se le COBRO al comprador por esta entrega. El coste real del operador vive en shipments.cost; la diferencia es el margen.';
comment on column public.fulfillments.address is
  'Copia congelada al planificar. orders.shipping_address sigue siendo editable; esto no, porque es a donde se entrego.';
comment on table public.fulfillment_items is
  'Que unidades de cada linea entran en la entrega. Esta tabla ES el despacho parcial; un trigger impide comprometer mas de lo comprado.';
comment on table public.shipments is
  'El bulto que movio un operador, con su guia y su coste real. Un reintento es un SEGUNDO envio, no una correccion del primero.';
comment on table public.tracking_events is
  'Hechos de seguimiento normalizados al vocabulario canonico. Append-only incluso para service_role y deduplicados por el id de evento del operador.';
comment on column public.tracking_events.provider_status is
  'El estado del operador TAL CUAL. Se guarda para diagnosticar y citarlo; quien decide es `status`, que es canonico.';
