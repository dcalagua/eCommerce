-- =============================================================================
-- P06-SaaS · Inventario: de una columna entera a un dominio con almacenes
--
-- Hasta aqui "el inventario" de eCommerce eran dos columnas —`products.stock` y
-- `product_variants.stock`— y un `update ... set stock = stock - n` dentro de
-- `create_order`. Eso alcanza para una tienda que despacha desde su trastienda
-- y no alcanza para nada mas: no hay donde decir que hay 10 en Lima y 2 en
-- Arequipa, ni por que hoy hay 8 si ayer habia 12, ni como impedir que dos
-- compradores simultaneos se lleven la misma unidad mientras el carrito de uno
-- todavia esta abierto.
--
-- ## Las tres preguntas que un entero no sabe responder
--
--  1. **¿DONDE hay?** — `inventory_levels`, por almacen y por variante.
--  2. **¿POR QUE cambio?** — `inventory_movements`, un libro mayor con la
--     referencia de negocio que causo el cambio y el saldo resultante.
--  3. **¿Cuanto puedo PROMETER?** — no es lo mismo que cuanto hay. Lo
--     comprometido esta en `inventory_reservations`, y lo prometible (ATP) es
--     una resta: `on_hand - reserved - safety_stock`.
--
-- ## Las decisiones de fondo
--
-- **El almacen es de la SOCIEDAD, no de la tienda.** Igual que las marcas, las
-- unidades de medida, los segmentos y los clientes. Un centro de distribucion
-- sirve a todas las tiendas de la sociedad; darle `store_id` obligaria a
-- duplicar el almacen —y con el sus existencias— cada vez que se abre un canal,
-- y a partir de ahi habria dos verdades sobre las mismas cajas. Que tienda se
-- sirve de que almacen es una RELACION (`store_warehouses`), no una columna.
--
-- **`available_qty` es una columna GENERADA, no un campo que alguien mantiene.**
-- Un disponible calculado por la aplicacion se separa del fisico el primer dia
-- que una excepcion salta entre las dos escrituras. Generada, no puede
-- discrepar nunca.
--
-- **La sobreventa la impide un CHECK, no la disciplina del que escribe.**
-- `reserved_qty <= on_hand_qty` es una restriccion de tabla: aunque un dia
-- alguien escriba el `update` sin guarda, o dos transacciones se solapen de la
-- peor forma imaginable, la transaccion aborta. El algoritmo de reparto
-- (migracion 200100) es la primera linea; esto es la ultima, y es la que
-- convierte "no deberia pasar" en "no puede pasar".
--
-- El backorder es la unica excepcion, y es EXPLICITA: una politica del almacen,
-- denormalizada en el nivel con una FK a la clave de apoyo del padre —la misma
-- tecnica del PIM (`bundle_items.component_kind`)— para que un CHECK pueda
-- mirarla sin triggers y sin poder desincronizarse.
--
-- **NO se crea `warehouse_locations`.** Se escribio y se retiro. Una ubicacion
-- (pasillo, estante, posicion) no cambia ni una respuesta de este dominio: el
-- ATP de un SKU es el mismo lo tenga en A-01 o en B-14, y la reserva se hace
-- sobre el almacen porque es el almacen el que despacha. Lo que si necesita
-- ubicaciones es la ola de picking, que es WMS —una app distinta de esta misma
-- suite— y fulfillment (P12). Una tabla que hoy no lee nadie no es preparacion,
-- es una segunda verdad esperando a que alguien la rellene a medias.
-- **Disparador para crearla:** el dia que P12 tenga que decir de que posicion
-- sale una linea, o que el WMS declare una operacion de ubicacion en
-- `integration_providers`. Antes no.
--
-- **NO se crea `reservation_events`.** El historial de una reserva son cuatro
-- estados y tres marcas de tiempo en la propia fila (`held` -> `committed` |
-- `released` | `expired`), y no hay transicion intermedia que perder porque la
-- reserva es ATOMICA sobre todas sus lineas: o entran todas o no entra ninguna.
-- Lo que si tiene historial es la EXISTENCIA, y ese libro es
-- `inventory_movements`, donde la confirmacion de una reserva deja su asiento.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Vocabulario
-- ---------------------------------------------------------------------------

-- Que ES el almacen. No cambia el calculo, cambia la lectura del operador y la
-- eleccion de centro en P12: no se despacha igual desde un CD que desde la
-- trastienda de una tienda fisica.
create type public.warehouse_kind as enum ('warehouse', 'store', 'virtual');

-- Quien es el SISTEMA DE REGISTRO de ese almacen. `local` = esta base manda;
-- `erp` = esta base es una cache de lo que dice el sistema de gestion del
-- tenant, y por eso puede quedarse vieja.
create type public.inventory_source as enum ('local', 'erp');

-- Que hacer cuando la cache de un almacen `erp` esta vieja. Las dos opciones
-- son legitimas y la eleccion es del tenant, no del producto:
--   · `unknown`           — el almacen deja de aportar cifra y la respuesta pasa
--                           a ser "no se sabe". NO es cero: un ERP caido no
--                           vacio el almacen. El checkout se niega; la vitrina
--                           sigue mostrando el producto.
--   · `trust_last_known`  — se sigue usando la ultima cifra sincronizada. El
--                           riesgo es acotado y el tenant lo asume a cambio de
--                           no parar la venta.
create type public.stock_staleness_policy as enum ('unknown', 'trust_last_known');

-- Por que se movio la existencia. Es el vocabulario del libro mayor.
create type public.movement_kind as enum (
  'receipt',      -- entrada de mercancia
  'issue',        -- salida por venta
  'return',       -- devolucion del comprador
  'adjustment',   -- correccion manual con motivo
  'count',        -- resultado de un inventario fisico
  'transfer_in',
  'transfer_out'
);

create type public.reservation_status as enum ('held', 'committed', 'released', 'expired');

-- ---------------------------------------------------------------------------
-- warehouses — donde estan las cosas.
--
-- `allows_backorder` tiene clave de apoyo propia porque `inventory_levels` la
-- denormaliza: es la unica forma de que un CHECK de tabla pueda depender de una
-- politica que vive en el padre.
-- ---------------------------------------------------------------------------
create table public.warehouses (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null,
  company_id       uuid        not null,
  code             text        not null,
  name             text        not null,
  kind             public.warehouse_kind    not null default 'warehouse',
  source           public.inventory_source  not null default 'local',
  -- Cuanto puede pasar sin sincronizar antes de que la cifra deje de valer.
  -- NULL = nunca caduca, que es lo correcto para un almacen `local`: ahi no hay
  -- nada que sincronizar porque esta base ES el sistema de registro.
  stale_after      interval,
  stale_policy     public.stock_staleness_policy not null default 'unknown',
  -- Politica EXPLICITA de venta bajo cero. Por defecto no.
  allows_backorder boolean     not null default false,
  -- Orden de reparto: menor sirve antes. Es la preferencia por defecto de la
  -- sociedad; `store_warehouses.priority` la afina por tienda.
  priority         integer     not null default 100,
  is_active        boolean     not null default true,
  is_default       boolean     not null default false,
  -- Donde esta, con el minimo util para elegir centro en P12. Sin normalizar en
  -- una tabla de direcciones: un almacen tiene UNA y no cambia de sitio.
  city             text,
  region           text,
  country          char(2),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint warehouses_code_fmt   check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$'),
  constraint warehouses_name_len   check (char_length(btrim(name)) between 1 and 160),
  constraint warehouses_city_len   check (city   is null or char_length(btrim(city))   between 1 and 120),
  constraint warehouses_region_len check (region is null or char_length(btrim(region)) between 1 and 120),
  constraint warehouses_country_fmt check (country is null or country ~ '^[A-Z]{2}$'),
  constraint warehouses_notes_len  check (notes is null or char_length(notes) <= 2000),
  constraint warehouses_priority_range check (priority between 0 and 9999),
  -- Un almacen `local` no puede caducar: esta base es su verdad. Permitirlo
  -- dejaria un almacen propio marcado como "no se sabe" sin que nadie pudiera
  -- refrescarlo, porque no hay nada que lo refresque.
  constraint warehouses_local_never_stale check (source = 'erp' or stale_after is null),
  constraint warehouses_stale_positive    check (stale_after is null or stale_after > interval '0'),
  constraint warehouses_tenant_key    unique (id, organization_id, company_id),
  -- Clave de apoyo para la FK denormalizada de `inventory_levels`.
  constraint warehouses_backorder_key unique (id, allows_backorder)
);

create unique index warehouses_code_key on public.warehouses (organization_id, company_id, lower(code));
-- Un solo almacen por defecto: con dos, "donde entra lo que llega" lo decidiria
-- el orden de fila.
create unique index warehouses_one_default
  on public.warehouses (organization_id, company_id) where is_default;
create index warehouses_tenant_idx on public.warehouses (organization_id, company_id);
create index warehouses_active_idx
  on public.warehouses (organization_id, company_id, priority) where is_active;

create trigger warehouses_set_updated_at before update on public.warehouses
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- store_warehouses — de que almacenes se sirve cada tienda, y en que orden.
--
-- **Sin filas = todos.** Una tienda que no declara nada se sirve de todos los
-- almacenes activos de su sociedad. Es lo que hace que dar de alta el primer
-- almacen no deje la tienda sin vender, y lo que permite el caso de un solo
-- almacen sin obligar a configurar una relacion que solo tiene una respuesta
-- posible. El dia que la tienda declara UNO, deja de servirse de los demas:
-- declarar es restringir, que es la unica lectura segura.
-- ---------------------------------------------------------------------------
create table public.store_warehouses (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  warehouse_id    uuid        not null,
  priority        integer     not null default 100,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint store_warehouses_priority_range check (priority between 0 and 9999),
  constraint store_warehouses_unique unique (store_id, warehouse_id),
  constraint store_warehouses_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint store_warehouses_warehouse_fk foreign key (warehouse_id, organization_id, company_id)
    references public.warehouses (id, organization_id, company_id) on delete cascade
);

create index store_warehouses_tenant_idx on public.store_warehouses (organization_id, company_id);
create index store_warehouses_store_idx
  on public.store_warehouses (store_id, priority) where is_active;
create index store_warehouses_warehouse_idx on public.store_warehouses (warehouse_id);

create trigger store_warehouses_set_updated_at before update on public.store_warehouses
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- Nota sobre la clave `product_variants (id, product_id)`.
--
-- `inventory_levels` necesita que la variante a la que apunta sea DE ESE
-- producto, y no de otra del mismo tenant. Con `(id, store_id)` —la clave de
-- P03— una variante de otro producto de la misma tienda pasaria la FK. La clave
-- que hace falta ya existe: la creo P04 (`product_variants_product_key`,
-- migracion 180000) para lo mismo, que un renglon de precio no pueda apuntar a
-- la variante de otro producto. Se reusa; no se duplica.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- inventory_levels — cuanto hay de QUE, en QUE almacen.
--
-- La unidad es SIEMPRE la unidad base del producto. La presentacion de venta
-- (`product_uoms.factor`) se convierte antes de llegar aqui: guardar cajas en
-- una fila y unidades en otra seria dos verdades sobre el mismo palet.
--
-- `numeric(18,6)` y no `integer`, por la misma razon que `product_uoms.factor`:
-- media caja de tornillos no existe, pero medio kilo de pintura si, y un tipo
-- entero obliga a elegir entre no venderlo o inventarse un redondeo. La regla
-- de `create_order` —una conversion que no da unidades base enteras se
-- rechaza— NO cambia en esta fase: es una garantia existente y relajarla no es
-- trabajo de inventario.
-- ---------------------------------------------------------------------------
create table public.inventory_levels (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  warehouse_id    uuid        not null,
  store_id        uuid        not null,
  product_id      uuid        not null,
  -- NULL = el producto no se vende por variantes. `nulls not distinct` en la
  -- clave unica: sin eso, el mismo producto simple podria tener infinitas filas
  -- en el mismo almacen porque NULL <> NULL.
  variant_id      uuid,
  -- Denormalizado del almacen, con FK a su clave de apoyo y `on update cascade`.
  -- Existe para que el CHECK de abajo pueda mirarlo. Cambiar la politica en el
  -- almacen la propaga sola; escribir aqui un valor que el almacen no tiene es
  -- una violacion de clave foranea.
  allow_backorder boolean     not null default false,
  on_hand_qty     numeric(18,6) not null default 0,
  reserved_qty    numeric(18,6) not null default 0,
  -- ATP fisico. GENERADA: no hay forma de que discrepe de sus dos sumandos.
  -- Lo que se puede PROMETER descuenta ademas `safety_stock`, y eso es politica
  -- comercial —vive en `ebim.atp`— no un hecho del almacen.
  available_qty   numeric(18,6) generated always as (on_hand_qty - reserved_qty) stored,
  -- Colchon que no se vende aunque este fisicamente. Es la respuesta a "el
  -- ultimo siempre se pierde": se aparta contra el mundo, no contra un pedido.
  safety_stock    numeric(18,6) not null default 0,
  -- Umbral de aviso. Solo alimenta alertas: no impide vender.
  reorder_point   numeric(18,6) not null default 0,
  -- Cuando se supo esta cifra. Para un almacen `local` es siempre ahora; para
  -- uno `erp` es lo que decide si la cache vale.
  synced_at       timestamptz not null default now(),
  -- Como se llama esta existencia en el sistema externo. Atributo, nunca clave.
  external_ref    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint inventory_levels_reserved_positive check (reserved_qty >= 0),
  constraint inventory_levels_safety_positive   check (safety_stock >= 0),
  constraint inventory_levels_reorder_positive  check (reorder_point >= 0),
  constraint inventory_levels_external_len
    check (external_ref is null or char_length(btrim(external_ref)) between 1 and 120),
  -- LA restriccion de la fase. Sin backorder explicito no hay existencia
  -- negativa ni comprometida por encima de la fisica. Es la ultima linea contra
  -- la sobreventa: aunque el reparto fallara, la transaccion aborta.
  constraint inventory_levels_no_oversell
    check (allow_backorder or (on_hand_qty >= 0 and reserved_qty <= on_hand_qty)),
  constraint inventory_levels_warehouse_fk foreign key (warehouse_id, organization_id, company_id)
    references public.warehouses (id, organization_id, company_id) on delete cascade,
  constraint inventory_levels_backorder_fk foreign key (warehouse_id, allow_backorder)
    references public.warehouses (id, allows_backorder) on update cascade on delete cascade,
  constraint inventory_levels_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint inventory_levels_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  -- La variante tiene que ser DE ese producto: la clave de apoyo creada arriba.
  constraint inventory_levels_variant_fk foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete cascade,
  constraint inventory_levels_unique unique nulls not distinct (warehouse_id, product_id, variant_id),
  constraint inventory_levels_tenant_key unique (id, organization_id, company_id)
);

create index inventory_levels_tenant_idx on public.inventory_levels (organization_id, company_id);
-- La consulta de disponibilidad: "de este SKU, en la tienda que lo vende".
create index inventory_levels_sku_idx
  on public.inventory_levels (store_id, product_id, variant_id);
-- Solo lo que puede aportar al reparto. El indice parcial deja fuera el catalogo
-- agotado, que en una tienda madura es la mayoria de las filas.
create index inventory_levels_available_idx
  on public.inventory_levels (store_id, product_id, variant_id, warehouse_id)
  where available_qty > 0;
-- Las alertas: lo que esta por debajo del umbral, sin escanear el resto.
create index inventory_levels_reorder_idx
  on public.inventory_levels (organization_id, company_id, warehouse_id)
  where available_qty <= reorder_point;
create index inventory_levels_warehouse_idx on public.inventory_levels (warehouse_id);
create index inventory_levels_external_idx
  on public.inventory_levels (organization_id, company_id, external_ref)
  where external_ref is not null;

create trigger inventory_levels_set_updated_at before update on public.inventory_levels
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- inventory_movements — el libro mayor. Inmutable.
--
-- `quantity` es un DELTA CON SIGNO sobre `on_hand_qty`, no una cantidad
-- absoluta: una entrada de 10 y una salida de 10 se distinguen por el signo y
-- se suman a cero, que es lo que permite reconstruir el saldo sumando la
-- columna. El `kind` explica, no calcula.
--
-- `on_hand_after` guarda el saldo resultante. Es redundante a proposito: se
-- escribe bajo el mismo bloqueo de fila que el cambio, asi que es la unica
-- forma de auditar "en que orden paso esto" sin depender de que nadie haya
-- tocado la fila despues.
--
-- **Idempotencia por referencia externa** (regla 4 de la fase): el indice unico
-- sobre `(organization_id, company_id, warehouse_id, external_ref)` hace que un
-- evento del ERP reintentado —un webhook que se reenvia, una cola que reparte
-- dos veces— no descuente dos veces. La segunda escritura choca con la clave y
-- `ebim.apply_movement` devuelve el asiento que ya existia.
--
-- Sin `updated_at` y sin policies de UPDATE/DELETE: un libro mayor que se puede
-- editar no es un libro mayor. Las correcciones son asientos nuevos.
-- ---------------------------------------------------------------------------
create table public.inventory_movements (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  warehouse_id    uuid        not null,
  store_id        uuid        not null,
  product_id      uuid        not null,
  variant_id      uuid,
  -- Enlace directo al nivel afectado. `set null` al borrarlo: el asiento
  -- sobrevive al producto, igual que `order_items` sobrevive al catalogo.
  level_id        uuid,
  kind            public.movement_kind not null,
  quantity        numeric(18,6) not null,
  on_hand_after   numeric(18,6) not null,
  reason          text,
  -- QUE causo el movimiento. Texto acotado por CHECK y no enum: la lista crece
  -- con cada fase que empiece a mover existencia (devoluciones en P12), y un
  -- enum obligaria a una migracion de tipo para anadir un valor.
  reference_kind  text,
  reference_id    uuid,
  external_ref    text,
  source          public.inventory_source not null default 'local',
  actor_id        uuid,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  constraint inventory_movements_quantity_nonzero check (quantity <> 0),
  constraint inventory_movements_reason_len
    check (reason is null or char_length(reason) <= 500),
  constraint inventory_movements_reference_kind
    check (reference_kind is null or reference_kind in
      ('order', 'reservation', 'manual', 'erp', 'import', 'return', 'transfer')),
  constraint inventory_movements_external_len
    check (external_ref is null or char_length(btrim(external_ref)) between 1 and 120),
  constraint inventory_movements_warehouse_fk foreign key (warehouse_id, organization_id, company_id)
    references public.warehouses (id, organization_id, company_id) on delete cascade,
  constraint inventory_movements_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint inventory_movements_level_fk foreign key (level_id, organization_id, company_id)
    references public.inventory_levels (id, organization_id, company_id) on delete set null (level_id)
);

create index inventory_movements_tenant_idx on public.inventory_movements (organization_id, company_id);
create index inventory_movements_warehouse_idx
  on public.inventory_movements (warehouse_id, occurred_at desc);
create index inventory_movements_sku_idx
  on public.inventory_movements (store_id, product_id, variant_id, occurred_at desc);
create index inventory_movements_reference_idx
  on public.inventory_movements (reference_kind, reference_id) where reference_id is not null;
-- La idempotencia. Parcial: la mayoria de los asientos son manuales y no traen
-- referencia externa, y un NULL no debe competir con otro.
create unique index inventory_movements_external_key
  on public.inventory_movements (organization_id, company_id, warehouse_id, external_ref)
  where external_ref is not null;

-- ---------------------------------------------------------------------------
-- inventory_reservations — lo comprometido y todavia no despachado.
--
-- Cuatro estados y tres marcas de tiempo. `held` es el unico vivo; los otros
-- tres son terminales y cada uno tiene su columna, asi que la fila ES su propio
-- historial (ver la nota de cabecera sobre `reservation_events`).
--
-- **`expires_at` es NOT NULL a proposito.** Una reserva sin caducidad es stock
-- perdido: el carrito que nadie cerro se queda con las unidades para siempre y
-- nadie sabe por que la tienda dice "agotado" con el almacen lleno. Quien
-- reserva elige cuanto dura, pero no elige no elegir.
--
-- **`reference_key` es la idempotencia de negocio** (regla 4): reservar dos
-- veces para el mismo carrito devuelve la MISMA reserva en vez de comprometer
-- el doble. La clave unica es parcial sobre `held` porque una reserva ya
-- cerrada no debe impedir que el mismo carrito vuelva a reservar.
--
-- **`token`**: 256 bits, misma construccion que `order_tokens` (140000). Es lo
-- que permite al checkout decir "esta reserva es mia" sin que el identificador
-- de una reserva ajena —un uuid, enumerable— sirva para llevarse sus unidades.
-- ---------------------------------------------------------------------------
create table public.inventory_reservations (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  status          public.reservation_status not null default 'held',
  reference_kind  text        not null default 'cart',
  reference_key   text        not null,
  token           text        not null default
                    replace(gen_random_uuid()::text, '-', '') ||
                    replace(gen_random_uuid()::text, '-', ''),
  expires_at      timestamptz not null,
  committed_at    timestamptz,
  released_at     timestamptz,
  release_reason  text,
  -- Pedido en el que acabo, cuando acabo en uno. `set null`: el asiento del
  -- libro mayor ya guarda el enlace y sobrevive al borrado del pedido.
  order_id        uuid,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint inventory_reservations_token_len check (char_length(token) = 64),
  constraint inventory_reservations_token_unique unique (token),
  constraint inventory_reservations_reference_kind
    check (reference_kind in ('cart', 'order', 'manual', 'external')),
  constraint inventory_reservations_reference_fmt
    check (reference_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$'),
  constraint inventory_reservations_reason_len
    check (release_reason is null or char_length(release_reason) <= 240),
  -- Estado y marcas de tiempo no pueden contradecirse: una reserva
  -- «confirmada» sin fecha de confirmacion es una fila que nadie sabe leer.
  constraint inventory_reservations_committed_coherent
    check ((status = 'committed') = (committed_at is not null)),
  constraint inventory_reservations_released_coherent
    check ((status in ('released', 'expired')) = (released_at is not null)),
  constraint inventory_reservations_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint inventory_reservations_order_fk foreign key (order_id, organization_id, company_id)
    references public.orders (id, organization_id, company_id) on delete set null (order_id),
  constraint inventory_reservations_tenant_key unique (id, organization_id, company_id)
);

create index inventory_reservations_tenant_idx
  on public.inventory_reservations (organization_id, company_id);
-- La barrida de caducadas: solo mira las vivas.
create index inventory_reservations_expiry_idx
  on public.inventory_reservations (expires_at) where status = 'held';
create index inventory_reservations_store_idx
  on public.inventory_reservations (store_id, created_at desc);
create unique index inventory_reservations_reference_key
  on public.inventory_reservations (store_id, reference_kind, lower(reference_key))
  where status = 'held';

create trigger inventory_reservations_set_updated_at before update on public.inventory_reservations
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- inventory_reservation_items — que unidades, de que almacen.
--
-- El reparto entre almacenes se decide al reservar y se GUARDA: si se
-- recalculara al soltar, la reserva podria devolverse a un almacen distinto del
-- que la comprometio y el saldo de los dos quedaria mal.
-- ---------------------------------------------------------------------------
create table public.inventory_reservation_items (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  reservation_id  uuid        not null,
  level_id        uuid        not null,
  warehouse_id    uuid        not null,
  product_id      uuid        not null,
  variant_id      uuid,
  quantity        numeric(18,6) not null,
  created_at      timestamptz not null default now(),
  constraint inventory_reservation_items_qty_positive check (quantity > 0),
  constraint inventory_reservation_items_reservation_fk
    foreign key (reservation_id, organization_id, company_id)
    references public.inventory_reservations (id, organization_id, company_id) on delete cascade,
  -- `restrict`: no se borra un nivel con unidades comprometidas encima. Dejarlo
  -- caer soltaria una reserva sin devolver nada a ningun sitio.
  constraint inventory_reservation_items_level_fk
    foreign key (level_id, organization_id, company_id)
    references public.inventory_levels (id, organization_id, company_id) on delete restrict
);

create index inventory_reservation_items_tenant_idx
  on public.inventory_reservation_items (organization_id, company_id);
create index inventory_reservation_items_reservation_idx
  on public.inventory_reservation_items (reservation_id);
create index inventory_reservation_items_level_idx
  on public.inventory_reservation_items (level_id);

-- ---------------------------------------------------------------------------
-- RLS · default deny en las seis tablas.
--
-- **Lectura**: cualquier miembro de la sociedad (`can_access`). Saber cuanto
-- hay no es una decision comercial, y esconderlo del rol `viewer` solo
-- obligaria a preguntarlo por chat.
--
-- **Escritura directa: NINGUNA.** Ni `authenticated` ni `anon` tienen un solo
-- GRANT de INSERT/UPDATE/DELETE sobre niveles, movimientos ni reservas. No es
-- prolijidad: un `PATCH /inventory_levels?id=eq.…` desde PostgREST cambiaria la
-- existencia sin dejar asiento en el libro mayor, y a partir de ese momento el
-- saldo y su historia dirian cosas distintas. Toda escritura pasa por las
-- funciones de la migracion 200100, que validan, mueven y anotan en la misma
-- transaccion. Es la regla de bitacora de `CLAUDE.md` aplicada a existencias.
--
-- Lo unico que si se escribe por PostgREST son los MAESTROS —almacenes y su
-- vinculo con la tienda—, porque ahi no hay saldo que descuadrar. Y exigen
-- `owner`/`admin` **y** la capacidad `inventory.multiwarehouse`: llevar
-- existencia por almacen es el modulo vendible. Sin el, el tenant sigue
-- vendiendo contra `products.stock` exactamente como antes de esta fase.
--
-- `anon` no tiene ni un GRANT en ninguna de las seis. El comprador anonimo no
-- lee existencias: lo que ve es el semaforo de la vista publica, y la cifra
-- exacta es informacion competitiva del tenant.
-- ---------------------------------------------------------------------------
alter table public.warehouses                  enable row level security;
alter table public.warehouses                  force  row level security;
alter table public.store_warehouses            enable row level security;
alter table public.store_warehouses            force  row level security;
alter table public.inventory_levels            enable row level security;
alter table public.inventory_levels            force  row level security;
alter table public.inventory_movements         enable row level security;
alter table public.inventory_movements         force  row level security;
alter table public.inventory_reservations      enable row level security;
alter table public.inventory_reservations      force  row level security;
alter table public.inventory_reservation_items enable row level security;
alter table public.inventory_reservation_items force  row level security;

revoke all on public.warehouses                  from public, anon, authenticated;
revoke all on public.store_warehouses            from public, anon, authenticated;
revoke all on public.inventory_levels            from public, anon, authenticated;
revoke all on public.inventory_movements         from public, anon, authenticated;
revoke all on public.inventory_reservations      from public, anon, authenticated;
revoke all on public.inventory_reservation_items from public, anon, authenticated;

grant select, insert, update, delete on public.warehouses       to authenticated;
grant select, insert, update, delete on public.store_warehouses to authenticated;
-- Solo lectura: el resto entra por funcion.
grant select on public.inventory_levels            to authenticated;
grant select on public.inventory_movements         to authenticated;
grant select on public.inventory_reservations      to authenticated;
grant select on public.inventory_reservation_items to authenticated;

grant all on public.warehouses, public.store_warehouses, public.inventory_levels,
             public.inventory_movements, public.inventory_reservations,
             public.inventory_reservation_items
  to service_role;

create policy warehouses_select_member on public.warehouses
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy warehouses_insert_admin on public.warehouses
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'inventory.multiwarehouse')
  );

create policy warehouses_update_admin on public.warehouses
  for update to authenticated
  using  (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'inventory.multiwarehouse')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'inventory.multiwarehouse')
  );

create policy warehouses_delete_admin on public.warehouses
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'inventory.multiwarehouse')
  );

create policy store_warehouses_select_member on public.store_warehouses
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy store_warehouses_insert_admin on public.store_warehouses
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'inventory.multiwarehouse')
  );

create policy store_warehouses_update_admin on public.store_warehouses
  for update to authenticated
  using  (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'inventory.multiwarehouse')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'inventory.multiwarehouse')
  );

create policy store_warehouses_delete_admin on public.store_warehouses
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'inventory.multiwarehouse')
  );

-- Solo SELECT. La ausencia de policies de escritura NO es un olvido: es la
-- regla, y un test de esquema comprueba que sigue sin haberlas.
create policy inventory_levels_select_member on public.inventory_levels
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy inventory_movements_select_member on public.inventory_movements
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy inventory_reservations_select_member on public.inventory_reservations
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy inventory_reservation_items_select_member on public.inventory_reservation_items
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- ---------------------------------------------------------------------------
comment on table public.warehouses is
  'Almacenes de la SOCIEDAD, no de la tienda. Que tienda se sirve de cual es una relacion (store_warehouses).';
comment on column public.warehouses.source is
  'Quien es el sistema de registro: local (manda esta base) o erp (esta base es cache y puede quedarse vieja).';
comment on column public.warehouses.stale_policy is
  'Que hacer con una cache vieja: unknown = deja de aportar cifra y no se promete; trust_last_known = se sigue usando. Nunca se lee como cero.';
comment on column public.warehouses.allows_backorder is
  'Politica EXPLICITA de venta bajo cero. Se denormaliza en inventory_levels para que el CHECK anti-sobreventa pueda mirarla.';
comment on table public.store_warehouses is
  'De que almacenes se sirve una tienda y en que orden. Sin filas = todos los activos de la sociedad: declarar es restringir.';
comment on table public.inventory_levels is
  'Existencia por almacen y variante, en unidades BASE. available_qty es generada; el CHECK anti-sobreventa es la ultima linea.';
comment on column public.inventory_levels.available_qty is
  'on_hand - reserved, columna GENERADA. Lo prometible descuenta ademas safety_stock y lo calcula ebim.atp.';
comment on column public.inventory_levels.safety_stock is
  'Colchon que no se vende aunque este fisicamente. Politica comercial, no un hecho del almacen.';
comment on table public.inventory_movements is
  'Libro mayor inmutable: delta con signo, saldo resultante y la referencia de negocio que lo causo. Idempotente por external_ref.';
comment on table public.inventory_reservations is
  'Lo comprometido y no despachado. expires_at es NOT NULL: una reserva sin caducidad es stock perdido.';
comment on column public.inventory_reservations.token is
  'Secreto de portador de 256 bits. Permite al checkout reclamar SU reserva sin que un uuid ajeno sirva para llevarse unidades.';
comment on column public.inventory_reservations.reference_key is
  'Idempotencia de negocio: reservar dos veces para el mismo carrito devuelve la misma reserva, no el doble de unidades.';
comment on table public.inventory_reservation_items is
  'El reparto entre almacenes decidido al reservar. Se guarda para que lo soltado vuelva al mismo sitio del que salio.';
