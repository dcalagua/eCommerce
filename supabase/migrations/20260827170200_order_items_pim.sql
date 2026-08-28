-- =============================================================================
-- P03-SaaS · El pedido aprende a comprar variantes, unidades y kits
--
-- Sin esto, el PIM seria un catalogo que no se puede vender: `create_order`
-- resolvia precio y existencia contra `products` y solo contra `products`. Con
-- variantes eso es directamente incorrecto —venderia el maestro y descontaria
-- una existencia que nadie lleva—, asi que la funcion se rehace.
--
-- Tres reglas nuevas, y ninguna afloja las que ya habia:
--
--  1. **El maestro de variantes NO se vende.** Un pedido sobre un producto
--     `kind = 'variant'` sin `variant_id` se rechaza. Lo contrario habria sido
--     "elegir la primera variante", que es como se despacha la talla que no era.
--  2. **La unidad de venta la valida el servidor.** El carrito puede pedir
--     "2 CAJA"; que exista esa UoM para ese producto, que sea vendible y cuanto
--     entrega lo dice `product_uoms`, no el payload. El precio de la caja sale
--     de `product_uoms.price` o del precio base por el factor.
--  3. **Un kit descuenta sus componentes.** Nunca su propia existencia: un kit
--     no tiene almacen, tiene receta.
--
-- Lo que sigue igual: el precio, el impuesto, el canal y el tenant los decide
-- la base; el payload solo dice QUE y CUANTO. La lista negra de campos crece
-- con los del PIM, para que nadie mande un factor de conversion propio.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- order_items — el snapshot crece; nada existente cambia de significado.
--
-- `quantity` sigue siendo entero y sigue midiendo unidades de la UNIDAD DE
-- VENTA elegida. `base_quantity` es la conversion exacta a unidades base y es
-- GENERATED: no se puede mandar una conversion inventada, igual que no se puede
-- mandar un total de linea. Se guarda `uom_code` como texto y no el uuid a
-- proposito — es snapshot: si manana el tenant renombra o borra la unidad, el
-- pedido tiene que seguir diciendo que se vendieron 2 CAJA.
-- ---------------------------------------------------------------------------
alter table public.order_items
  add column variant_id    uuid,
  add column uom_code      text,
  add column uom_factor    numeric(18,6) not null default 1,
  add column base_quantity numeric(18,6) generated always as (quantity * uom_factor) stored;

alter table public.order_items
  add constraint order_items_uom_factor_positive check (uom_factor > 0),
  add constraint order_items_uom_code_len
    check (uom_code is null or char_length(btrim(uom_code)) between 1 and 16),
  -- Igual que `order_items_product_fk`: al borrar la variante la linea pierde
  -- el enlace y conserva su snapshot. La lista de columnas es obligatoria
  -- porque `store_id` forma parte de la clave y es NOT NULL.
  add constraint order_items_variant_fk foreign key (variant_id, store_id)
    references public.product_variants (id, store_id) on delete set null (variant_id);

create index order_items_variant_idx on public.order_items (variant_id) where variant_id is not null;

-- `authenticated` ya tiene SELECT a nivel de tabla, que cubre las columnas
-- nuevas. `anon` no tiene ninguno sobre `order_items` y sigue sin tenerlo.

comment on column public.order_items.base_quantity is
  'GENERATED: quantity * uom_factor. Unidades base equivalentes; no se acepta una conversion enviada por el cliente.';
comment on column public.order_items.uom_code is
  'Codigo de la unidad de venta EN EL MOMENTO del pedido. Texto y no uuid: es snapshot, no referencia viva.';

-- ---------------------------------------------------------------------------
-- create_order — misma firma, mismas garantias, tres tipos de producto.
-- ---------------------------------------------------------------------------
create or replace function public.create_order(
  p_store_id         uuid,
  p_customer_email   text,
  p_items            jsonb,
  p_customer_name    text default null,
  p_customer_phone   text default null,
  p_shipping_address jsonb default '{}'::jsonb,
  p_notes            text default null
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
  v_order_id    uuid;
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
  v_factor      numeric(18,6);
  v_uom_price   numeric(14,2);
  v_base_price  numeric(14,2);
  v_unit_price  numeric(14,2);
  v_base_qty    numeric(18,6);
  v_qty         integer;
  v_rate        numeric(6,4);
  v_amount      numeric(14,2);
  v_component   record;
  v_needed      numeric(18,6);
  v_available   integer;
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

  -- `channel_id` entra en la lista negra: el canal lo decide el servidor. Un
  -- comprador anonimo que declarase canal podria intentar comprar por el canal
  -- interno, con sus precios preferenciales. Desde P03 entran tambien el factor
  -- de conversion y la cantidad base: son lo que traduce "2 cajas" a existencia
  -- descontada, asi que aceptarlos del payload seria dejar que el comprador
  -- decida cuanto se le descuenta del almacen.
  if exists (
    select 1
    from jsonb_array_elements(p_items) as item,
         jsonb_object_keys(item) as k
    where k in ('price', 'unit_price', 'line_total', 'subtotal', 'total',
                'currency', 'organization_id', 'company_id', 'store_id',
                'order_id', 'tenant_id', 'tax_rate', 'tax_total',
                'tax_category_id', 'channel_id',
                'uom_id', 'uom_factor', 'factor', 'base_quantity', 'sku')
  ) then
    raise exception 'CAMPO_NO_PERMITIDO: el precio, el canal, el factor y el tenant los decide el servidor, no el payload'
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

  -- Limite de tasa ANTES de tocar stock o el contador de pedidos: un rechazo
  -- tardio ya habria consumido recursos de la tienda.
  perform ebim.assert_checkout_allowed(v_store.id, v_email);

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

  -- La agrupacion es por PRODUCTO + VARIANTE + UNIDAD: "2 camisetas talla M" y
  -- "1 camiseta talla L" son dos lineas distintas, y "1 caja" no se suma con
  -- "1 unidad" aunque sean del mismo producto.
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

    -- Publicado en la tienda no es lo mismo que a la venta en ESTE canal.
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

      v_base_price := coalesce(v_variant.price, v_product.price);
    else
      v_variant := null;
      v_base_price := v_product.price;
    end if;

    -- ---- Unidad de venta --------------------------------------------------
    v_uom_code := v_item ->> 'uom_code';

    if v_uom_code is null then
      -- Sin unidad declarada se vende en la unidad implicita del producto, que
      -- es exactamente como se comportaba el catalogo antes del PIM.
      v_factor    := 1;
      v_uom_price := null;
    else
      select pu.factor, pu.price into v_factor, v_uom_price
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

    -- Precio de la unidad: el propio si lo tiene, y si no el base por el
    -- factor. `product_uoms.price` existe justo para el caso que NO es
    -- proporcional (la caja sale mas barata que doce unidades sueltas).
    v_unit_price := coalesce(v_uom_price, round(v_base_price * v_factor, 2));

    -- Cantidad en unidades base. `stock` es entero, asi que una conversion que
    -- no da un numero entero no se puede descontar sin inventarse un redondeo:
    -- se rechaza en vez de aproximar.
    v_base_qty := v_qty * v_factor;
    if v_base_qty <> trunc(v_base_qty) then
      raise exception 'CANTIDAD_INVALIDA: % x % no da un numero entero de unidades base',
        v_qty, v_factor
        using errcode = '22023';
    end if;

    -- ---- Existencia -------------------------------------------------------
    if v_product.kind = 'bundle' then
      -- Un kit no tiene almacen: tiene receta. Se descuenta componente a
      -- componente, con la fila bloqueada, en la misma transaccion.
      if not exists (select 1 from public.bundle_items bi where bi.bundle_product_id = v_product.id) then
        raise exception 'KIT_SIN_COMPONENTES: % no tiene componentes definidos', v_product.sku
          using errcode = '22023';
      end if;

      for v_component in
        select bi.component_product_id,
               bi.component_variant_id,
               bi.quantity,
               bi.uom_id,
               pu.factor as uom_factor
        from public.bundle_items bi
        left join public.product_uoms pu
          on pu.product_id = bi.component_product_id
         and pu.uom_id     = bi.uom_id
        where bi.bundle_product_id = v_product.id
        order by bi.position, bi.component_product_id
      loop
        if v_component.uom_id is not null and v_component.uom_factor is null then
          raise exception 'KIT_UOM_INVALIDA: un componente de % usa una unidad que no tiene configurada', v_product.sku
            using errcode = '22023';
        end if;

        v_needed := v_component.quantity * coalesce(v_component.uom_factor, 1) * v_base_qty;
        if v_needed <> trunc(v_needed) then
          raise exception 'KIT_CANTIDAD_INVALIDA: % necesita % unidades de un componente y no es un entero',
            v_product.sku, v_needed
            using errcode = '22023';
        end if;

        if v_component.component_variant_id is not null then
          select pv.stock into v_available
          from public.product_variants pv
          where pv.id = v_component.component_variant_id
          for update;
        else
          select p2.stock into v_available
          from public.products p2
          where p2.id = v_component.component_product_id
          for update;
        end if;

        if coalesce(v_available, 0) < v_needed then
          raise exception 'STOCK_INSUFICIENTE: % (componente sin existencia suficiente)', v_product.sku
            using errcode = '22023';
        end if;

        if v_component.component_variant_id is not null then
          update public.product_variants
             set stock = stock - v_needed::integer
           where id = v_component.component_variant_id;
        else
          update public.products
             set stock = stock - v_needed::integer
           where id = v_component.component_product_id;
        end if;
      end loop;

    elsif v_has_variant then
      if v_variant.stock < v_base_qty then
        raise exception 'STOCK_INSUFICIENTE: % (disponible %, pedido %)',
          v_variant.sku, v_variant.stock, v_base_qty
          using errcode = '22023';
      end if;

      update public.product_variants
         set stock = stock - v_base_qty::integer
       where id = v_variant.id;

    else
      if v_product.stock < v_base_qty then
        raise exception 'STOCK_INSUFICIENTE: % (disponible %, pedido %)',
          v_product.sku, v_product.stock, v_base_qty
          using errcode = '22023';
      end if;

      update public.products
         set stock = stock - v_base_qty::integer
       where id = v_product.id;
    end if;

    v_rate := coalesce(
      ebim.effective_tax_rate(v_store.id, v_product.tax_category_id, now()),
      0
    );

    v_amount := round(v_unit_price * v_qty, 2);

    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product.id,
      'variant_id', case when v_has_variant then v_variant.id else null end,
      -- El SKU de la linea es el de lo que se DESPACHA: la variante si la hay.
      'sku',        case when v_has_variant then v_variant.sku else v_product.sku end,
      'name',       case when v_has_variant
                         then v_product.name || ' · ' || v_variant.name
                         else v_product.name end,
      'unit_price', v_unit_price::text,
      'quantity',   v_qty,
      'uom_code',   v_uom_code,
      'uom_factor', v_factor::text,
      'amount',     v_amount::text,
      'tax_rate',   v_rate::text
    );
  end loop;

  -- Redondeo por grupo de tasa, no por linea ni sobre el total.
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
    organization_id, company_id, store_id, channel_id, order_number, status,
    customer_email, customer_name, customer_phone, currency,
    subtotal, tax_total, shipping_total, discount_total, grand_total,
    shipping_address, notes
  ) values (
    v_store.organization_id, v_store.company_id, v_store.id, v_channel.id, v_number, 'pending',
    v_email, nullif(btrim(coalesce(p_customer_name, '')), ''),
    nullif(btrim(coalesce(p_customer_phone, '')), ''), v_store.currency,
    v_subtotal, v_tax, 0, 0, v_subtotal + v_tax,
    coalesce(p_shipping_address, '{}'::jsonb), nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_order_id;

  insert into public.order_tokens (order_id, organization_id, company_id)
  values (v_order_id, v_store.organization_id, v_store.company_id)
  returning token into v_token;

  insert into public.order_items (
    organization_id, company_id, store_id, order_id,
    product_id, variant_id, sku, name, unit_price, quantity, uom_code, uom_factor
  )
  select
    v_store.organization_id, v_store.company_id, v_store.id, v_order_id,
    (line ->> 'product_id')::uuid,
    ebim.safe_uuid(line ->> 'variant_id'),
    line ->> 'sku', line ->> 'name',
    (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
    line ->> 'uom_code', (line ->> 'uom_factor')::numeric
  from jsonb_array_elements(v_lines) as line;

  return jsonb_build_object(
    'order_id',      v_order_id,
    'order_number',  v_number,
    -- Secreto de portador: es la unica forma de que el comprador vuelva a su
    -- pedido despues de recargar. Solo sale AQUI, en la respuesta al que compra.
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
  public.create_order(uuid, text, jsonb, text, text, jsonb, text)
from public, anon, authenticated;

grant execute on function
  public.create_order(uuid, text, jsonb, text, text, jsonb, text)
to service_role;

comment on function public.create_order(uuid, text, jsonb, text, text, jsonb, text) is
  'Crea el pedido resolviendo variante, unidad de venta y componentes de kit contra la base. Ni precio, ni canal, ni factor, ni tenant se aceptan del payload.';
