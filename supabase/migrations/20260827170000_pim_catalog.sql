-- =============================================================================
-- P03-SaaS · PIM: marcas, familias, atributos, variantes, unidades y kits
--
-- El catalogo de P02 resuelve bien el producto SIMPLE: un SKU, un precio, una
-- cantidad. Lo que no sabe expresar es que "Camiseta" se vende en cuatro tallas
-- y tres colores, que el mismo jabon se despacha por unidad y por caja de 12, o
-- que un "pack de bienvenida" son tres productos que se descuentan por separado.
--
-- Cuatro decisiones de modelado gobiernan todo el archivo. Cada una descarta
-- una alternativa que habria salido mas barata hoy:
--
--  1. **El producto sigue siendo el maestro unico.** `products.kind` dice si es
--     simple, si tiene variantes o si es un kit. NO hay tabla `bundles`: un kit
--     es un producto vendible con su SKU, su precio, sus imagenes y su
--     publicacion, y darle tabla propia habria duplicado la identidad del
--     producto — exactamente lo que prohibe "producto maestro unico".
--
--  2. **Los atributos son relacionales, no JSONB.** `custom_fields` sigue
--     existiendo para extensiones no criticas del tenant, pero un atributo que
--     tiene que filtrar, agrupar y definir variantes necesita indice, integridad
--     referencial y una lista de valores admitidos. Un `jsonb` con "color":
--     "rojo" en un sitio y "Rojo" en otro no filtra: agrupa mal y nadie se
--     entera hasta que el catalogo tiene tres mil SKUs.
--
--  3. **Lo que es del CATALOGO va a nivel de sociedad; lo que es del PRODUCTO,
--     a nivel de tienda.** Marcas, familias, atributos y unidades son
--     vocabulario de la sociedad y se reusan en todas sus tiendas: duplicarlos
--     por tienda obligaria a mantener "Talla M" en N sitios. Variantes, UoM de
--     producto, componentes de kit y relaciones cuelgan del producto, que es de
--     una tienda, y por eso llevan `store_id` (regla 8 de la fase).
--
--  4. **Las reglas del modelo se impiden en la base, no en la pantalla.** Un
--     eje de variante que no es una lista de opciones, un valor que no pertenece
--     a su atributo, un kit dentro de otro kit o un SKU repetido entre producto
--     y variante son errores que aqui no llegan a insertarse.
--
-- Compatibilidad: NO se toca `products.price` ni `products.stock`. Un producto
-- existente nace `kind = 'simple'` y se comporta exactamente igual que ayer.
-- La migracion de esos dos campos esta documentada en el ADR 003 y en
-- `docs/STATE.md`; no se retiran porque `create_order`, el storefront, los KPI
-- del panel y la vista publica dependen de ellos.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Que ES un producto, desde el punto de vista de la venta:
--   simple  — un SKU, un precio, una existencia. Lo de siempre.
--   variant — maestro de variantes: NO se vende el; se vende una de sus filas
--             de `product_variants`, que es la que tiene SKU y existencia.
--   bundle  — kit: se vende el, pero descuenta las existencias de sus
--             componentes.
create type public.product_kind as enum ('simple', 'variant', 'bundle');

-- Tipo de dato de un atributo. `option` es el unico que tiene lista de valores
-- admitidos, y por eso el unico que puede definir variantes: un eje con dominio
-- abierto no produce un numero finito de combinaciones.
create type public.attribute_data_type as enum ('text', 'number', 'boolean', 'date', 'option');

-- Por que dos productos estan relacionados. El sentido lo da el tipo.
create type public.product_relation_kind as enum (
  'related', 'cross_sell', 'up_sell', 'accessory', 'substitute', 'spare_part'
);

-- ===========================================================================
-- VOCABULARIO DE LA SOCIEDAD — se reusa en todas sus tiendas
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- brands — la marca del producto.
--
-- Sin `store_id` a proposito: la misma marca se vende en la tienda mayorista y
-- en la minorista de la misma sociedad, y tenerla dos veces significa que un
-- dia el logo se cambia en una y no en la otra.
-- ---------------------------------------------------------------------------
create table public.brands (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  code            text        not null,
  name            text        not null,
  description     text,
  logo_url        text,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint brands_code_fmt  check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint brands_name_len  check (char_length(btrim(name)) between 1 and 160),
  constraint brands_desc_len  check (description is null or char_length(description) <= 2000),
  constraint brands_logo_len  check (logo_url is null or char_length(logo_url) between 4 and 1024),
  -- Clave compuesta: deja que `products` amarre su marca al MISMO tenant por FK
  -- en vez de confiar en que alguien copie bien el uuid.
  constraint brands_tenant_key unique (id, organization_id, company_id)
);
create unique index brands_code_key on public.brands (organization_id, company_id, lower(code));
create index brands_name_idx on public.brands (organization_id, company_id, lower(name));

create trigger brands_set_updated_at
  before update on public.brands
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- product_families — el TIPO de producto dentro del catalogo.
--
-- Agrupa productos que comparten ficha tecnica ("Calzado", "Bebidas"). No es la
-- categoria: la categoria es navegacion del comprador y cuelga de una tienda;
-- la familia es clasificacion interna del catalogo y es de la sociedad. Tener
-- las dos separadas es lo que permite reorganizar el menu de la vitrina sin
-- tocar la ficha tecnica de tres mil productos.
-- ---------------------------------------------------------------------------
create table public.product_families (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  code            text        not null,
  name            text        not null,
  description     text,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint product_families_code_fmt check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint product_families_name_len check (char_length(btrim(name)) between 1 and 160),
  constraint product_families_desc_len check (description is null or char_length(description) <= 2000),
  constraint product_families_tenant_key unique (id, organization_id, company_id)
);
create unique index product_families_code_key
  on public.product_families (organization_id, company_id, lower(code));

create trigger product_families_set_updated_at
  before update on public.product_families
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- attributes — que se puede decir de un producto.
--
-- `is_variant_axis` marca los que generan variantes (Color, Talla). El CHECK
-- obliga a que sean `option`: un eje de texto libre no tiene combinaciones
-- finitas y produciria una variante por cada forma de escribir "rojo".
--
-- `attributes_type_key` y `attributes_axis_key` no son claves de negocio: son
-- las claves de apoyo que hacen posibles las FK denormalizadas de
-- `attribute_values` y `variant_attribute_values`. Se explican alli.
-- ---------------------------------------------------------------------------
create table public.attributes (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  code            text        not null,
  name            text        not null,
  data_type       public.attribute_data_type not null default 'option',
  -- Unidad del VALOR, informativa ("g", "cm"). No es unidad de venta: eso es
  -- `units_of_measure`. Mezclarlas es como se acaba vendiendo por centimetros.
  unit            text,
  is_variant_axis boolean     not null default false,
  is_filterable   boolean     not null default true,
  position        integer     not null default 0,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint attributes_code_fmt check (code ~ '^[a-z][a-z0-9_]{0,40}$'),
  constraint attributes_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint attributes_unit_len check (unit is null or char_length(btrim(unit)) between 1 and 16),
  constraint attributes_axis_is_option check (not is_variant_axis or data_type = 'option'),
  constraint attributes_tenant_key unique (id, organization_id, company_id),
  constraint attributes_type_key   unique (id, data_type),
  constraint attributes_axis_key   unique (id, is_variant_axis)
);
create unique index attributes_code_key
  on public.attributes (organization_id, company_id, lower(code));
create index attributes_axis_idx
  on public.attributes (organization_id, company_id) where is_variant_axis;

create trigger attributes_set_updated_at
  before update on public.attributes
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- attribute_values — los valores admitidos de un atributo de lista.
--
-- `attribute_data_type` es una COPIA del tipo del atributo, fijada a `option`
-- por CHECK y amarrada por FK a `attributes (id, data_type)`. Parece redundante
-- y no lo es: es lo que hace imposible, sin un solo trigger, colgar valores de
-- un atributo de texto libre. Y como la FK va `on update cascade`, cambiar el
-- tipo de un atributo que ya tiene valores intenta propagar el nuevo tipo aqui
-- y choca contra el CHECK — es decir, no se puede convertir en texto un
-- atributo cuyo dominio ya esta en uso. Esa es exactamente la regla correcta.
-- ---------------------------------------------------------------------------
create table public.attribute_values (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null,
  company_id          uuid        not null,
  attribute_id        uuid        not null,
  attribute_data_type public.attribute_data_type not null default 'option',
  code                text        not null,
  label               text        not null,
  position            integer     not null default 0,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint attribute_values_code_fmt    check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint attribute_values_label_len   check (char_length(btrim(label)) between 1 and 120),
  constraint attribute_values_only_option check (attribute_data_type = 'option'),
  constraint attribute_values_attribute_fk foreign key (attribute_id, organization_id, company_id)
    references public.attributes (id, organization_id, company_id) on delete cascade,
  constraint attribute_values_type_fk foreign key (attribute_id, attribute_data_type)
    references public.attributes (id, data_type) on update cascade on delete cascade,
  -- Clave de apoyo: una asignacion solo puede apuntar a un valor DE ese
  -- atributo. Sin esto, "Talla M" podria acabar asignada al atributo "Color".
  constraint attribute_values_attribute_key unique (id, attribute_id),
  constraint attribute_values_tenant_key    unique (id, organization_id, company_id)
);
create unique index attribute_values_code_key
  on public.attribute_values (attribute_id, lower(code));
create index attribute_values_tenant_idx
  on public.attribute_values (organization_id, company_id, attribute_id, position);

create trigger attribute_values_set_updated_at
  before update on public.attribute_values
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- units_of_measure — como se despacha lo que se vende.
--
-- Catalogo de la SOCIEDAD y no global del producto (a diferencia de
-- `currencies`, que es ISO 4217 y es un hecho del mundo): "Caja x 12" o "Saco"
-- son convenciones del negocio de cada cliente, no de una norma. Por eso lleva
-- tenant y por eso el tenant las da de alta desde el backoffice.
-- ---------------------------------------------------------------------------
create table public.units_of_measure (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  code            text        not null,
  name            text        not null,
  symbol          text,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint units_of_measure_code_fmt   check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$'),
  constraint units_of_measure_name_len   check (char_length(btrim(name)) between 1 and 80),
  constraint units_of_measure_symbol_len check (symbol is null or char_length(btrim(symbol)) between 1 and 12),
  constraint units_of_measure_tenant_key unique (id, organization_id, company_id)
);
-- `upper(code)`: "und" y "UND" son la misma unidad, y dos filas serian dos
-- factores de conversion distintos para lo mismo.
create unique index units_of_measure_code_key
  on public.units_of_measure (organization_id, company_id, upper(code));

create trigger units_of_measure_set_updated_at
  before update on public.units_of_measure
  for each row execute function ebim.set_updated_at();

-- ===========================================================================
-- EL PRODUCTO CRECE — columnas nuevas, ninguna obligatoria
-- ===========================================================================

alter table public.products
  add column kind      public.product_kind not null default 'simple',
  add column brand_id  uuid,
  add column family_id uuid;

alter table public.products
  -- Clave de apoyo para las FK denormalizadas de `product_variants` y
  -- `bundle_items`: son las que impiden variantes colgando de un producto
  -- simple y kits dentro de kits.
  add constraint products_kind_key unique (id, kind),
  add constraint products_brand_fk foreign key (brand_id, organization_id, company_id)
    references public.brands (id, organization_id, company_id) on delete set null (brand_id),
  add constraint products_family_fk foreign key (family_id, organization_id, company_id)
    references public.product_families (id, organization_id, company_id) on delete set null (family_id);

create index products_brand_idx  on public.products (brand_id)  where brand_id is not null;
create index products_family_idx on public.products (family_id) where family_id is not null;
create index products_kind_idx   on public.products (store_id, kind);

comment on column public.products.kind is
  'simple | variant | bundle. Un `variant` NO se vende: se vende una de sus filas de product_variants.';
comment on column public.products.price is
  'numeric(14,2). En `variant` es el precio base que heredan las variantes sin precio propio; en `bundle` es el precio del kit.';
comment on column public.products.stock is
  'Existencia del producto SIMPLE. En `variant` manda product_variants.stock; en `bundle` se calcula por componentes.';

-- ===========================================================================
-- LO QUE CUELGA DEL PRODUCTO — lleva store_id porque el producto es de una tienda
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- product_variants — la unidad que de verdad se vende cuando hay ejes.
--
-- `product_kind` fijada a 'variant' + FK a `products (id, kind)`: una variante
-- no puede colgar de un producto simple, y bajar a simple un producto que ya
-- tiene variantes falla (la cascada de `on update` intenta escribir 'simple'
-- aqui y choca con el CHECK). Sin eso existiria el estado "el producto dice que
-- es simple y tiene cuatro variantes", en el que `create_order` venderia el
-- maestro y descontaria una existencia que nadie lleva.
--
-- `price` nullable = HEREDA del maestro. Copiarlo al crear la variante habria
-- sido mas simple de leer y convierte cualquier cambio de precio del maestro en
-- N filas desincronizadas.
-- ---------------------------------------------------------------------------
create table public.product_variants (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null,
  company_id       uuid        not null,
  store_id         uuid        not null,
  product_id       uuid        not null,
  product_kind     public.product_kind not null default 'variant',
  sku              text        not null,
  name             text        not null,
  price            numeric(14,2),
  compare_at_price numeric(14,2),
  stock            integer     not null default 0,
  in_stock         boolean     generated always as (stock > 0) stored,
  barcode          text,
  position         integer     not null default 0,
  is_active        boolean     not null default true,
  is_default       boolean     not null default false,
  custom_fields    jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint product_variants_kind         check (product_kind = 'variant'),
  constraint product_variants_sku_len      check (char_length(btrim(sku)) between 1 and 64),
  constraint product_variants_name_len     check (char_length(btrim(name)) between 1 and 240),
  constraint product_variants_price_positive   check (price is null or price >= 0),
  constraint product_variants_compare_positive check (compare_at_price is null or compare_at_price >= 0),
  constraint product_variants_stock_positive   check (stock >= 0),
  constraint product_variants_barcode_len check (barcode is null or char_length(btrim(barcode)) between 4 and 64),
  constraint product_variants_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint product_variants_kind_fk foreign key (product_id, product_kind)
    references public.products (id, kind) on update cascade on delete cascade,
  constraint product_variants_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint product_variants_store_key  unique (id, store_id),
  constraint product_variants_tenant_key unique (id, organization_id, company_id)
);
-- El SKU de variante vive en el MISMO espacio de nombres que el del producto:
-- ver `ebim.assert_sku_unique_in_store` mas abajo.
create unique index product_variants_sku_key on public.product_variants (store_id, lower(sku));
create unique index product_variants_barcode_key
  on public.product_variants (store_id, barcode) where barcode is not null;
-- Una sola variante por defecto: con dos, la ficha elegiria por orden de fila.
create unique index product_variants_one_default on public.product_variants (product_id) where is_default;
create index product_variants_product_idx on public.product_variants (product_id, position);
create index product_variants_tenant_idx  on public.product_variants (organization_id, company_id);
create index product_variants_available_idx
  on public.product_variants (product_id) where is_active and in_stock;

create trigger product_variants_set_updated_at
  before update on public.product_variants
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- variant_attribute_values — que combinacion ES cada variante.
--
-- `is_axis` fijada a `true` + FK a `attributes (id, is_variant_axis)`: solo un
-- atributo DECLARADO como eje define variantes. "Material" es descriptivo y no
-- deberia partir el catalogo en filas; con esto no puede.
-- ---------------------------------------------------------------------------
create table public.variant_attribute_values (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  variant_id      uuid        not null,
  attribute_id    uuid        not null,
  is_axis         boolean     not null default true,
  value_id        uuid        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint variant_attribute_values_axis check (is_axis),
  constraint variant_attribute_values_variant_fk foreign key (variant_id, store_id)
    references public.product_variants (id, store_id) on delete cascade,
  constraint variant_attribute_values_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint variant_attribute_values_attribute_fk foreign key (attribute_id, organization_id, company_id)
    references public.attributes (id, organization_id, company_id) on delete cascade,
  constraint variant_attribute_values_axis_fk foreign key (attribute_id, is_axis)
    references public.attributes (id, is_variant_axis) on update cascade on delete cascade,
  -- El valor tiene que ser de ESE atributo, no de cualquiera.
  constraint variant_attribute_values_value_fk foreign key (value_id, attribute_id)
    references public.attribute_values (id, attribute_id) on delete cascade,
  -- Un eje toma UN valor por variante: "Talla M y L a la vez" no es una variante.
  constraint variant_attribute_values_unique unique (variant_id, attribute_id)
);
create index variant_attribute_values_lookup
  on public.variant_attribute_values (attribute_id, value_id);
create index variant_attribute_values_tenant_idx
  on public.variant_attribute_values (organization_id, company_id);

create trigger variant_attribute_values_set_updated_at
  before update on public.variant_attribute_values
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- product_attribute_values — la ficha tecnica del producto.
--
-- Una columna por tipo y un CHECK que exige exactamente UNA rellena. La
-- alternativa —guardar todo como texto— es la que hace que "500" y "500.0" no
-- se filtren igual y que un rango numerico ordene alfabeticamente.
-- ---------------------------------------------------------------------------
create table public.product_attribute_values (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  product_id      uuid        not null,
  attribute_id    uuid        not null,
  value_id        uuid,
  value_text      text,
  value_number    numeric(18,6),
  value_boolean   boolean,
  value_date      date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint product_attribute_values_one_value check (
    (value_id is not null)::int + (value_text is not null)::int
    + (value_number is not null)::int + (value_boolean is not null)::int
    + (value_date is not null)::int = 1
  ),
  constraint product_attribute_values_text_len
    check (value_text is null or char_length(btrim(value_text)) between 1 and 500),
  constraint product_attribute_values_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint product_attribute_values_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint product_attribute_values_attribute_fk foreign key (attribute_id, organization_id, company_id)
    references public.attributes (id, organization_id, company_id) on delete cascade,
  constraint product_attribute_values_value_fk foreign key (value_id, attribute_id)
    references public.attribute_values (id, attribute_id) on delete cascade,
  constraint product_attribute_values_unique unique (product_id, attribute_id)
);
-- Indice de FILTRO: "dame los productos con Color = Rojo" no puede recorrer la
-- tabla entera. Es la razon por la que estos valores no viven en `custom_fields`.
create index product_attribute_values_filter
  on public.product_attribute_values (attribute_id, value_id) where value_id is not null;
create index product_attribute_values_number
  on public.product_attribute_values (attribute_id, value_number) where value_number is not null;
create index product_attribute_values_store_idx
  on public.product_attribute_values (store_id, attribute_id);
create index product_attribute_values_tenant_idx
  on public.product_attribute_values (organization_id, company_id);

create trigger product_attribute_values_set_updated_at
  before update on public.product_attribute_values
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- product_uoms — las unidades en las que se puede vender un producto.
--
-- `factor` = cuantas unidades BASE entrega una unidad de esta. Caja x 12 -> 12.
-- `numeric(18,6)` y nunca float: un factor de 0,333 multiplicado por miles de
-- lineas es exactamente donde el redondeo binario se convierte en descuadre de
-- inventario. La unidad base es la fila con `is_base` y factor obligado a 1; un
-- producto sin filas aqui se vende en su unidad implicita, que es lo que hacen
-- hoy todos los productos existentes.
--
-- Cuelga del PRODUCTO y no de la variante: las tallas de una camiseta se
-- despachan en la misma caja. Si algun dia una variante necesita su propia
-- conversion, es una columna `variant_id` nullable aqui, no otra tabla.
-- ---------------------------------------------------------------------------
create table public.product_uoms (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  product_id      uuid        not null,
  uom_id          uuid        not null,
  factor          numeric(18,6) not null,
  is_base         boolean     not null default false,
  is_sellable     boolean     not null default true,
  -- Precio propio de la unidad. NULL = precio base x factor, que es lo
  -- esperable; un valor aqui es el descuento por caja, que no es proporcional.
  price           numeric(14,2),
  barcode         text,
  position        integer     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint product_uoms_factor_positive check (factor > 0),
  constraint product_uoms_base_factor     check (not is_base or factor = 1),
  constraint product_uoms_price_positive  check (price is null or price >= 0),
  constraint product_uoms_barcode_len
    check (barcode is null or char_length(btrim(barcode)) between 4 and 64),
  constraint product_uoms_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint product_uoms_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint product_uoms_uom_fk foreign key (uom_id, organization_id, company_id)
    references public.units_of_measure (id, organization_id, company_id) on delete restrict,
  constraint product_uoms_unique unique (product_id, uom_id)
);
-- Una sola unidad base por producto: con dos, "cuantas unidades base son tres
-- cajas" tendria dos respuestas.
create unique index product_uoms_one_base on public.product_uoms (product_id) where is_base;
create index product_uoms_product_idx on public.product_uoms (product_id, position);
create index product_uoms_tenant_idx  on public.product_uoms (organization_id, company_id);

create trigger product_uoms_set_updated_at
  before update on public.product_uoms
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- bundle_items — de que esta hecho un kit.
--
-- No hay tabla `bundles`: el kit ES el producto (`products.kind = 'bundle'`).
-- Las dos columnas de tipo denormalizadas hacen dos cosas que ningun CHECK
-- normal puede:
--   · `bundle_kind = 'bundle'`      — solo un kit tiene componentes;
--   · `component_kind <> 'bundle'`  — no hay kits dentro de kits, asi que el
--     calculo de existencia por componentes termina en un solo nivel y no
--     puede entrar en un ciclo.
-- Las dos van `on update cascade`, asi que tampoco se puede convertir en kit un
-- producto que ya es componente de otro.
-- ---------------------------------------------------------------------------
create table public.bundle_items (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      uuid        not null,
  company_id           uuid        not null,
  store_id             uuid        not null,
  bundle_product_id    uuid        not null,
  bundle_kind          public.product_kind not null default 'bundle',
  component_product_id uuid        not null,
  component_kind       public.product_kind not null default 'simple',
  component_variant_id uuid,
  quantity             numeric(18,6) not null,
  -- Unidad en la que se expresa `quantity`. NULL = unidades base.
  uom_id               uuid,
  position             integer     not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint bundle_items_quantity_positive check (quantity > 0),
  constraint bundle_items_is_bundle         check (bundle_kind = 'bundle'),
  constraint bundle_items_no_nesting        check (component_kind <> 'bundle'),
  constraint bundle_items_not_self          check (bundle_product_id <> component_product_id),
  -- Si el componente se vende por variantes, hay que decir CUAL: sin esto, un
  -- kit podria apuntar al maestro y el pedido descontaria una existencia que
  -- ese maestro no lleva. Y al reves: una variante para un componente simple es
  -- una referencia a otra cosa.
  constraint bundle_items_variant_matches_kind check (
    (component_kind = 'variant') = (component_variant_id is not null)
  ),
  constraint bundle_items_bundle_fk foreign key (bundle_product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint bundle_items_bundle_kind_fk foreign key (bundle_product_id, bundle_kind)
    references public.products (id, kind) on update cascade on delete cascade,
  -- `restrict` en el componente: borrar un producto que forma parte de un kit
  -- dejaria el kit vendiendose incompleto y sin que nadie lo note.
  constraint bundle_items_component_fk foreign key (component_product_id, store_id)
    references public.products (id, store_id) on delete restrict,
  constraint bundle_items_component_kind_fk foreign key (component_product_id, component_kind)
    references public.products (id, kind) on update cascade on delete restrict,
  constraint bundle_items_variant_fk foreign key (component_variant_id, store_id)
    references public.product_variants (id, store_id) on delete restrict,
  constraint bundle_items_uom_fk foreign key (uom_id, organization_id, company_id)
    references public.units_of_measure (id, organization_id, company_id) on delete restrict,
  constraint bundle_items_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  -- `nulls not distinct`: sin esto, el mismo componente sin variante se podria
  -- repetir infinitas veces en el mismo kit, porque NULL <> NULL.
  constraint bundle_items_unique unique nulls not distinct
    (bundle_product_id, component_product_id, component_variant_id)
);
create index bundle_items_bundle_idx    on public.bundle_items (bundle_product_id, position);
create index bundle_items_component_idx on public.bundle_items (component_product_id);
create index bundle_items_tenant_idx    on public.bundle_items (organization_id, company_id);

create trigger bundle_items_set_updated_at
  before update on public.bundle_items
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- product_relations — accesorios, sustitutos, venta cruzada.
--
-- Dirigida a proposito: "A sugiere B" no implica "B sugiere A". El sustituto de
-- un producto descatalogado es su reemplazo, y al reves no tiene sentido.
-- ---------------------------------------------------------------------------
create table public.product_relations (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null,
  company_id         uuid        not null,
  store_id           uuid        not null,
  product_id         uuid        not null,
  related_product_id uuid        not null,
  relation_kind      public.product_relation_kind not null default 'related',
  position           integer     not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint product_relations_not_self check (product_id <> related_product_id),
  constraint product_relations_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint product_relations_related_fk foreign key (related_product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint product_relations_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint product_relations_unique unique (product_id, related_product_id, relation_kind)
);
create index product_relations_product_idx on public.product_relations (product_id, relation_kind, position);
create index product_relations_related_idx on public.product_relations (related_product_id);
create index product_relations_tenant_idx  on public.product_relations (organization_id, company_id);

create trigger product_relations_set_updated_at
  before update on public.product_relations
  for each row execute function ebim.set_updated_at();

-- ===========================================================================
-- UN SOLO ESPACIO DE NOMBRES DE SKU POR TIENDA
-- ===========================================================================

-- El SKU identifica lo que se despacha. Un producto simple y una variante de
-- otro producto con el mismo SKU en la misma tienda es una ambiguedad que
-- termina en el almacen, no en la pantalla: el picking no sabe cual coger.
--
-- Los indices unicos por tabla cubren cada lado; este trigger cubre el cruce,
-- que ningun indice puede expresar. Corre bajo la RLS del llamante y no es
-- SECURITY DEFINER a proposito: el alcance es la tienda, la tienda es de un
-- tenant, y quien no ve las filas del tenant tampoco puede insertar en el.
create or replace function ebim.assert_sku_unique_in_store()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_conflict boolean;
begin
  if tg_table_name = 'products' then
    select exists (
      select 1 from public.product_variants v
       where v.store_id = new.store_id and lower(v.sku) = lower(new.sku)
    ) into v_conflict;
  else
    select exists (
      select 1 from public.products p
       where p.store_id = new.store_id and lower(p.sku) = lower(new.sku)
    ) into v_conflict;
  end if;

  if v_conflict then
    raise exception 'SKU_DUPLICADO: el SKU % ya existe en esta tienda', new.sku
      using errcode = '23505';
  end if;

  return new;
end;
$fn$;

create trigger products_sku_unique_across_variants
  before insert or update of sku, store_id on public.products
  for each row execute function ebim.assert_sku_unique_in_store();

create trigger product_variants_sku_unique_across_products
  before insert or update of sku, store_id on public.product_variants
  for each row execute function ebim.assert_sku_unique_in_store();

-- ===========================================================================
-- RLS — default deny en las once tablas nuevas
--
-- Escritura: owner/admin/catalog, igual que el resto del catalogo.
-- `orders`/`viewer` leen, porque un pedido con variantes hay que poder mirarlo.
-- Lectura anonima: solo variantes y componentes de kit, y solo de producto
-- publicado en tienda activa. La ficha tecnica y el vocabulario del catalogo
-- NO salen a la vitrina en esta fase (ver ADR 003).
-- ===========================================================================

alter table public.brands                   enable row level security;
alter table public.brands                   force  row level security;
alter table public.product_families         enable row level security;
alter table public.product_families         force  row level security;
alter table public.attributes               enable row level security;
alter table public.attributes               force  row level security;
alter table public.attribute_values         enable row level security;
alter table public.attribute_values         force  row level security;
alter table public.units_of_measure         enable row level security;
alter table public.units_of_measure         force  row level security;
alter table public.product_variants         enable row level security;
alter table public.product_variants         force  row level security;
alter table public.variant_attribute_values enable row level security;
alter table public.variant_attribute_values force  row level security;
alter table public.product_attribute_values enable row level security;
alter table public.product_attribute_values force  row level security;
alter table public.product_uoms             enable row level security;
alter table public.product_uoms             force  row level security;
alter table public.bundle_items             enable row level security;
alter table public.bundle_items             force  row level security;
alter table public.product_relations        enable row level security;
alter table public.product_relations        force  row level security;

revoke all on public.brands                   from public, anon, authenticated;
revoke all on public.product_families         from public, anon, authenticated;
revoke all on public.attributes               from public, anon, authenticated;
revoke all on public.attribute_values         from public, anon, authenticated;
revoke all on public.units_of_measure         from public, anon, authenticated;
revoke all on public.product_variants         from public, anon, authenticated;
revoke all on public.variant_attribute_values from public, anon, authenticated;
revoke all on public.product_attribute_values from public, anon, authenticated;
revoke all on public.product_uoms             from public, anon, authenticated;
revoke all on public.bundle_items             from public, anon, authenticated;
revoke all on public.product_relations        from public, anon, authenticated;

grant select, insert, update, delete on
  public.brands, public.product_families, public.attributes, public.attribute_values,
  public.units_of_measure, public.product_variants, public.variant_attribute_values,
  public.product_attribute_values, public.product_uoms, public.bundle_items,
  public.product_relations
to authenticated;

grant all on
  public.brands, public.product_families, public.attributes, public.attribute_values,
  public.units_of_measure, public.product_variants, public.variant_attribute_values,
  public.product_attribute_values, public.product_uoms, public.bundle_items,
  public.product_relations
to service_role;

-- El comprador anonimo no ve tenant, ni SKU, ni existencia exacta. Ve que
-- variantes hay, cuanto valen y si estan disponibles.
grant select (id, product_id, store_id, name, price, compare_at_price,
              in_stock, position, is_active, is_default)
  on public.product_variants to anon;
-- La marca se anuncia en la ficha; `is_active` entra porque la policy la usa.
grant select (id, code, name, logo_url, is_active) on public.brands to anon;
-- Columnas nuevas de `products` que la vista publica necesita leer. Una vista
-- `security_invoker` comprueba privilegios de COLUMNA sobre las tablas base.
grant select (kind, brand_id) on public.products to anon;

-- --- Vocabulario de la sociedad: solo backoffice --------------------------
create policy brands_select_member on public.brands
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy brands_insert_catalog on public.brands
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy brands_update_catalog on public.brands
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy brands_delete_catalog on public.brands
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
-- La marca sale a la vitrina SOLO si algo publicado la usa: sin esta condicion,
-- `anon` podria listar el maestro de marcas entero de cualquier sociedad.
create policy brands_select_public on public.brands
  for select to anon
  using (
    is_active
    and exists (
      select 1
      from public.products p
      join public.stores s on s.id = p.store_id
      where p.brand_id = brands.id
        and p.status = 'published'
        and p.published_at is not null
        and p.published_at <= now()
        and s.status = 'active'
    )
  );

create policy product_families_select_member on public.product_families
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy product_families_insert_catalog on public.product_families
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_families_update_catalog on public.product_families
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_families_delete_catalog on public.product_families
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));

create policy attributes_select_member on public.attributes
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy attributes_insert_catalog on public.attributes
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy attributes_update_catalog on public.attributes
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy attributes_delete_catalog on public.attributes
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));

create policy attribute_values_select_member on public.attribute_values
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy attribute_values_insert_catalog on public.attribute_values
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy attribute_values_update_catalog on public.attribute_values
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy attribute_values_delete_catalog on public.attribute_values
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));

create policy units_of_measure_select_member on public.units_of_measure
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy units_of_measure_insert_catalog on public.units_of_measure
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy units_of_measure_update_catalog on public.units_of_measure
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy units_of_measure_delete_catalog on public.units_of_measure
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));

-- --- Lo que cuelga del producto ------------------------------------------
create policy product_variants_select_member on public.product_variants
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy product_variants_insert_catalog on public.product_variants
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_variants_update_catalog on public.product_variants
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_variants_delete_catalog on public.product_variants
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_variants_select_public on public.product_variants
  for select to anon
  using (
    is_active
    and exists (
      select 1
      from public.products p
      join public.stores s on s.id = p.store_id
      where p.id = product_variants.product_id
        and p.status = 'published'
        and p.published_at is not null
        and p.published_at <= now()
        and s.status = 'active'
    )
  );

create policy variant_attribute_values_select_member on public.variant_attribute_values
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy variant_attribute_values_insert_catalog on public.variant_attribute_values
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy variant_attribute_values_update_catalog on public.variant_attribute_values
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy variant_attribute_values_delete_catalog on public.variant_attribute_values
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));

create policy product_attribute_values_select_member on public.product_attribute_values
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy product_attribute_values_insert_catalog on public.product_attribute_values
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_attribute_values_update_catalog on public.product_attribute_values
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_attribute_values_delete_catalog on public.product_attribute_values
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));

create policy product_uoms_select_member on public.product_uoms
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy product_uoms_insert_catalog on public.product_uoms
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_uoms_update_catalog on public.product_uoms
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_uoms_delete_catalog on public.product_uoms
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));

create policy bundle_items_select_member on public.bundle_items
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy bundle_items_insert_catalog on public.bundle_items
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy bundle_items_update_catalog on public.bundle_items
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy bundle_items_delete_catalog on public.bundle_items
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
-- SIN policy anonima a proposito: la composicion del kit no se publica en esta
-- fase. Lo unico que la vitrina pregunta sobre un kit es si se puede comprar, y
-- eso lo responde `ebim.bundle_is_available` (migracion 170100), que lleva su
-- propia autorizacion dentro. Dar aqui lectura a `anon` habria expuesto ademas
-- el enlace a componentes que no estan publicados.

create policy product_relations_select_member on public.product_relations
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy product_relations_insert_catalog on public.product_relations
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_relations_update_catalog on public.product_relations
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_relations_delete_catalog on public.product_relations
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));

comment on table public.bundle_items is
  'Componentes de un kit. No existe tabla `bundles`: el kit ES el producto (products.kind = bundle).';
comment on column public.product_uoms.factor is
  'Unidades BASE que entrega una unidad de esta UoM. numeric(18,6): un factor en float descuadra el inventario.';
comment on constraint bundle_items_no_nesting on public.bundle_items is
  'Un componente no puede ser otro kit: mantiene finito el calculo de existencia por componentes.';
