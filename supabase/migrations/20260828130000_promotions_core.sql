-- =============================================================================
-- P10-SaaS · 1/5 — Motor de promociones: el MODELO
--
-- El precio base (P04) responde "cuanto cuesta esto para este cliente, por este
-- canal, en esta cantidad, hoy". La promocion responde otra pregunta distinta:
-- "cuanto le quito a lo que ya cuesta, por que campana, y hasta cuando". Son
-- dos capas y no una, y mezclarlas es la forma habitual de acabar con un motor
-- que nadie sabe explicar el dia que un precio sale mal — que es exactamente el
-- dia en que hay que explicarlo. P04 dejo esa frontera escrita en su cabecera;
-- esta migracion la respeta: aqui no se toca `price_lists`, ni
-- `price_list_items`, ni `ebim.resolve_prices`.
--
-- ## El orden es una regla, no una casualidad
--
--   precio base  ->  promociones  ->  impuesto  ->  total
--
-- La promocion se aplica SOBRE el precio ya resuelto. Al reves —descontar antes
-- de saber que lista aplica— un mismo cupon valdria distinto segun el acuerdo
-- comercial del comprador sin que nadie lo hubiera decidido.
--
-- ## Siete tablas
--
--   promotions            · la CAMPANA: que descuenta, cuanto, desde cuando,
--                           con que prioridad y si combina con otras.
--   promotion_scopes      · SOBRE QUE lineas: todo, producto, variante,
--                           categoria o marca. Y las exclusiones.
--   promotion_audiences   · A QUIEN: canal, segmento, cliente o cuenta B2B.
--   promotion_tiers       · las ESCALAS de las promociones por volumen.
--   coupons               · el CODIGO que hay que teclear para activarla.
--   promotion_redemptions · QUIEN la uso y en que pedido. Es lo que hace que
--                           "maximo 100 usos" signifique algo.
--   promotion_events      · la BITACORA. Regla 8 del encargo: un cambio sobre
--                           una campana viva tiene que poder reconstruirse.
--
-- ## Lo que este archivo NO hace
--
--  · **No calcula.** El motor vive en `20260828130200`. Aqui solo esta la forma
--    de los datos y lo que el modelo hace IMPOSIBLE.
--  · **No inventa un lenguaje de reglas.** Se penso una columna `rules jsonb`
--    con un mini-DSL y se descarto: sin FK, una regla que apunta a una
--    categoria borrada se queda viva decidiendo dinero, y nadie puede indexar
--    ni explicar un arbol de condiciones libre. El alcance va en columnas
--    TIPADAS con FK compuesta tenant-safe, igual que `price_list_assignments`.
--  · **No modela el envio gratis.** No hay motor de coste de envio hasta P12:
--    una promocion que descuenta un importe que nadie calcula todavia seria una
--    casilla que no hace nada. El enum crece cuando exista el sumando.
--  · **No modela la tarjeta regalo.** Una tarjeta regalo NO es un descuento: es
--    un MEDIO DE PAGO con saldo. Tratarla como promocion falsearia el ingreso y
--    la base imponible del pedido. Va en `20260828130100`, aparte.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Los cuatro vocabularios.
--
-- `promotion_kind` es CERRADO y corto a proposito. Cada valor trae su propia
-- aritmetica en el motor, asi que anadir uno es escribir codigo: un enum con
-- veinte etiquetas de las que solo cinco se calculan seria una promesa que la
-- pantalla hace y el motor no cumple.
-- ---------------------------------------------------------------------------
create type public.promotion_kind as enum (
  -- Un porcentaje sobre las lineas alcanzadas.
  'percentage',
  -- Un importe fijo, repartido entre las lineas alcanzadas.
  'fixed_amount',
  -- Escalas por cantidad: desde 10 un 5 %, desde 50 un 10 %. Ver promotion_tiers.
  'volume_tier',
  -- 3x2 y familia: por cada `buy_quantity` unidades, `free_quantity` sin coste.
  'x_for_y',
  -- Combo: si estan TODOS los componentes, el conjunto lleva descuento.
  'bundle'
);

-- Cuatro estados y ninguno es "programada": eso no es un estado, es una fecha.
-- Una campana `active` cuyo `valid_from` es manana no aplica hoy y la vista de
-- diagnostico la muestra como programada. Guardarlo tambien como estado crearia
-- dos verdades —la columna y el reloj— que se contradicen el dia que alguien
-- olvida el cron.
create type public.promotion_status as enum ('draft', 'active', 'paused', 'archived');

create type public.promotion_scope_kind as enum ('all', 'product', 'variant', 'category', 'brand');

create type public.promotion_audience_kind as enum (
  'all', 'channel', 'segment', 'customer', 'business_account'
);

-- ---------------------------------------------------------------------------
-- promotions — la campana.
--
-- Cuatro columnas gobiernan la combinacion y ninguna es decorativa:
--
--  · `priority`  — el ORDEN de evaluacion. Mayor primero. Es lo que hace que el
--                  resultado no dependa del orden en que Postgres devolvio las
--                  filas, que es la regla 4 del encargo.
--  · `is_exclusive` — "esta va sola". Si se aplica, ninguna otra lo hace.
--  · `stack_group`  — el grupo del que solo puede ganar una. Dos rebajas de
--                     temporada no se suman; una rebaja y un cupon de
--                     bienvenida, si. Con `is_exclusive` no se puede expresar.
--  · `requires_coupon` — sin cupon tecleado, esta campana no existe para el
--                     comprador.
--
-- `usage_count` es una columna y no un `count(*)` sobre `promotion_redemptions`
-- a proposito: el limite de usos se comprueba con la fila BLOQUEADA dentro de
-- la transaccion que crea el pedido (regla 5 del encargo). Un `count(*)` no se
-- puede bloquear, y dos compras simultaneas gastarian el mismo ultimo uso.
-- ---------------------------------------------------------------------------
create table public.promotions (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  code            text        not null,
  name            text        not null,
  description     text,
  kind            public.promotion_kind   not null,
  status          public.promotion_status not null default 'draft',
  -- 0..1000, mismo rango que `price_lists.priority` y por la misma razon: que
  -- "prioridad alta" signifique lo mismo en dos tiendas y que nadie invente
  -- 999999 como forma de ganar siempre.
  priority        integer     not null default 0,
  stack_group     text,
  is_exclusive    boolean     not null default false,
  requires_coupon boolean     not null default false,
  -- ---- Cuanto descuenta. La forma depende del `kind` (CHECK mas abajo) ----
  value_percent       numeric(7,4),
  value_amount        numeric(14,2),
  -- Tope del porcentaje. "20 % hasta 50" es la promocion mas comun que un
  -- modelo sin esta columna no puede expresar.
  max_discount_amount numeric(14,2),
  buy_quantity        numeric(18,6),
  free_quantity       numeric(18,6),
  -- ---- Condiciones de entrada -------------------------------------------
  -- Minimo de compra: se mide contra el BRUTO del pedido antes de descuentos.
  -- Medirlo despues haria que una promocion se desactivase a si misma.
  min_subtotal    numeric(14,2),
  -- Minimo de unidades ALCANZADAS por el alcance de la promocion.
  min_quantity    numeric(18,6),
  valid_from      timestamptz not null default now(),
  valid_to        timestamptz,
  -- ---- Limites de uso ----------------------------------------------------
  usage_limit              integer,
  usage_limit_per_customer integer,
  usage_count              integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint promotions_code_fmt  check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint promotions_name_len  check (char_length(btrim(name)) between 1 and 160),
  constraint promotions_desc_len  check (description is null or char_length(description) <= 2000),
  constraint promotions_priority_range check (priority between 0 and 1000),
  constraint promotions_stack_group_fmt
    check (stack_group is null or stack_group ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint promotions_period check (valid_to is null or valid_to > valid_from),
  constraint promotions_percent_range
    check (value_percent is null or (value_percent > 0 and value_percent <= 100)),
  constraint promotions_amount_positive
    check (value_amount is null or value_amount > 0),
  constraint promotions_cap_positive
    check (max_discount_amount is null or max_discount_amount > 0),
  -- Un tope sobre un importe fijo no significa nada: el importe YA es el tope.
  constraint promotions_cap_only_percent
    check (max_discount_amount is null or value_percent is not null or kind = 'volume_tier'),
  constraint promotions_quantities_positive check (
    (buy_quantity  is null or buy_quantity  > 0) and
    (free_quantity is null or free_quantity > 0) and
    (min_quantity  is null or min_quantity  > 0) and
    (min_subtotal  is null or min_subtotal  >= 0)
  ),
  -- En un 3x2 lo gratis nunca puede ser todo: `free < buy` o el precio es cero.
  constraint promotions_free_below_buy
    check (buy_quantity is null or free_quantity is null or free_quantity < buy_quantity),
  constraint promotions_limits_positive check (
    (usage_limit is null or usage_limit > 0) and
    (usage_limit_per_customer is null or usage_limit_per_customer > 0) and
    usage_count >= 0
  ),
  -- La forma del descuento la impone el TIPO. Sin esto, una campana `x_for_y`
  -- sin `buy_quantity` seria una fila valida que el motor no sabe calcular, y
  -- el fallo apareceria en el primer carrito real en vez de en el alta.
  constraint promotions_kind_shape check (
    (kind = 'percentage'
       and value_percent is not null and value_amount is null
       and buy_quantity is null and free_quantity is null)
    or (kind = 'fixed_amount'
       and value_amount is not null and value_percent is null
       and buy_quantity is null and free_quantity is null)
    or (kind = 'volume_tier'
       and value_percent is null and value_amount is null
       and buy_quantity is null and free_quantity is null)
    or (kind = 'x_for_y'
       and value_percent is null and value_amount is null
       and buy_quantity is not null and free_quantity is not null)
    or (kind = 'bundle'
       and buy_quantity is null and free_quantity is null
       and (value_percent is not null) <> (value_amount is not null))
  ),
  constraint promotions_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint promotions_code_unique unique (store_id, code),
  constraint promotions_store_key   unique (id, store_id),
  constraint promotions_tenant_key  unique (id, organization_id, company_id),
  -- Clave de apoyo para que un hijo pueda amarrar su forma al TIPO del padre
  -- por FK. Es la tecnica del PIM: permite que un CHECK mire otra tabla sin
  -- escribir un trigger que alguien puede desactivar.
  constraint promotions_kind_key    unique (id, kind)
);

create index promotions_tenant_idx on public.promotions (organization_id, company_id);
-- El indice de la evaluacion: de una tienda, las campanas vivas por prioridad.
create index promotions_live_idx
  on public.promotions (store_id, priority desc, created_at, id)
  where status = 'active';
create index promotions_status_idx on public.promotions (store_id, status);

-- ---------------------------------------------------------------------------
-- promotion_scopes — SOBRE QUE lineas cae.
--
-- Sin ninguna fila la promocion no alcanza nada: hay que declarar al menos un
-- alcance, aunque sea `all`. Declarar es una decision; el silencio no.
--
-- `is_exclusion` resta: "toda la categoria BEBIDAS menos la marca X" son dos
-- filas y no una lista negativa aparte. La exclusion GANA siempre —si una linea
-- cae en una fila de exclusion, esa promocion no la toca— y esa precedencia no
-- es configurable: al reves, "excluido" seria una sugerencia.
--
-- `required_quantity` solo tiene sentido en un combo, y por eso solo lo admite
-- un combo. El amarre es la FK compuesta contra `promotions (id, kind)`: un
-- alcance de una campana `percentage` no puede declarar cuantas unidades hacen
-- falta, porque en un porcentaje esa pregunta no existe.
-- ---------------------------------------------------------------------------
create table public.promotion_scopes (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  promotion_id    uuid        not null,
  -- Denormalizado del padre, con `on update cascade`. Existe solo para que los
  -- CHECK de abajo puedan mirar el tipo de la campana.
  promotion_kind  public.promotion_kind not null,
  scope_kind      public.promotion_scope_kind not null,
  product_id      uuid,
  variant_id      uuid,
  category_id     uuid,
  brand_id        uuid,
  required_quantity numeric(18,6),
  is_exclusion    boolean     not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint promotion_scopes_target check (
    (scope_kind = 'all'      and product_id is null     and variant_id is null
                             and category_id is null    and brand_id is null)
    or (scope_kind = 'product'  and product_id is not null and variant_id is null
                                and category_id is null    and brand_id is null)
    -- La variante exige tambien su producto: es lo que permite la FK compuesta
    -- que impide alcanzar la variante de OTRO producto.
    or (scope_kind = 'variant'  and product_id is not null and variant_id is not null
                                and category_id is null    and brand_id is null)
    or (scope_kind = 'category' and category_id is not null and product_id is null
                                and variant_id is null      and brand_id is null)
    or (scope_kind = 'brand'    and brand_id is not null and product_id is null
                                and variant_id is null   and category_id is null)
  ),
  -- Un combo se define por sus COMPONENTES concretos. "Todas las bebidas" no
  -- es un combo, es una categoria: no hay forma de saber cuantas unidades de
  -- que cosa forman el conjunto.
  constraint promotion_scopes_bundle_shape check (
    promotion_kind <> 'bundle'
    or (scope_kind in ('product', 'variant')
        and required_quantity is not null
        and not is_exclusion)
  ),
  -- Y al reves: fuera de un combo, "cuantas unidades" no es una pregunta del
  -- alcance sino del tipo (min_quantity, tiers, buy_quantity).
  constraint promotion_scopes_qty_only_bundle
    check (promotion_kind = 'bundle' or required_quantity is null),
  constraint promotion_scopes_qty_positive
    check (required_quantity is null or required_quantity > 0),

  constraint promotion_scopes_promotion_fk foreign key (promotion_id, promotion_kind)
    references public.promotions (id, kind) on update cascade on delete cascade,
  constraint promotion_scopes_store_promo_fk foreign key (promotion_id, store_id)
    references public.promotions (id, store_id) on delete cascade,
  constraint promotion_scopes_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint promotion_scopes_variant_fk foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete cascade,
  constraint promotion_scopes_category_fk foreign key (category_id, store_id)
    references public.categories (id, store_id) on delete cascade,
  constraint promotion_scopes_brand_fk foreign key (brand_id, organization_id, company_id)
    references public.brands (id, organization_id, company_id) on delete cascade,
  constraint promotion_scopes_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  -- `nulls not distinct`: sin esto el mismo alcance se podria declarar mil
  -- veces, porque NULL <> NULL, y el combo contaria doce veces el mismo
  -- componente.
  constraint promotion_scopes_unique unique nulls not distinct
    (promotion_id, scope_kind, product_id, variant_id, category_id, brand_id, is_exclusion)
);

create index promotion_scopes_tenant_idx   on public.promotion_scopes (organization_id, company_id);
create index promotion_scopes_promo_idx    on public.promotion_scopes (promotion_id);
create index promotion_scopes_product_idx  on public.promotion_scopes (product_id)  where product_id  is not null;
create index promotion_scopes_variant_idx  on public.promotion_scopes (variant_id)  where variant_id  is not null;
create index promotion_scopes_category_idx on public.promotion_scopes (category_id) where category_id is not null;
create index promotion_scopes_brand_idx    on public.promotion_scopes (brand_id)    where brand_id    is not null;

-- ---------------------------------------------------------------------------
-- promotion_audiences — A QUIEN se le aplica.
--
-- Mismo diseno que `price_list_assignments` y por la misma razon: el alcance en
-- columnas TIPADAS y no en un par (tipo, uuid) generico, porque con el par
-- generico no hay FK posible y una audiencia que apunta a un canal borrado se
-- queda viva decidiendo dinero.
--
-- SIN filas = para todo el mundo. Es el caso por defecto de una campana de
-- temporada, y obligar a declarar `all` explicitamente convertiria el alta mas
-- comun en dos pasos.
--
-- **No hay audiencia por "usuario"**: la identidad la emite el hub y un
-- descuento por `sub` seria un `if` por persona dentro del core, que es lo que
-- el principio 2 del contrato prohibe. El eje comercial es el SEGMENTO, y el
-- caso individual es el CLIENTE o la CUENTA, que son filas de negocio.
-- ---------------------------------------------------------------------------
create table public.promotion_audiences (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  promotion_id    uuid        not null,
  audience_kind   public.promotion_audience_kind not null,
  channel_id      uuid,
  segment_id      uuid,
  customer_id     uuid,
  business_account_id uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint promotion_audiences_target check (
    (audience_kind = 'all'      and channel_id is null and segment_id is null
                                and customer_id is null and business_account_id is null)
    or (audience_kind = 'channel'  and channel_id is not null and segment_id is null
                                   and customer_id is null and business_account_id is null)
    or (audience_kind = 'segment'  and segment_id is not null and channel_id is null
                                   and customer_id is null and business_account_id is null)
    or (audience_kind = 'customer' and customer_id is not null and channel_id is null
                                   and segment_id is null and business_account_id is null)
    or (audience_kind = 'business_account' and business_account_id is not null
                                   and channel_id is null and segment_id is null
                                   and customer_id is null)
  ),
  constraint promotion_audiences_promotion_fk foreign key (promotion_id, store_id)
    references public.promotions (id, store_id) on delete cascade,
  constraint promotion_audiences_channel_fk foreign key (channel_id, store_id)
    references public.channels (id, store_id) on delete cascade,
  constraint promotion_audiences_segment_fk foreign key (segment_id, organization_id, company_id)
    references public.customer_segments (id, organization_id, company_id) on delete cascade,
  constraint promotion_audiences_customer_fk foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade,
  constraint promotion_audiences_account_fk foreign key (business_account_id, organization_id, company_id)
    references public.business_accounts (id, organization_id, company_id) on delete cascade,
  constraint promotion_audiences_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint promotion_audiences_unique unique nulls not distinct
    (promotion_id, audience_kind, channel_id, segment_id, customer_id, business_account_id)
);

create index promotion_audiences_tenant_idx  on public.promotion_audiences (organization_id, company_id);
create index promotion_audiences_promo_idx   on public.promotion_audiences (promotion_id);
create index promotion_audiences_channel_idx on public.promotion_audiences (channel_id) where channel_id is not null;

-- ---------------------------------------------------------------------------
-- promotion_tiers — las escalas de una promocion por VOLUMEN.
--
-- `min_quantity` se mide en unidades de la LINEA (las que el comprador compra),
-- y no en unidades base como las escalas de precio de P04. No es una
-- incoherencia: alli la escala decide un PRECIO por unidad base y medirla en
-- unidades de venta haria que cambiar de presentacion cambiara el descuento sin
-- decidirlo; aqui la escala es una promesa comercial sobre lo que el comprador
-- mete en el carrito ("llevate 3 y te hago un 10 %"), y medirla en unidades
-- base la convertiria en una promesa que el comprador no puede comprobar.
--
-- `discount_amount` es POR UNIDAD, no por linea: "2 de descuento a partir de
-- 10" escala con la cantidad, que es lo que una escala significa.
-- ---------------------------------------------------------------------------
create table public.promotion_tiers (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  promotion_id    uuid        not null,
  promotion_kind  public.promotion_kind not null,
  min_quantity    numeric(18,6) not null,
  discount_percent numeric(7,4),
  discount_amount  numeric(14,2),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Solo las campanas por volumen tienen escalas. El amarre es la FK compuesta
  -- contra `promotions (id, kind)`, no un trigger.
  constraint promotion_tiers_only_volume check (promotion_kind = 'volume_tier'),
  constraint promotion_tiers_min_positive check (min_quantity > 0),
  constraint promotion_tiers_one_value
    check ((discount_percent is not null) <> (discount_amount is not null)),
  constraint promotion_tiers_percent_range
    check (discount_percent is null or (discount_percent > 0 and discount_percent <= 100)),
  constraint promotion_tiers_amount_positive
    check (discount_amount is null or discount_amount > 0),
  constraint promotion_tiers_promotion_fk foreign key (promotion_id, promotion_kind)
    references public.promotions (id, kind) on update cascade on delete cascade,
  constraint promotion_tiers_store_promo_fk foreign key (promotion_id, store_id)
    references public.promotions (id, store_id) on delete cascade,
  constraint promotion_tiers_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  -- Dos escalas con el mismo minimo es una ambiguedad que ningun orden de filas
  -- resuelve.
  constraint promotion_tiers_unique unique (promotion_id, min_quantity)
);

create index promotion_tiers_tenant_idx on public.promotion_tiers (organization_id, company_id);
create index promotion_tiers_lookup     on public.promotion_tiers (promotion_id, min_quantity desc);

-- ---------------------------------------------------------------------------
-- coupons — el codigo que hay que teclear.
--
-- ## La normalizacion es una COLUMNA GENERADA, no una convencion
--
-- Un comprador escribe " verano-25 ", "Verano25" y "VERANO 25" queriendo decir
-- lo mismo. Si la normalizacion viviera en el codigo que consulta, habria tres
-- sitios donde acordarse (la vitrina, el backoffice y la importacion) y el dia
-- que uno se olvide, el cupon "no existe" para ese comprador y si para el de al
-- lado. Aqui la normalizacion es parte del DATO: `code_normalized` es GENERATED
-- y el indice unico esta sobre ella, asi que "Verano 25" y "verano-25" son el
-- MISMO cupon y dar de alta el segundo falla.
--
-- El codigo NO es un secreto: un cupon se imprime en un folleto. Lo que protege
-- de que alguien lo adivine no es esconderlo, son los limites de uso — y esos
-- se comprueban con la fila bloqueada, en `20260828130200`.
--
-- Un cupon SIEMPRE pertenece a una promocion. Un cupon sin campana detras seria
-- un descuento sin reglas: sin vigencia, sin alcance y sin prioridad.
-- ---------------------------------------------------------------------------
create table public.coupons (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  promotion_id    uuid        not null,
  code            text        not null,
  -- Mayusculas y solo alfanumerico. `upper` y `regexp_replace` son IMMUTABLE,
  -- que es lo que permite generarla y, sobre todo, indexarla.
  code_normalized text generated always as (
    upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
  ) stored,
  is_active       boolean     not null default true,
  -- Vigencia PROPIA del cupon, opcional. Se INTERSECTA con la de la campana:
  -- un cupon nunca puede alargar la vida de la promocion que lo respalda.
  valid_from      timestamptz,
  valid_to        timestamptz,
  usage_limit              integer,
  usage_limit_per_customer integer,
  usage_count              integer not null default 0,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint coupons_code_len check (char_length(btrim(code)) between 3 and 64),
  -- Un codigo que al normalizar se queda en nada ("---") no se puede teclear.
  constraint coupons_normalized_len check (char_length(code_normalized) between 3 and 40),
  constraint coupons_period check (valid_to is null or valid_from is null or valid_to > valid_from),
  constraint coupons_notes_len check (notes is null or char_length(notes) <= 1000),
  constraint coupons_limits_positive check (
    (usage_limit is null or usage_limit > 0) and
    (usage_limit_per_customer is null or usage_limit_per_customer > 0) and
    usage_count >= 0
  ),
  constraint coupons_promotion_fk foreign key (promotion_id, store_id)
    references public.promotions (id, store_id) on delete cascade,
  constraint coupons_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint coupons_store_key  unique (id, store_id),
  constraint coupons_tenant_key unique (id, organization_id, company_id)
);

-- El indice que hace de la normalizacion una garantia y no una intencion.
create unique index coupons_code_key on public.coupons (store_id, code_normalized);
create index coupons_tenant_idx      on public.coupons (organization_id, company_id);
create index coupons_promotion_idx   on public.coupons (promotion_id);

-- ---------------------------------------------------------------------------
-- promotion_redemptions — quien la uso, en que pedido y cuanto se llevo.
--
-- Es lo que convierte "maximo 100 usos" y "uno por cliente" en algo que se
-- puede comprobar. Y es tambien la explicacion de un pedido: junto con
-- `order_items.discount_snapshot`, responde "por que este pedido costo esto".
--
-- `unique (order_id, promotion_id)`: una campana se cobra UNA vez por pedido.
-- Sin ese indice, un reintento del alta podria contar dos usos del mismo cupon
-- para la misma compra, y el limite se agotaria a mitad.
--
-- La identidad del comprador se guarda por TRES vias porque en esta app hay
-- tres y ninguna cubre a las otras: `customer_email` (el anonimo de la vitrina,
-- que es la mayoria), `customer_id` (la ficha, cuando la hay) y
-- `business_account_id` (la cuenta corporativa). El limite por cliente se mide
-- por la mas fuerte que exista.
-- ---------------------------------------------------------------------------
create table public.promotion_redemptions (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  promotion_id    uuid        not null,
  coupon_id       uuid,
  order_id        uuid        not null,
  customer_email  text        not null,
  customer_id     uuid,
  business_account_id uuid,
  -- Lo que descontó ESTA campana en ESE pedido, en bruto (con impuesto dentro
  -- si la tienda trabaja con precios con impuesto incluido).
  discount_amount numeric(14,2) not null,
  currency        char(3)     not null,
  redeemed_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),

  constraint promotion_redemptions_amount check (discount_amount >= 0),
  constraint promotion_redemptions_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint promotion_redemptions_email_fmt check (position('@' in customer_email) > 1),
  constraint promotion_redemptions_promotion_fk foreign key (promotion_id, store_id)
    references public.promotions (id, store_id) on delete cascade,
  constraint promotion_redemptions_coupon_fk foreign key (coupon_id, store_id)
    references public.coupons (id, store_id) on delete set null (coupon_id),
  constraint promotion_redemptions_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade,
  constraint promotion_redemptions_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint promotion_redemptions_once unique (order_id, promotion_id)
);

create index promotion_redemptions_tenant_idx on public.promotion_redemptions (organization_id, company_id);
create index promotion_redemptions_promo_idx
  on public.promotion_redemptions (promotion_id, lower(customer_email));
create index promotion_redemptions_coupon_idx
  on public.promotion_redemptions (coupon_id, lower(customer_email)) where coupon_id is not null;
create index promotion_redemptions_order_idx on public.promotion_redemptions (order_id);
create index promotion_redemptions_store_idx on public.promotion_redemptions (store_id, redeemed_at desc);

-- ---------------------------------------------------------------------------
-- promotion_events — la bitacora (regla 8 del encargo).
--
-- "Cambios en una promocion activa deben ser auditables". Se anota TODO cambio
-- sobre la campana y sus reglas, y ademas se guarda el estado que la campana
-- tenia en ese momento (`promotion_status`), porque no es lo mismo retocar un
-- borrador que cambiar el porcentaje de algo que se esta cobrando ahora mismo.
--
-- SIN FK hacia `promotions`, igual que `price_change_events` con `price_lists`:
-- la bitacora tiene que sobrevivir al borrado de la campana, que es
-- precisamente el caso en que hace falta.
--
-- Se escribe SOLO por trigger `SECURITY DEFINER`. `authenticated` la lee y no
-- la toca; `anon` no tiene nada.
-- ---------------------------------------------------------------------------
create table public.promotion_events (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  promotion_id    uuid,
  entity          text        not null,
  entity_id       uuid,
  action          text        not null,
  -- Estado de la CAMPANA cuando se hizo el cambio. NULL cuando la campana ya
  -- no existe (borrado en cascada de una regla hija).
  promotion_status public.promotion_status,
  before_state    jsonb,
  after_state     jsonb,
  actor_id        uuid,
  actor_email     text,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),

  constraint promotion_events_action check (action in ('insert', 'update', 'delete')),
  constraint promotion_events_entity check (
    entity in ('promotion', 'scope', 'audience', 'tier', 'coupon')
  ),
  constraint promotion_events_shapes check (
    (before_state is null or jsonb_typeof(before_state) = 'object')
    and (after_state is null or jsonb_typeof(after_state) = 'object')
  )
);

create index promotion_events_tenant_idx on public.promotion_events (organization_id, company_id);
create index promotion_events_store_idx  on public.promotion_events (store_id, occurred_at desc);
create index promotion_events_promo_idx  on public.promotion_events (promotion_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- El trigger de bitacora.
--
-- `SECURITY DEFINER` porque `promotion_events` no tiene policy de INSERT para
-- nadie: la unica escritura posible es esta, asi que una fila de bitacora no se
-- puede fabricar ni borrar desde el cliente. La autorizacion va DENTRO
-- (leccion esupplier-030): la funcion **no acepta el tenant**, lo deriva de la
-- propia fila que se esta escribiendo —que ya paso por la RLS de la tabla
-- origen— y el actor del JWT. No hay forma de usarla para escribir en el tenant
-- de al lado porque no hay forma de decirle cual.
-- ---------------------------------------------------------------------------
create or replace function ebim.log_promotion_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_before  jsonb;
  v_after   jsonb;
  v_row     jsonb;
  v_entity  text := tg_argv[0];
  v_promo   uuid;
  v_status  public.promotion_status;
begin
  if tg_op <> 'INSERT' then v_before := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_after  := to_jsonb(new); end if;
  v_row := coalesce(v_after, v_before);

  if v_entity = 'promotion' then
    v_promo := (v_row ->> 'id')::uuid;
  else
    v_promo := (v_row ->> 'promotion_id')::uuid;
  end if;

  -- La campana puede estar ya borrada cuando el hijo cae en cascada: entonces
  -- el estado es NULL, que es la verdad y no un valor inventado.
  select p.status into v_status from public.promotions p where p.id = v_promo;

  insert into public.promotion_events (
    organization_id, company_id, store_id,
    promotion_id, entity, entity_id, action, promotion_status,
    before_state, after_state, actor_id, actor_email
  ) values (
    (v_row ->> 'organization_id')::uuid,
    (v_row ->> 'company_id')::uuid,
    (v_row ->> 'store_id')::uuid,
    v_promo, v_entity, (v_row ->> 'id')::uuid, lower(tg_op), v_status,
    v_before, v_after, ebim.user_id(), ebim.email()
  );

  return coalesce(new, old);
end;
$fn$;

revoke execute on function ebim.log_promotion_change() from public, anon, authenticated;

create trigger promotions_audit
  after insert or update or delete on public.promotions
  for each row execute function ebim.log_promotion_change('promotion');
create trigger promotion_scopes_audit
  after insert or update or delete on public.promotion_scopes
  for each row execute function ebim.log_promotion_change('scope');
create trigger promotion_audiences_audit
  after insert or update or delete on public.promotion_audiences
  for each row execute function ebim.log_promotion_change('audience');
create trigger promotion_tiers_audit
  after insert or update or delete on public.promotion_tiers
  for each row execute function ebim.log_promotion_change('tier');
create trigger coupons_audit
  after insert or update or delete on public.coupons
  for each row execute function ebim.log_promotion_change('coupon');

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create trigger promotions_set_updated_at before update on public.promotions
  for each row execute function ebim.set_updated_at();
create trigger promotion_scopes_set_updated_at before update on public.promotion_scopes
  for each row execute function ebim.set_updated_at();
create trigger promotion_audiences_set_updated_at before update on public.promotion_audiences
  for each row execute function ebim.set_updated_at();
create trigger promotion_tiers_set_updated_at before update on public.promotion_tiers
  for each row execute function ebim.set_updated_at();
create trigger coupons_set_updated_at before update on public.coupons
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS · default deny en las siete tablas.
--
-- **Escritura: rol Y capacidad.** `owner`/`admin` y `promotions` contratada.
-- Una campana es una decision comercial con efecto directo sobre el ingreso;
-- `catalog` mantiene productos y precios de catalogo, no decide rebajas.
--
-- **Lectura: solo `can_access`, sin capacidad.** Si un tenant deja de pagar el
-- modulo, sus campanas dejan de APLICARSE (lo comprueba el motor) pero se
-- siguen VIENDO: esconderlas convertiria una baja comercial en una perdida de
-- datos aparente, y quien atiende la baja necesita poder mirarlas. Es la misma
-- decision que P04 tomo con las listas de precio.
--
-- **`usage_count` no tiene GRANT de UPDATE.** El contador de usos es dinero: lo
-- mueve el comando transaccional de `20260828130200` y nadie mas. Es el GRANT
-- POR COLUMNA de mas abajo — la RLS filtra filas, nunca columnas.
--
-- `anon` no tiene ni un GRANT sobre ninguna de las siete. El comprador de la
-- vitrina no lee campanas: le llega el RESULTADO ya calculado por el servidor,
-- que es la regla 6 del encargo ("no permitas que el frontend marque una
-- promocion como aplicada"). Saber que existe un 40 % para el segmento
-- mayorista es informacion comercial de la sociedad, no del catalogo.
-- ---------------------------------------------------------------------------
alter table public.promotions            enable row level security;
alter table public.promotions            force  row level security;
alter table public.promotion_scopes      enable row level security;
alter table public.promotion_scopes      force  row level security;
alter table public.promotion_audiences   enable row level security;
alter table public.promotion_audiences   force  row level security;
alter table public.promotion_tiers       enable row level security;
alter table public.promotion_tiers       force  row level security;
alter table public.coupons               enable row level security;
alter table public.coupons               force  row level security;
alter table public.promotion_redemptions enable row level security;
alter table public.promotion_redemptions force  row level security;
alter table public.promotion_events      enable row level security;
alter table public.promotion_events      force  row level security;

revoke all on public.promotions            from public, anon, authenticated;
revoke all on public.promotion_scopes      from public, anon, authenticated;
revoke all on public.promotion_audiences   from public, anon, authenticated;
revoke all on public.promotion_tiers       from public, anon, authenticated;
revoke all on public.coupons               from public, anon, authenticated;
revoke all on public.promotion_redemptions from public, anon, authenticated;
revoke all on public.promotion_events      from public, anon, authenticated;

-- GRANT POR COLUMNA en las dos tablas que llevan contador: `usage_count` no
-- entra. La RLS filtra filas, nunca columnas — esta es la otra mitad.
grant select, insert, delete on public.promotions to authenticated;
grant update (
  code, name, description, status, priority, stack_group, is_exclusive,
  requires_coupon, value_percent, value_amount, max_discount_amount,
  buy_quantity, free_quantity, min_subtotal, min_quantity,
  valid_from, valid_to, usage_limit, usage_limit_per_customer, updated_at
) on public.promotions to authenticated;

grant select, insert, delete on public.coupons to authenticated;
grant update (
  code, is_active, valid_from, valid_to,
  usage_limit, usage_limit_per_customer, notes, updated_at
) on public.coupons to authenticated;

grant select, insert, update, delete on public.promotion_scopes    to authenticated;
grant select, insert, update, delete on public.promotion_audiences to authenticated;
grant select, insert, update, delete on public.promotion_tiers     to authenticated;
-- Canjes y bitacora: se leen, no se tocan. Ni con el rol mas alto.
grant select on public.promotion_redemptions to authenticated;
grant select on public.promotion_events      to authenticated;

grant all on public.promotions, public.promotion_scopes, public.promotion_audiences,
             public.promotion_tiers, public.coupons, public.promotion_redemptions,
             public.promotion_events
  to service_role;

-- --- promotions ------------------------------------------------------------
create policy promotions_select_member on public.promotions
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy promotions_insert_admin on public.promotions
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

create policy promotions_update_admin on public.promotions
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

create policy promotions_delete_admin on public.promotions
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

-- --- promotion_scopes ------------------------------------------------------
create policy promotion_scopes_select_member on public.promotion_scopes
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy promotion_scopes_insert_admin on public.promotion_scopes
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

create policy promotion_scopes_update_admin on public.promotion_scopes
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

create policy promotion_scopes_delete_admin on public.promotion_scopes
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

-- --- promotion_audiences ---------------------------------------------------
create policy promotion_audiences_select_member on public.promotion_audiences
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy promotion_audiences_insert_admin on public.promotion_audiences
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

create policy promotion_audiences_update_admin on public.promotion_audiences
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

create policy promotion_audiences_delete_admin on public.promotion_audiences
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

-- --- promotion_tiers -------------------------------------------------------
create policy promotion_tiers_select_member on public.promotion_tiers
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy promotion_tiers_insert_admin on public.promotion_tiers
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

create policy promotion_tiers_update_admin on public.promotion_tiers
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

create policy promotion_tiers_delete_admin on public.promotion_tiers
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

-- --- coupons ---------------------------------------------------------------
create policy coupons_select_member on public.coupons
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy coupons_insert_admin on public.coupons
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

create policy coupons_update_admin on public.coupons
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

create policy coupons_delete_admin on public.coupons
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

-- --- canjes y bitacora: solo lectura, y ni un GRANT que lo desmienta -------
create policy promotion_redemptions_select_member on public.promotion_redemptions
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy promotion_events_select_member on public.promotion_events
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- ---------------------------------------------------------------------------
comment on table public.promotions is
  'Campana promocional de una tienda: que descuenta, sobre que, desde cuando, con que prioridad y si combina. Se aplica DESPUES del precio base (P04), nunca mezclada con el.';
comment on column public.promotions.priority is
  'Orden de evaluacion, mayor primero. Es lo que hace que el resultado no dependa del orden accidental de las consultas.';
comment on column public.promotions.stack_group is
  'Grupo del que solo puede ganar UNA. Distinto de is_exclusive, que impide combinar con cualquier otra.';
comment on column public.promotions.usage_count is
  'Contador de usos. Sin GRANT de UPDATE: lo mueve el comando transaccional con la fila bloqueada, nunca el cliente.';
comment on column public.promotions.min_subtotal is
  'Minimo de compra medido sobre el BRUTO del pedido antes de descuentos. Medirlo despues haria que una promocion se desactivase a si misma.';
comment on table public.promotion_scopes is
  'Sobre que lineas cae la promocion: todo, producto, variante, categoria o marca. is_exclusion resta y gana siempre.';
comment on column public.promotion_scopes.required_quantity is
  'Solo en combos: cuantas unidades de este componente forman el conjunto. La FK compuesta contra promotions(id, kind) impide declararla en cualquier otro tipo.';
comment on table public.promotion_audiences is
  'A quien se aplica: canal, segmento, cliente o cuenta B2B. SIN filas = a todo el mundo.';
comment on table public.promotion_tiers is
  'Escalas por volumen. min_quantity se mide en unidades de la LINEA (lo que el comprador ve), no en unidades base como las escalas de precio de P04.';
comment on column public.promotion_tiers.discount_amount is
  'Importe POR UNIDAD, no por linea: una escala que no escala con la cantidad no es una escala.';
comment on table public.coupons is
  'Codigo que activa una promocion. code_normalized es GENERATED (mayusculas, solo alfanumerico) y el indice unico esta sobre ella: "Verano 25" y "verano-25" son el MISMO cupon.';
comment on column public.coupons.code_normalized is
  'Normalizacion como DATO y no como convencion. Sin esto habria tres sitios donde acordarse de normalizar y el cupon existiria para unos compradores y no para otros.';
comment on table public.promotion_redemptions is
  'Quien uso que campana, en que pedido y cuanto se llevo. Es lo que hace comprobables los limites de uso y lo que explica el descuento de un pedido.';
comment on table public.promotion_events is
  'Bitacora de cambios sobre campanas y sus reglas, con el estado que la campana tenia en ese momento. Se escribe solo por trigger DEFINER; sin FK para sobrevivir al borrado.';
