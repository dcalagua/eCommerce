-- =============================================================================
-- P06-SaaS · El pedido deja de descontar una columna y pasa a consumir ATP
--
-- `create_order` llevaba desde P02 el descuento de existencia escrito dentro:
-- `select stock ... for update`, comparacion, `update ... set stock = stock - n`,
-- y una copia entera de esa secuencia para el kit. Esa logica se va a
-- `ebim.consume_stock` (200100) y aqui queda lo que solo el pedido puede hacer:
-- validar la linea, pedir el precio, numerar y escribir.
--
-- ## Lo que NO cambia — y es lo que hace que esta fase no rompa nada
--
-- Una tienda **sin almacenes que la sirvan** recorre el mismo camino de
-- siempre: `products.stock` / `product_variants.stock`, las mismas
-- comparaciones, el mismo texto de error. Ni uno solo de los tests de pedido de
-- P02, P03 y P04 cambia una linea, y eso es la prueba de que la transicion de
-- la regla 10 esta hecha por debajo y no por encima.
--
-- ## Lo que si cambia
--
-- 1. **El pedido puede llegar con una reserva.** `p_reservation_token` es el
--    secreto de 256 bits que devolvio `reserve_inventory_for_slug`. Si viene, se
--    valida contra ESTA tienda, se devuelven sus unidades al fondo comun
--    —dentro de esta misma transaccion, con las filas ya bloqueadas, asi que
--    nadie mas puede tomarlas entre medias— y el pedido las consume. Al final,
--    la reserva queda `committed` apuntando al pedido.
--
--    Se eligio devolver-y-consumir en vez de casar linea a linea porque el
--    carrito pudo cambiar entre reservar y pagar: casando, media diferencia
--    dejaria unidades comprometidas sin dueño; devolviendo, el pedido toma lo
--    que necesita y lo que sobre vuelve a estar a la venta al instante.
--
-- 2. **El identificador del pedido se genera ANTES de insertarlo.** No es un
--    detalle: es lo que permite que cada asiento del libro mayor nazca ya
--    apuntando al pedido que lo causo, en vez de escribirse huerfano y
--    corregirse despues — que sobre un libro mayor inmutable no se podria.
--
-- 3. **La lista negra crece.** Un comprador que pudiera declarar `warehouse_id`
--    elegiria de que almacen sale su pedido; uno que pudiera declarar
--    `reservation_id` o `level_id` estaria nombrando filas internas. El reparto
--    lo decide el servidor, como el precio y el canal.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Se DEJA CAER la firma de siete argumentos y se crea la de ocho.
--
-- `create or replace` con otra lista de argumentos crearia una SOBRECARGA, y
-- PostgREST no sabria cual de las dos llamar: la resolucion por nombre de
-- parametro seria ambigua para toda peticion que no nombrara el octavo. Una
-- sola funcion, con el nuevo argumento por defecto, deja a todos los llamantes
-- actuales —incluida `create_order_for_slug`— funcionando sin tocarlos.
-- ---------------------------------------------------------------------------
drop function if exists public.create_order(uuid, text, jsonb, text, text, jsonb, text);

create function public.create_order(
  p_store_id           uuid,
  p_customer_email     text,
  p_items              jsonb,
  p_customer_name      text default null,
  p_customer_phone     text default null,
  p_shipping_address   jsonb default '{}'::jsonb,
  p_notes              text default null,
  p_reservation_token  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store       public.stores%rowtype;
  v_channel     public.channels%rowtype;
  v_scoped      boolean := false;
  v_inclusive   boolean := false;
  v_order_id    uuid := gen_random_uuid();
  v_seq         bigint;
  v_number      text;
  v_token       text;
  v_subtotal    numeric(14,2) := 0;
  v_tax         numeric(14,2) := 0;
  v_item        jsonb;
  v_product     public.products%rowtype;
  v_variant     public.product_variants%rowtype;
  v_has_variant boolean;
  v_uom_code    text;
  v_uom_id      uuid;
  v_factor      numeric(18,6);
  v_priced      jsonb;
  v_unit_price  numeric(14,2);
  v_base_qty    numeric(18,6);
  v_qty         integer;
  v_rate        numeric(6,4);
  v_amount      numeric(14,2);
  v_reservation public.inventory_reservations%rowtype;
  v_res_id      uuid := null;
  v_res_item    record;
  v_email       text := lower(btrim(coalesce(p_customer_email, '')));
  v_lines       jsonb := '[]'::jsonb;
  v_normalized  jsonb;
begin
  if v_email = '' or position('@' in v_email) < 2 then
    raise exception 'EMAIL_REQUERIDO: el pedido necesita un correo de contacto valido'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ITEMS_REQUERIDOS: el pedido necesita al menos una linea'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > 100 then
    raise exception 'ITEMS_EXCESIVOS: maximo 100 lineas por pedido'
      using errcode = '22023';
  end if;

  -- La lista negra crece con las llaves del inventario. Elegir almacen es
  -- elegir de donde sale la mercancia; nombrar una reserva o un nivel es
  -- nombrar filas internas. Las tres las decide el servidor.
  if exists (
    select 1
    from jsonb_array_elements(p_items) as item,
         jsonb_object_keys(item) as k
    where k in ('price', 'unit_price', 'line_total', 'subtotal', 'total',
                'currency', 'organization_id', 'company_id', 'store_id',
                'order_id', 'tenant_id', 'tax_rate', 'tax_total',
                'tax_category_id', 'channel_id',
                'uom_id', 'uom_factor', 'factor', 'base_quantity', 'sku',
                'segment_id', 'customer_id', 'price_list_id', 'price_source',
                'warehouse_id', 'reservation_id', 'level_id', 'stock', 'available')
  ) then
    raise exception 'CAMPO_NO_PERMITIDO: el precio, el canal, la lista, el factor, el almacen y el tenant los decide el servidor, no el payload'
      using errcode = '22023';
  end if;

  select * into v_store
  from public.stores s
  where s.id = p_store_id and s.status = 'active'
  for update;

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda % no existe o no esta activa', p_store_id
      using errcode = '22023';
  end if;

  perform ebim.assert_checkout_allowed(v_store.id, v_email);

  -- Antes de mirar existencia: soltar lo que caduco. Sin esto, un carrito
  -- abandonado hace media hora seguiria impidiendo vender.
  perform ebim.expire_due_reservations(v_store.id);

  -- ---- La reserva del comprador, si la trae -------------------------------
  if p_reservation_token is not null and btrim(p_reservation_token) <> '' then
    select * into v_reservation
    from public.inventory_reservations r
    where r.store_id = v_store.id and r.token = p_reservation_token
    for update;

    if not found then
      raise exception 'RESERVA_NO_ENCONTRADA: no hay ninguna reserva con esos datos'
        using errcode = '22023';
    end if;

    if v_reservation.status <> 'held' then
      raise exception 'RESERVA_NO_VIGENTE: esa reserva ya se uso o caduco'
        using errcode = '22023';
    end if;

    -- Devolver al fondo comun DENTRO de esta transaccion. Las filas de
    -- existencia quedan bloqueadas hasta el commit, asi que nadie puede colarse
    -- entre la devolucion y el consumo de mas abajo.
    for v_res_item in
      select i.level_id, i.quantity
      from public.inventory_reservation_items i
      where i.reservation_id = v_reservation.id
    loop
      perform ebim.give_back_units(v_res_item.level_id, v_res_item.quantity, 'reserve');
    end loop;

    v_res_id := v_reservation.id;
  end if;

  select * into v_channel
  from public.channels c
  where c.store_id = v_store.id
    and c.is_default
    and c.is_active;

  if not found then
    raise exception 'CANAL_NO_DISPONIBLE: la tienda % no tiene canal por defecto activo', v_store.slug
      using errcode = '22023';
  end if;

  if v_channel.requires_auth then
    raise exception 'CANAL_NO_PUBLICO: el canal por defecto de % exige sesion', v_store.slug
      using errcode = '22023';
  end if;

  select exists (
    select 1 from public.product_channels pc where pc.channel_id = v_channel.id
  ) into v_scoped;

  select coalesce(ss.tax_inclusive, false) into v_inclusive
  from public.store_settings ss where ss.store_id = v_store.id;
  v_inclusive := coalesce(v_inclusive, false);

  select coalesce(
           jsonb_agg(jsonb_build_object(
             'product_id', product_id,
             'variant_id', variant_id,
             'uom_code',   uom_code,
             'quantity',   quantity
           )),
           '[]'::jsonb)
    into v_normalized
  from (
    select (item ->> 'product_id')                    as product_id,
           nullif(btrim(coalesce(item ->> 'variant_id', '')), '') as variant_id,
           nullif(upper(btrim(coalesce(item ->> 'uom_code', ''))), '') as uom_code,
           sum((item ->> 'quantity')::numeric)::integer as quantity
    from jsonb_array_elements(p_items) as item
    group by 1, 2, 3
  ) grouped;

  for v_item in select * from jsonb_array_elements(v_normalized)
  loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'CANTIDAD_INVALIDA: la cantidad debe ser un entero mayor que cero'
        using errcode = '22023';
    end if;

    select * into v_product
    from public.products p
    where p.id = ebim.safe_uuid(v_item ->> 'product_id')
      and p.store_id = v_store.id
      and p.status = 'published'
      and p.published_at is not null
      and p.published_at <= now()
    for update;

    if not found then
      raise exception 'PRODUCTO_NO_DISPONIBLE: %', coalesce(v_item ->> 'product_id', 'null')
        using errcode = '22023';
    end if;

    if v_scoped and not exists (
      select 1 from public.product_channels pc
      where pc.channel_id = v_channel.id and pc.product_id = v_product.id
    ) then
      raise exception 'PRODUCTO_FUERA_DE_CANAL: % no esta a la venta en el canal %',
        v_product.sku, v_channel.code
        using errcode = '22023';
    end if;

    if v_product.currency <> v_store.currency then
      raise exception 'MONEDA_INCONSISTENTE: % esta en % y la tienda en %',
        v_product.sku, v_product.currency, v_store.currency
        using errcode = '22023';
    end if;

    -- ---- Variante ---------------------------------------------------------
    v_has_variant := (v_item ->> 'variant_id') is not null;

    if v_product.kind = 'variant' and not v_has_variant then
      raise exception 'VARIANTE_REQUERIDA: % se vende por variante y el pedido no dice cual', v_product.sku
        using errcode = '22023';
    end if;

    if v_product.kind <> 'variant' and v_has_variant then
      raise exception 'VARIANTE_NO_APLICA: % no tiene variantes', v_product.sku
        using errcode = '22023';
    end if;

    if v_has_variant then
      select * into v_variant
      from public.product_variants pv
      where pv.id = ebim.safe_uuid(v_item ->> 'variant_id')
        and pv.product_id = v_product.id
        and pv.is_active
      for update;

      if not found then
        raise exception 'VARIANTE_NO_DISPONIBLE: %', coalesce(v_item ->> 'variant_id', 'null')
          using errcode = '22023';
      end if;
    else
      v_variant := null;
    end if;

    -- ---- Unidad de venta --------------------------------------------------
    v_uom_code := v_item ->> 'uom_code';

    if v_uom_code is null then
      v_uom_id := null;
      v_factor := 1;
    else
      select pu.uom_id, pu.factor into v_uom_id, v_factor
      from public.product_uoms pu
      join public.units_of_measure u
        on u.id = pu.uom_id
       and u.organization_id = pu.organization_id
       and u.company_id      = pu.company_id
      where pu.product_id = v_product.id
        and upper(u.code) = v_uom_code
        and pu.is_sellable
        and u.is_active;

      if v_factor is null then
        raise exception 'UOM_NO_DISPONIBLE: % no se vende en la unidad %', v_product.sku, v_uom_code
          using errcode = '22023';
      end if;
    end if;

    -- ---- Precio: UNA sola autoridad ---------------------------------------
    v_priced := ebim.resolve_price(
      v_store.id,
      v_channel.id,
      v_product.id,
      case when v_has_variant then v_variant.id else null end,
      v_uom_id,
      v_qty,
      v_store.currency,
      now(),
      null,
      null
    );

    if v_priced is null or v_priced ->> 'unit_price' is null then
      raise exception 'PRECIO_NO_RESUELTO: % no tiene un precio aplicable', v_product.sku
        using errcode = '22023';
    end if;

    v_unit_price := (v_priced ->> 'unit_price')::numeric;

    v_base_qty := v_qty * v_factor;
    if v_base_qty <> trunc(v_base_qty) then
      raise exception 'CANTIDAD_INVALIDA: % x % no da un numero entero de unidades base',
        v_qty, v_factor
        using errcode = '22023';
    end if;

    -- ---- Existencia: una sola llamada, dos caminos por debajo --------------
    -- Con almacenes que sirvan a la tienda, reparte y deja asiento; sin ellos,
    -- descuenta `products.stock` exactamente como antes de esta fase.
    perform ebim.consume_stock(
      v_store.id,
      v_product.id,
      case when v_has_variant then v_variant.id else null end,
      v_base_qty,
      'order',
      v_order_id,
      null
    );

    v_rate := coalesce(
      ebim.effective_tax_rate(v_store.id, v_product.tax_category_id, now()),
      0
    );

    v_amount := round(v_unit_price * v_qty, 2);

    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product.id,
      'variant_id', case when v_has_variant then v_variant.id else null end,
      'sku',        case when v_has_variant then v_variant.sku else v_product.sku end,
      'name',       case when v_has_variant
                         then v_product.name || ' · ' || v_variant.name
                         else v_product.name end,
      'unit_price', v_unit_price::text,
      'quantity',   v_qty,
      'uom_code',   v_uom_code,
      'uom_factor', v_factor::text,
      'amount',     v_amount::text,
      'tax_rate',   v_rate::text,
      'price_source',  v_priced ->> 'source',
      'price_list_id', v_priced ->> 'price_list_id',
      'price_list_code', v_priced ->> 'price_list_code'
    );
  end loop;

  if v_inclusive then
    select coalesce(sum(g.gross - round(g.gross - g.gross / (1 + g.rate), 2)), 0),
           coalesce(sum(round(g.gross - g.gross / (1 + g.rate), 2)), 0)
      into v_subtotal, v_tax
    from (
      select (line ->> 'tax_rate')::numeric as rate,
             sum((line ->> 'amount')::numeric) as gross
      from jsonb_array_elements(v_lines) as line
      group by 1
    ) g;
  else
    select coalesce(sum(g.net), 0),
           coalesce(sum(round(g.net * g.rate, 2)), 0)
      into v_subtotal, v_tax
    from (
      select (line ->> 'tax_rate')::numeric as rate,
             sum((line ->> 'amount')::numeric) as net
      from jsonb_array_elements(v_lines) as line
      group by 1
    ) g;
  end if;

  update public.stores
     set order_seq = order_seq + 1
   where id = v_store.id
  returning order_seq into v_seq;

  v_number := 'EC-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(v_seq::text, 5, '0');

  insert into public.orders (
    id, organization_id, company_id, store_id, channel_id, order_number, status,
    customer_email, customer_name, customer_phone, currency,
    subtotal, tax_total, shipping_total, discount_total, grand_total,
    shipping_address, notes
  ) values (
    v_order_id, v_store.organization_id, v_store.company_id, v_store.id, v_channel.id,
    v_number, 'pending',
    v_email, nullif(btrim(coalesce(p_customer_name, '')), ''),
    nullif(btrim(coalesce(p_customer_phone, '')), ''), v_store.currency,
    v_subtotal, v_tax, 0, 0, v_subtotal + v_tax,
    coalesce(p_shipping_address, '{}'::jsonb), nullif(btrim(coalesce(p_notes, '')), '')
  );

  insert into public.order_tokens (order_id, organization_id, company_id)
  values (v_order_id, v_store.organization_id, v_store.company_id)
  returning token into v_token;

  insert into public.order_items (
    organization_id, company_id, store_id, order_id,
    product_id, variant_id, sku, name, unit_price, quantity, uom_code, uom_factor,
    price_source, price_list_id
  )
  select
    v_store.organization_id, v_store.company_id, v_store.id, v_order_id,
    (line ->> 'product_id')::uuid,
    ebim.safe_uuid(line ->> 'variant_id'),
    line ->> 'sku', line ->> 'name',
    (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
    line ->> 'uom_code', (line ->> 'uom_factor')::numeric,
    coalesce(line ->> 'price_source', 'catalog'),
    ebim.safe_uuid(line ->> 'price_list_id')
  from jsonb_array_elements(v_lines) as line;

  -- La reserva acabo en este pedido. Sus unidades ya salieron por los asientos
  -- de arriba; lo que queda es dejar dicho donde acabo.
  if v_res_id is not null then
    update public.inventory_reservations
       set status = 'committed', committed_at = now(), order_id = v_order_id
     where id = v_res_id;
  end if;

  return jsonb_build_object(
    'order_id',      v_order_id,
    'order_number',  v_number,
    'access_token',  v_token,
    'status',        'pending',
    'currency',      v_store.currency,
    'channel',       v_channel.code,
    'subtotal',      v_subtotal::text,
    'tax_total',     v_tax::text,
    'grand_total',   (v_subtotal + v_tax)::text,
    'tax_inclusive', v_inclusive,
    'items',         v_lines
  );
end;
$fn$;

revoke execute on function
  public.create_order(uuid, text, jsonb, text, text, jsonb, text, text)
from public, anon, authenticated;

grant execute on function
  public.create_order(uuid, text, jsonb, text, text, jsonb, text, text)
to service_role;

comment on function public.create_order(uuid, text, jsonb, text, text, jsonb, text, text) is
  'Crea el pedido pidiendo el precio a ebim.resolve_price y la existencia a ebim.consume_stock. Ni precio, ni canal, ni lista, ni factor, ni almacen, ni tenant se aceptan del payload.';

-- ---------------------------------------------------------------------------
-- create_order_for_slug — misma razon: se deja caer y se recrea con el octavo
-- argumento. Sigue delegando y sigue sin duplicar ni una linea de logica.
-- ---------------------------------------------------------------------------
drop function if exists public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text);

create function public.create_order_for_slug(
  p_store_slug        text,
  p_customer_email    text,
  p_items             jsonb,
  p_customer_name     text default null,
  p_customer_phone    text default null,
  p_shipping_address  jsonb default '{}'::jsonb,
  p_notes             text default null,
  p_reservation_token text default null
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
    raise exception 'TIENDA_NO_DISPONIBLE: falta la tienda del pedido'
      using errcode = '22023';
  end if;

  select s.id into v_store_id
  from public.stores s
  where lower(s.slug) = v_slug
    and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  return public.create_order(
    v_store_id,
    p_customer_email,
    p_items,
    p_customer_name,
    p_customer_phone,
    p_shipping_address,
    p_notes,
    p_reservation_token
  );
end;
$fn$;

revoke execute on function
  public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text, text)
from public, anon, authenticated;

grant execute on function
  public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text, text)
to service_role;

comment on function public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text, text) is
  'Checkout publico: resuelve la tienda por slug (solo activa) y delega en create_order, arrastrando la reserva si la hay. Solo service_role.';

-- ---------------------------------------------------------------------------
-- `products.stock` y `product_variants.stock` NO se retiran, y cambian de
-- significado. Se deja escrito donde se lee: en el comentario de la columna.
-- ---------------------------------------------------------------------------
comment on column public.products.stock is
  'Existencia unica del catalogo. Desde P06 es el camino de FALLBACK: manda solo mientras ninguna tienda de la sociedad tenga almacenes que la sirvan. Con almacenes, la verdad es inventory_levels.';
comment on column public.product_variants.stock is
  'Existencia unica de la variante. Desde P06 es el camino de FALLBACK: con almacenes, la verdad es inventory_levels.';

-- ---------------------------------------------------------------------------
-- La capacidad deja de ser una promesa.
--
-- `inventory.multiwarehouse` estaba `declared` desde P02-SaaS: se podia
-- contratar y gatear y no habia nada detras. Ahora tiene esquema, motor,
-- reservas, pantalla y pedido. El `state` dice la verdad sobre el producto HOY,
-- y un test de paridad lo compara contra `src/domain/capabilities.ts`.
-- ---------------------------------------------------------------------------
update public.app_capabilities
   set state = 'implemented'
 where code = 'inventory.multiwarehouse';
