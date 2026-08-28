-- =============================================================================
-- P06-SaaS · Las puertas: quien puede mover existencia y desde donde
--
-- El motor de la migracion anterior vive en el esquema `ebim` y no lo puede
-- llamar nadie de fuera. Aqui estan las puertas, y hay varias porque hay varios
-- llamantes distintos y **cada uno trae su propia autorizacion** — es la misma
-- decision que P04 tomo con `price_quote_for_slug` / `price_quote` y P05 con
-- `my_business_accounts`: una funcion con una bandera «soy el servidor» seria
-- una bandera que alguien puede levantar.
--
-- | Puerta | Quien la abre | Como se autoriza |
-- |---|---|---|
-- | `reserve_inventory` | backoffice con sesion | rol + capacidad, tenant de la TIENDA |
-- | `reserve_inventory_for_slug` | servidor (carrito anonimo) | `service_role`; la tienda sale del slug |
-- | `release_inventory_reservation` / `commit_…` | backoffice con sesion | rol + capacidad |
-- | `release_inventory_by_token` | servidor (carrito abandonado) | `service_role` + secreto de 256 bits |
-- | `expire_inventory_reservations` | servidor (barrido) | `service_role` |
-- | `adjust_inventory` / `set_inventory_policy` / `seed_inventory_from_catalog` | backoffice con sesion | rol + capacidad |
-- | `sync_inventory_level` | servidor (ERP) | `service_role` |
-- | `inventory_availability` | backoffice con sesion | membresia |
--
-- **Ninguna acepta `organization_id` ni `company_id`.** Todas los derivan de la
-- fila que el llamante nombra —la tienda, el almacen— y comprueban contra el
-- JWT. Un identificador de tenant que se puede pasar se puede pasar mal.
--
-- **Por que el backoffice tambien reserva.** No es simetria por gusto: quien
-- atiende un pedido por telefono o una cuenta B2B necesita apartar unidades
-- mientras el cliente confirma, y sin esa puerta la unica forma seria bajar la
-- existencia a mano — que es exactamente el descuadre que este dominio existe
-- para evitar.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.assert_inventory_role — los dos ejes, en el orden correcto.
--
-- Rol Y capacidad. Un `admin` sin el modulo contratado no mueve existencia por
-- almacen, y un tenant con el modulo pero con rol `viewer`, tampoco. Es la
-- composicion que `capabilities.ts` describe, aplicada donde manda.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_inventory_role(
  p_organization_id uuid,
  p_company_id uuid,
  p_roles public.app_role[]
)
returns void
language plpgsql
stable
set search_path = ''
as $fn$
begin
  if not ebim.has_role(p_organization_id, p_company_id, p_roles) then
    raise exception 'SIN_PERMISO: tu rol no puede mover existencias'
      using errcode = '42501';
  end if;

  if not ebim.company_is_entitled(p_organization_id, p_company_id, 'inventory.multiwarehouse') then
    raise exception 'MODULO_NO_CONTRATADO: el inventario por almacen no esta activo en esta sociedad'
      using errcode = '42501';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.ensure_level — la fila de existencia de un SKU en un almacen.
--
-- Se crea vacia la primera vez que alguien la nombra. Es lo que permite que
-- «entrada de 20 unidades» funcione sobre un producto que nunca estuvo en ese
-- almacen sin obligar a un alta previa que nadie entenderia.
--
-- `allow_backorder` se copia del almacen: es la columna denormalizada que hace
-- posible el CHECK anti-sobreventa, y la FK a la clave de apoyo del padre
-- rechaza cualquier valor que el almacen no tenga.
-- ---------------------------------------------------------------------------
create or replace function ebim.ensure_level(
  p_warehouse_id uuid,
  p_product_id   uuid,
  p_variant_id   uuid
)
returns uuid
language plpgsql
set search_path = ''
as $fn$
declare
  v_warehouse public.warehouses%rowtype;
  v_product   public.products%rowtype;
  v_id        uuid;
begin
  select * into v_warehouse from public.warehouses w where w.id = p_warehouse_id;
  if not found then
    raise exception 'ALMACEN_NO_ENCONTRADO: %', p_warehouse_id using errcode = '22023';
  end if;

  select * into v_product from public.products p where p.id = p_product_id;
  if not found then
    raise exception 'PRODUCTO_NO_DISPONIBLE: %', p_product_id using errcode = '22023';
  end if;

  -- El almacen y el producto tienen que ser de la MISMA sociedad. La FK ya lo
  -- impediria por el camino de la tienda, pero el mensaje seria el de una clave
  -- foranea y no el de un error de negocio.
  if v_product.organization_id <> v_warehouse.organization_id
     or v_product.company_id <> v_warehouse.company_id then
    raise exception 'ALMACEN_DE_OTRA_SOCIEDAD: el almacen % no puede guardar %',
      v_warehouse.code, v_product.sku using errcode = '22023';
  end if;

  if v_product.kind = 'bundle' then
    raise exception 'KIT_SIN_EXISTENCIA: % es un kit y su existencia es la de sus componentes',
      v_product.sku using errcode = '22023';
  end if;

  if v_product.kind = 'variant' and p_variant_id is null then
    raise exception 'VARIANTE_REQUERIDA: % lleva existencia por variante', v_product.sku
      using errcode = '22023';
  end if;

  if v_product.kind <> 'variant' and p_variant_id is not null then
    raise exception 'VARIANTE_NO_APLICA: % no tiene variantes', v_product.sku
      using errcode = '22023';
  end if;

  select l.id into v_id
  from public.inventory_levels l
  where l.warehouse_id = p_warehouse_id
    and l.product_id   = p_product_id
    and l.variant_id is not distinct from p_variant_id;

  if found then return v_id; end if;

  insert into public.inventory_levels (
    organization_id, company_id, warehouse_id, store_id, product_id, variant_id,
    allow_backorder
  ) values (
    v_product.organization_id, v_product.company_id, p_warehouse_id, v_product.store_id,
    p_product_id, p_variant_id, v_warehouse.allows_backorder
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.reserve_inventory — apartar unidades desde el backoffice.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_inventory(
  p_store_id      uuid,
  p_reference_key text,
  p_items         jsonb,
  p_ttl_seconds   integer default 900,
  p_reference_kind text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
begin
  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: %', p_store_id using errcode = '22023';
  end if;

  perform ebim.assert_inventory_role(
    v_store.organization_id, v_store.company_id,
    array['owner','admin','orders']::public.app_role[]);

  if p_reference_kind not in ('manual', 'order') then
    raise exception 'REFERENCIA_INVALIDA: el backoffice reserva por pedido o a mano'
      using errcode = '22023';
  end if;

  return ebim.hold_stock(
    v_store.id, p_reference_kind, p_reference_key, p_items, p_ttl_seconds, ebim.user_id());
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.reserve_inventory_for_slug — el carrito anonimo.
--
-- Gemela de `create_order_for_slug` (091300) y por la misma razon: el comprador
-- no tiene sesion, asi que la tienda la resuelve el SERVIDOR desde el slug de
-- la URL publica. Nunca se acepta un `store_id`.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_inventory_for_slug(
  p_store_slug    text,
  p_reference_key text,
  p_items         jsonb,
  p_ttl_seconds   integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store_id uuid;
  v_slug     text := lower(btrim(coalesce(p_store_slug, '')));
begin
  if v_slug = '' then
    raise exception 'TIENDA_NO_DISPONIBLE: falta la tienda de la reserva'
      using errcode = '22023';
  end if;

  select s.id into v_store_id
  from public.stores s
  where lower(s.slug) = v_slug and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  return ebim.hold_stock(v_store_id, 'cart', p_reference_key, p_items, p_ttl_seconds, null);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.release_inventory_reservation / commit_inventory_reservation
-- ---------------------------------------------------------------------------
create or replace function public.release_inventory_reservation(
  p_reservation_id uuid,
  p_reason         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_res public.inventory_reservations%rowtype;
begin
  select * into v_res from public.inventory_reservations r where r.id = p_reservation_id;
  if not found then
    raise exception 'RESERVA_NO_ENCONTRADA: %', p_reservation_id using errcode = '22023';
  end if;

  perform ebim.assert_inventory_role(
    v_res.organization_id, v_res.company_id,
    array['owner','admin','orders']::public.app_role[]);

  return ebim.close_reservation(
    v_res.id, 'released'::public.reservation_status, p_reason, null, ebim.user_id());
end;
$fn$;

create or replace function public.commit_inventory_reservation(
  p_reservation_id uuid,
  p_reason         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_res public.inventory_reservations%rowtype;
begin
  select * into v_res from public.inventory_reservations r where r.id = p_reservation_id;
  if not found then
    raise exception 'RESERVA_NO_ENCONTRADA: %', p_reservation_id using errcode = '22023';
  end if;

  perform ebim.assert_inventory_role(
    v_res.organization_id, v_res.company_id,
    array['owner','admin','orders']::public.app_role[]);

  return ebim.close_reservation(
    v_res.id, 'committed'::public.reservation_status, p_reason, v_res.order_id, ebim.user_id());
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.release_inventory_by_token — el carrito que se abandona.
--
-- El comprador anonimo no tiene sesion y su reserva no lleva su nombre: lo
-- unico que puede probar que es suya es el secreto de 256 bits que recibio al
-- reservarla. Mismo patron que `order_by_token` (140000), y por eso la funcion
-- no distingue «no existe» de «token incorrecto».
-- ---------------------------------------------------------------------------
create or replace function public.release_inventory_by_token(
  p_store_slug text,
  p_token      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_res public.inventory_reservations%rowtype;
begin
  if p_token is null or char_length(p_token) <> 64 then
    raise exception 'RESERVA_NO_ENCONTRADA: no hay ninguna reserva con esos datos'
      using errcode = '22023';
  end if;

  select r.* into v_res
  from public.inventory_reservations r
  join public.stores s on s.id = r.store_id
  where lower(s.slug) = lower(btrim(coalesce(p_store_slug, '')))
    and s.status = 'active'
    and r.token = p_token;

  if not found then
    raise exception 'RESERVA_NO_ENCONTRADA: no hay ninguna reserva con esos datos'
      using errcode = '22023';
  end if;

  return ebim.close_reservation(
    v_res.id, 'released'::public.reservation_status, 'abandoned', null, null);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.expire_inventory_reservations — el barrido explicito.
--
-- El motor ya caduca solo al reservar y al pedir (`ebim.expire_due_reservations`),
-- asi que esto no es la unica red: es la que sirve para una tienda que dejo de
-- recibir trafico con reservas vivas, y la que un planificador puede llamar sin
-- saber nada del dominio.
-- ---------------------------------------------------------------------------
create or replace function public.expire_inventory_reservations()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return ebim.expire_due_reservations(null);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.adjust_inventory — entradas, correcciones y devoluciones.
--
-- `p_quantity` es un DELTA CON SIGNO. La salida por venta NO entra aqui: la
-- hace el pedido, y permitir «issue» a mano seria la puerta por la que se
-- descuadra un almacen sin que exista el documento que lo explique.
-- ---------------------------------------------------------------------------
create or replace function public.adjust_inventory(
  p_warehouse_id uuid,
  p_product_id   uuid,
  p_variant_id   uuid default null,
  p_quantity     numeric default 0,
  p_kind         text default 'adjustment',
  p_reason       text default null,
  p_external_ref text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_warehouse public.warehouses%rowtype;
  v_level_id  uuid;
  v_kind      public.movement_kind;
begin
  select * into v_warehouse from public.warehouses w where w.id = p_warehouse_id;
  if not found then
    raise exception 'ALMACEN_NO_ENCONTRADO: %', p_warehouse_id using errcode = '22023';
  end if;

  perform ebim.assert_inventory_role(
    v_warehouse.organization_id, v_warehouse.company_id,
    array['owner','admin','catalog']::public.app_role[]);

  if p_kind not in ('receipt', 'adjustment', 'return', 'transfer_in', 'transfer_out') then
    raise exception 'MOVIMIENTO_NO_PERMITIDO: la salida por venta la hace el pedido, no un ajuste'
      using errcode = '22023';
  end if;
  v_kind := p_kind::public.movement_kind;

  if p_quantity is null or p_quantity = 0 then
    raise exception 'CANTIDAD_INVALIDA: un movimiento de cero no es un movimiento'
      using errcode = '22023';
  end if;

  -- El signo tiene que decir lo mismo que el motivo: una «entrada» de -5 es un
  -- asiento que nadie sabra leer dentro de seis meses.
  if p_kind in ('receipt', 'return', 'transfer_in') and p_quantity < 0 then
    raise exception 'SIGNO_INCOHERENTE: una entrada no puede ser negativa'
      using errcode = '22023';
  end if;
  if p_kind = 'transfer_out' and p_quantity > 0 then
    raise exception 'SIGNO_INCOHERENTE: una salida por traslado tiene que ser negativa'
      using errcode = '22023';
  end if;

  v_level_id := ebim.ensure_level(p_warehouse_id, p_product_id, p_variant_id);

  return ebim.apply_movement(
    v_level_id, v_kind, p_quantity, p_reason, 'manual', null,
    p_external_ref, ebim.user_id(), 'local'::public.inventory_source);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.set_inventory_policy — colchon y umbral de aviso.
--
-- Existe porque `inventory_levels` no tiene GRANT de UPDATE para nadie: si lo
-- tuviera para estas dos columnas, lo tendria para `on_hand_qty`, y la
-- existencia se podria cambiar sin dejar asiento. Postgres no concede UPDATE
-- por columna de forma compatible con RLS de una manera que aguante columnas
-- nuevas, asi que la puerta estrecha es una funcion.
-- ---------------------------------------------------------------------------
create or replace function public.set_inventory_policy(
  p_warehouse_id  uuid,
  p_product_id    uuid,
  p_variant_id    uuid default null,
  p_safety_stock  numeric default 0,
  p_reorder_point numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_warehouse public.warehouses%rowtype;
  v_level_id  uuid;
begin
  select * into v_warehouse from public.warehouses w where w.id = p_warehouse_id;
  if not found then
    raise exception 'ALMACEN_NO_ENCONTRADO: %', p_warehouse_id using errcode = '22023';
  end if;

  perform ebim.assert_inventory_role(
    v_warehouse.organization_id, v_warehouse.company_id,
    array['owner','admin','catalog']::public.app_role[]);

  if coalesce(p_safety_stock, 0) < 0 or coalesce(p_reorder_point, 0) < 0 then
    raise exception 'CANTIDAD_INVALIDA: el colchon y el umbral no pueden ser negativos'
      using errcode = '22023';
  end if;

  v_level_id := ebim.ensure_level(p_warehouse_id, p_product_id, p_variant_id);

  update public.inventory_levels
     set safety_stock  = coalesce(p_safety_stock, 0),
         reorder_point = coalesce(p_reorder_point, 0)
   where id = v_level_id;

  return jsonb_build_object('level_id', v_level_id);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.sync_inventory_level — la entrada del ERP.
--
-- `p_on_hand` es la existencia ABSOLUTA que dice el sistema externo, no un
-- delta: un ERP no manda diferencias, manda saldos. La diferencia se calcula
-- aqui y se anota como `count`, que es lo que es —un recuento de fuera— y no
-- un ajuste manual.
--
-- Idempotente por `p_external_ref` a traves de `ebim.apply_movement`: el mismo
-- evento reenviado no vuelve a mover nada.
--
-- `service_role` y solo `service_role`: el navegador no habla con el ERP.
-- ---------------------------------------------------------------------------
create or replace function public.sync_inventory_level(
  p_warehouse_id uuid,
  p_product_id   uuid,
  p_variant_id   uuid default null,
  p_on_hand      numeric default 0,
  p_external_ref text default null,
  p_reason       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_level_id uuid;
  v_current  numeric;
  v_delta    numeric;
begin
  if p_on_hand is null or p_on_hand < 0 then
    raise exception 'CANTIDAD_INVALIDA: el saldo sincronizado no puede ser nulo ni negativo'
      using errcode = '22023';
  end if;

  v_level_id := ebim.ensure_level(p_warehouse_id, p_product_id, p_variant_id);

  select on_hand_qty into v_current
  from public.inventory_levels where id = v_level_id for update;

  v_delta := p_on_hand - v_current;

  if v_delta = 0 then
    -- Nada que mover, pero la cifra SI se refresco: `synced_at` es lo que
    -- decide si esta cache vale, y no tocarlo dejaria un almacen «caducado»
    -- justo despues de confirmar que esta al dia.
    update public.inventory_levels
       set synced_at = now(),
           external_ref = coalesce(nullif(btrim(coalesce(p_external_ref, '')), ''), external_ref)
     where id = v_level_id;
    return jsonb_build_object('level_id', v_level_id, 'on_hand_after', p_on_hand, 'applied', false);
  end if;

  return ebim.apply_movement(
    v_level_id, 'count'::public.movement_kind, v_delta,
    coalesce(p_reason, 'sincronizacion del sistema de gestion'),
    'erp', null, p_external_ref, null, 'erp'::public.inventory_source);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.seed_inventory_from_catalog — LA transicion (regla 10).
--
-- Copia `products.stock` y `product_variants.stock` de una tienda al almacen
-- indicado, como asiento de recuento inicial. Es lo que convierte un tenant que
-- vendia con la columna de siempre en un tenant con almacenes sin que en ningun
-- momento su tienda diga «agotado».
--
-- **No borra la columna de origen** y **no se puede ejecutar dos veces sobre la
-- misma existencia**: el asiento lleva `external_ref` derivado de la tienda y
-- del almacen, asi que la segunda llamada es idempotente y no duplica saldo.
-- ---------------------------------------------------------------------------
create or replace function public.seed_inventory_from_catalog(
  p_warehouse_id uuid,
  p_store_id     uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_warehouse public.warehouses%rowtype;
  v_store     public.stores%rowtype;
  v_row       record;
  v_level     uuid;
  v_seeded    integer := 0;
begin
  select * into v_warehouse from public.warehouses w where w.id = p_warehouse_id;
  if not found then
    raise exception 'ALMACEN_NO_ENCONTRADO: %', p_warehouse_id using errcode = '22023';
  end if;

  perform ebim.assert_inventory_role(
    v_warehouse.organization_id, v_warehouse.company_id,
    array['owner','admin']::public.app_role[]);

  select * into v_store from public.stores s where s.id = p_store_id;
  if not found
     or v_store.organization_id <> v_warehouse.organization_id
     or v_store.company_id <> v_warehouse.company_id then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda no es de la sociedad del almacen'
      using errcode = '22023';
  end if;

  for v_row in
    select p.id as product_id, null::uuid as variant_id, p.stock::numeric as qty
    from public.products p
    where p.store_id = v_store.id and p.kind = 'simple' and p.stock > 0
    union all
    select pv.product_id, pv.id, pv.stock::numeric
    from public.product_variants pv
    where pv.store_id = v_store.id and pv.stock > 0
  loop
    v_level := ebim.ensure_level(p_warehouse_id, v_row.product_id, v_row.variant_id);

    perform ebim.apply_movement(
      v_level, 'count'::public.movement_kind, v_row.qty,
      'existencia inicial migrada del catalogo',
      'import', null,
      'seed:' || p_warehouse_id::text || ':' || coalesce(v_row.variant_id, v_row.product_id)::text,
      ebim.user_id(), 'local'::public.inventory_source);

    v_seeded := v_seeded + 1;
  end loop;

  return jsonb_build_object('warehouse_id', p_warehouse_id, 'store_id', p_store_id, 'seeded', v_seeded);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.inventory_availability — la foto, para el backoffice.
--
-- `p_items`: `[{ product_id, variant_id?, quantity? }]`. Devuelve la cifra
-- exacta porque quien pregunta es un miembro de la sociedad. La vitrina tiene
-- su propia puerta (migracion 200300) y ahi la cifra NO sale.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_availability(
  p_store_id uuid,
  p_items    jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_item  jsonb;
  v_atp   jsonb;
  v_qty   numeric;
  v_out   jsonb := '[]'::jsonb;
begin
  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: %', p_store_id using errcode = '22023';
  end if;

  if not ebim.can_access(v_store.organization_id, v_store.company_id) then
    raise exception 'SIN_PERMISO: esa tienda no es de tu sociedad' using errcode = '42501';
  end if;

  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'ITEMS_REQUERIDOS: hace falta una lista de referencias'
      using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item ->> 'quantity')::numeric, 1);
    v_atp := ebim.atp(
      v_store.id,
      ebim.safe_uuid(v_item ->> 'product_id'),
      ebim.safe_uuid(v_item ->> 'variant_id'));

    v_out := v_out || jsonb_build_object(
      'product_id', v_item ->> 'product_id',
      'variant_id', v_item ->> 'variant_id',
      'quantity',   v_qty,
      -- `unknown` gana sobre la cifra: quien no sabe no promete.
      'available',  case when (v_atp ->> 'unknown')::boolean then null
                         else (v_atp ->> 'available')::numeric end,
      'unknown',    (v_atp ->> 'unknown')::boolean,
      'backorder',  (v_atp ->> 'backorder')::boolean,
      'source',     v_atp ->> 'source',
      'in_stock',   coalesce((v_atp ->> 'backorder')::boolean, false)
                    or coalesce((v_atp ->> 'available')::numeric, 0) >= v_qty);
  end loop;

  return v_out;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.inventory_alerts — «que tengo que mirar hoy».
--
-- Vista `security_invoker`: no amplia ni un permiso, la RLS de las tablas de
-- abajo decide que filas ve quien pregunta.
--
-- Cuatro avisos, y el cuarto es el que importa durante la transicion:
--   · `below_reorder` — por debajo del umbral que el propio tenant puso.
--   · `negative`      — saldo bajo cero. Solo puede pasar con backorder activo.
--   · `stale`         — la cache del ERP caduco. No dice cuanto hay: dice que
--                       no se sabe.
--   · `unmapped`      — hay almacenes, el producto esta publicado y NO tiene ni
--                       una fila de existencia. Es exactamente el estado en el
--                       que una tienda recien migrada dejaria de vender sin que
--                       nadie entendiera por que.
-- ---------------------------------------------------------------------------
create view public.inventory_alerts
with (security_invoker = on) as
  select l.organization_id, l.company_id, l.store_id, l.warehouse_id,
         w.code as warehouse_code, w.name as warehouse_name,
         l.product_id, l.variant_id,
         coalesce(pv.sku, p.sku)   as sku,
         coalesce(pv.name, p.name) as name,
         'below_reorder'::text     as kind,
         l.available_qty, l.reorder_point, l.synced_at
  from public.inventory_levels l
  join public.warehouses w on w.id = l.warehouse_id
  join public.products   p on p.id = l.product_id
  left join public.product_variants pv on pv.id = l.variant_id
  where l.reorder_point > 0 and l.available_qty <= l.reorder_point and l.available_qty >= 0

  union all

  select l.organization_id, l.company_id, l.store_id, l.warehouse_id,
         w.code, w.name, l.product_id, l.variant_id,
         coalesce(pv.sku, p.sku), coalesce(pv.name, p.name),
         'negative', l.available_qty, l.reorder_point, l.synced_at
  from public.inventory_levels l
  join public.warehouses w on w.id = l.warehouse_id
  join public.products   p on p.id = l.product_id
  left join public.product_variants pv on pv.id = l.variant_id
  where l.available_qty < 0

  union all

  select l.organization_id, l.company_id, l.store_id, l.warehouse_id,
         w.code, w.name, l.product_id, l.variant_id,
         coalesce(pv.sku, p.sku), coalesce(pv.name, p.name),
         'stale', l.available_qty, l.reorder_point, l.synced_at
  from public.inventory_levels l
  join public.warehouses w on w.id = l.warehouse_id
  join public.products   p on p.id = l.product_id
  left join public.product_variants pv on pv.id = l.variant_id
  where w.source = 'erp'
    and w.stale_after is not null
    and l.synced_at < now() - w.stale_after

  union all

  select p.organization_id, p.company_id, p.store_id, null::uuid,
         null::text, null::text, p.id, pv.id,
         coalesce(pv.sku, p.sku), coalesce(pv.name, p.name),
         'unmapped', null::numeric, null::numeric, null::timestamptz
  from public.products p
  left join public.product_variants pv on pv.product_id = p.id and pv.is_active
  where p.status = 'published'
    and p.kind <> 'bundle'
    and (p.kind <> 'variant' or pv.id is not null)
    and exists (
      select 1 from public.warehouses w
      where w.organization_id = p.organization_id
        and w.company_id = p.company_id
        and w.is_active
    )
    and not exists (
      select 1 from public.inventory_levels l
      where l.product_id = p.id
        and l.variant_id is not distinct from pv.id
    );

revoke all on public.inventory_alerts from public, anon;
grant select on public.inventory_alerts to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Permisos de las puertas. Cada una a su llamante y a nadie mas.
-- ---------------------------------------------------------------------------
revoke execute on function
  ebim.assert_inventory_role(uuid, uuid, public.app_role[]),
  ebim.ensure_level(uuid, uuid, uuid)
from public, anon, authenticated;

revoke execute on function
  public.reserve_inventory(uuid, text, jsonb, integer, text),
  public.release_inventory_reservation(uuid, text),
  public.commit_inventory_reservation(uuid, text),
  public.adjust_inventory(uuid, uuid, uuid, numeric, text, text, text),
  public.set_inventory_policy(uuid, uuid, uuid, numeric, numeric),
  public.seed_inventory_from_catalog(uuid, uuid),
  public.inventory_availability(uuid, jsonb)
from public, anon;

grant execute on function
  public.reserve_inventory(uuid, text, jsonb, integer, text),
  public.release_inventory_reservation(uuid, text),
  public.commit_inventory_reservation(uuid, text),
  public.adjust_inventory(uuid, uuid, uuid, numeric, text, text, text),
  public.set_inventory_policy(uuid, uuid, uuid, numeric, numeric),
  public.seed_inventory_from_catalog(uuid, uuid),
  public.inventory_availability(uuid, jsonb)
to authenticated, service_role;

-- Solo el servidor: el navegador no resuelve tiendas por slug para escribir, no
-- habla con el ERP y no barre reservas ajenas.
revoke execute on function
  public.reserve_inventory_for_slug(text, text, jsonb, integer),
  public.release_inventory_by_token(text, text),
  public.expire_inventory_reservations(),
  public.sync_inventory_level(uuid, uuid, uuid, numeric, text, text)
from public, anon, authenticated;

grant execute on function
  public.reserve_inventory_for_slug(text, text, jsonb, integer),
  public.release_inventory_by_token(text, text),
  public.expire_inventory_reservations(),
  public.sync_inventory_level(uuid, uuid, uuid, numeric, text, text)
to service_role;

comment on function public.reserve_inventory(uuid, text, jsonb, integer, text) is
  'Aparta unidades desde el backoffice. Rol + capacidad, tenant derivado de la tienda. Idempotente por reference_key.';
comment on function public.reserve_inventory_for_slug(text, text, jsonb, integer) is
  'Reserva del carrito anonimo. Solo service_role; la tienda la resuelve el servidor por slug, nunca el navegador.';
comment on function public.release_inventory_by_token(text, text) is
  'Suelta la reserva de un comprador sin sesion contra su secreto de 256 bits. No distingue "no existe" de "token incorrecto".';
comment on function public.sync_inventory_level(uuid, uuid, uuid, numeric, text, text) is
  'Entrada del ERP: saldo ABSOLUTO, delta calculado aqui, idempotente por external_ref. Solo service_role.';
comment on function public.seed_inventory_from_catalog(uuid, uuid) is
  'Transicion desde products.stock: copia la existencia del catalogo al almacen como recuento inicial. Idempotente.';
comment on view public.inventory_alerts is
  'Avisos de existencia: bajo umbral, negativo, cache caducada y publicado sin existencia registrada.';
