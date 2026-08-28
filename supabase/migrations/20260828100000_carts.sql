-- =============================================================================
-- P07-SaaS · El carrito deja de vivir solo en el navegador
--
-- Hasta aqui el carrito era `localStorage` y nada mas (`src/features/storefront/
-- cart/cart.ts`): una lista de deseos que el servidor no conocia. Eso bastaba
-- mientras el checkout fuera una sola llamada, y deja de bastar en cuanto hay
-- que apartar existencia (P06), reintentar un intento de compra sin duplicarlo
-- y recuperar la compra en otro dispositivo.
--
-- ## Lo que NO cambia
--
-- **El invitado sigue comprando desde `localStorage`.** Nadie crea una fila por
-- visita: un carrito de servidor por cada persona que abre el catalogo seria
-- una tabla de basura con un indice caro y un dato personal mas que custodiar.
-- La fila nace cuando hace falta de verdad — cuando el comprador inicia sesion
-- (y entonces su carrito tiene que viajar con el) o cuando empieza el checkout
-- (y entonces hace falta un ancla estable para la reserva y la idempotencia).
--
-- ## Las cuatro decisiones de este archivo
--
-- 1. **El carrito es de UNA tienda y de UN canal.** Las dos columnas son NOT
--    NULL y las dos van en la clave del carrito activo. Mezclar tiendas ya lo
--    impedia el navegador (clave de `localStorage` por tienda); mezclar CANALES
--    no lo impedia nadie, y es peor: el canal decide el precio y si hace falta
--    sesion. Un carrito que empieza en el canal publico y acaba en el interno
--    seria un descuento que nadie concedio.
--
-- 2. **El dueño es una sesion O un secreto, nunca un id declarado.** `user_id`
--    es el `sub` del JWT y solo lo escribe el servidor; `token` son 256 bits
--    (mismo patron que `order_tokens` de 140000 y que el de la reserva de
--    200000) y es lo unico que puede presentar un invitado. No hay ninguna
--    columna que el navegador pueda rellenar para decir de quien es un carrito.
--
-- 3. **El precio guardado es un SNAPSHOT informativo, y la columna lo dice en
--    su nombre.** `unit_price_snapshot` no es autoridad de cobro: existe para
--    poder pintar la linea y para poder DECIR "esto subio" al recotizar. Quien
--    cobra sigue siendo `ebim.resolve_price` dentro de `create_order`. Llamarla
--    `unit_price` habria sido invitar a que alguien la sumara.
--
-- 4. **El token no sale en el GRANT del backoffice.** `revoke select (columna)`
--    no anula un `grant select` de tabla entera (leccion de 140000), asi que el
--    grant se hace POR COLUMNA y `token` se queda fuera. El comercio ve el
--    carrito abandonado de su tienda; no ve el secreto con el que operarlo.
-- =============================================================================

create type public.cart_status as enum ('active', 'converted', 'abandoned', 'merged');

-- ---------------------------------------------------------------------------
-- carts
-- ---------------------------------------------------------------------------
create table public.carts (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  channel_id      uuid        not null,
  -- `sub` del JWT del comprador con sesion. NULL = invitado, y entonces el
  -- unico titulo de propiedad es el token.
  user_id         uuid,
  -- 2 uuid v4 sin guiones = 256 bits en hexadecimal seguro para URL. Mismo
  -- patron que `order_tokens.token`: `gen_random_uuid()` es nucleo de Postgres
  -- y no depende de que pgcrypto este habilitada.
  token           text        not null default
                    replace(gen_random_uuid()::text, '-', '') ||
                    replace(gen_random_uuid()::text, '-', ''),
  status          public.cart_status not null default 'active',
  currency        text        not null,
  -- Adonde acabo. Se rellena en la MISMA transaccion que crea el pedido.
  order_id        uuid,
  -- Adonde se fusiono, cuando el invitado inicio sesion.
  merged_into     uuid        references public.carts (id) on delete set null,
  -- Un carrito sin caducidad es existencia apartada para siempre el dia que
  -- reserve. La eligen las operaciones, pero no pueden elegir no elegirla.
  expires_at      timestamptz not null default now() + interval '30 days',
  last_activity_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint carts_token_len    check (char_length(token) = 64),
  constraint carts_token_unique unique (token),
  constraint carts_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint carts_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  -- El canal tiene que ser de ESTA tienda. Es la FK compuesta de siempre, y es
  -- lo que hace estructuralmente imposible el carrito que mezcla canales.
  constraint carts_channel_fk foreign key (channel_id, store_id)
    references public.channels (id, store_id) on delete restrict,
  constraint carts_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade,
  -- Un carrito convertido sin pedido, o fusionado sin destino, son filas que
  -- alguien tendra que interpretar dentro de un año.
  constraint carts_converted_has_order check (status <> 'converted' or order_id is not null),
  constraint carts_merged_has_target   check (status <> 'merged'    or merged_into is not null),
  constraint carts_no_self_merge       check (merged_into is null or merged_into <> id),
  constraint carts_store_key  unique (id, store_id),
  constraint carts_tenant_key unique (id, organization_id, company_id)
);

create index carts_tenant on public.carts (organization_id, company_id);
create index carts_store  on public.carts (store_id, status, last_activity_at desc);
create index carts_due    on public.carts (expires_at) where status = 'active';

-- Un usuario con sesion tiene UN carrito activo por tienda y canal. Si hubiera
-- dos, iniciar sesion en otro dispositivo elegiria uno por orden de filas y el
-- comprador veria un carrito distinto en cada pantalla.
create unique index carts_one_active_per_user
  on public.carts (store_id, channel_id, user_id)
  where status = 'active' and user_id is not null;

create trigger carts_updated_at before update on public.carts
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- cart_items
-- ---------------------------------------------------------------------------
create table public.cart_items (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  cart_id         uuid        not null,
  product_id      uuid        not null,
  variant_id      uuid,
  -- Presentacion de venta declarada. El FACTOR lo resuelve la base, siempre.
  uom_code        text,
  quantity        integer     not null,
  -- SNAPSHOT INFORMATIVO (regla 5 de la fase). No se cobra con esto: sirve
  -- para pintar la linea y para poder decir "el precio cambio" al recotizar.
  unit_price_snapshot numeric(14,2),
  currency_snapshot   text,
  quoted_at           timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint cart_items_qty check (quantity between 1 and 10000),
  constraint cart_items_uom_fmt check (uom_code is null or uom_code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$'),
  constraint cart_items_currency_fmt
    check (currency_snapshot is null or currency_snapshot ~ '^[A-Z]{3}$'),
  -- Un importe sin fecha no se puede comparar con nada, y una fecha sin importe
  -- no dice cuanto valia. O los dos o ninguno.
  constraint cart_items_snapshot_pair
    check ((unit_price_snapshot is null) = (quoted_at is null)),
  constraint cart_items_cart_fk foreign key (cart_id, store_id)
    references public.carts (id, store_id) on delete cascade,
  constraint cart_items_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint cart_items_variant_fk foreign key (variant_id, store_id)
    references public.product_variants (id, store_id) on delete cascade
);

create index cart_items_tenant on public.cart_items (organization_id, company_id);
create index cart_items_cart   on public.cart_items (cart_id);

-- La identidad de una linea es la TERNA producto + variante + presentacion, la
-- misma que usan `create_order` y `ebim.build_quote`. Con `unique (cart_id,
-- product_id, variant_id, uom_code)` los NULL no chocarian entre si y "1 silla"
-- podria entrar dos veces.
create unique index cart_items_line_unique
  on public.cart_items (
    cart_id,
    product_id,
    coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(uom_code, '')
  );

create trigger cart_items_updated_at before update on public.cart_items
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — default deny, y ninguna escritura desde el cliente
--
-- Ni `anon` ni `authenticated` pueden insertar, actualizar ni borrar una sola
-- fila: un carrito que el navegador puede escribir directamente es un carrito
-- con productos de otra tienda, cantidades fuera de rango y precios inventados.
-- Toda escritura pasa por las funciones de 100100, que validan contra el
-- catalogo y derivan el tenant de la tienda.
-- ---------------------------------------------------------------------------
alter table public.carts      enable row level security;
alter table public.carts      force  row level security;
alter table public.cart_items enable row level security;
alter table public.cart_items force  row level security;

revoke all on public.carts, public.cart_items from public, anon, authenticated;
grant  all on public.carts, public.cart_items to service_role;

-- Lectura del backoffice, POR COLUMNA y sin `token`: el comercio ve sus
-- carritos abandonados (es el dato con el que se recupera una venta) y no ve el
-- secreto con el que se podria operar sobre ellos.
grant select (
  id, organization_id, company_id, store_id, channel_id, user_id, status,
  currency, order_id, merged_into, expires_at, last_activity_at,
  created_at, updated_at
) on public.carts to authenticated;

grant select on public.cart_items to authenticated;

create policy carts_select_member on public.carts
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy cart_items_select_member on public.cart_items
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

comment on table public.carts is
  'Carrito del servidor. Nace cuando hace falta de verdad (sesion o checkout), no por visita. De una tienda y de UN canal: mezclarlos cambiaria el precio sin que nadie lo decidiera.';
comment on column public.carts.token is
  'Secreto de portador del invitado (256 bits). Fuera del GRANT del backoffice a proposito: un revoke por columna no anula un grant de tabla.';
comment on column public.carts.user_id is
  'sub del JWT. Lo escribe el servidor; no hay forma de declararlo desde el navegador.';
comment on column public.cart_items.unit_price_snapshot is
  'INFORMATIVO. El precio de cobro lo resuelve ebim.resolve_price dentro de create_order; esto solo sirve para pintar y para detectar que cambio.';
