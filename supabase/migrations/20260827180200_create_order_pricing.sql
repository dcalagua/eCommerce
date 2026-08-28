-- =============================================================================
-- P04-SaaS · El pedido deja de calcular el precio y pasa a PEDIRLO
--
-- `create_order` era, desde P02, la autoridad de precio de este producto: leia
-- `products.price`, lo heredaba a la variante y lo multiplicaba por el factor de
-- la presentacion. Esa logica se va entera a `ebim.resolve_price`, y la funcion
-- del pedido se queda con lo que solo ella puede hacer: bloquear existencias,
-- numerar y escribir dentro de una transaccion.
--
-- Que NO cambia, porque es lo que hace que el pedido sea confiable:
--
--  · el precio lo sigue decidiendo la base, no el payload — ahora ademas la
--    lista negra crece con `segment_id`, `customer_id` y `price_list_id`, que
--    son las tres formas nuevas de intentar comprarse a uno mismo un descuento;
--  · el canal lo sigue eligiendo el servidor;
--  · el impuesto y el redondeo por grupo de tasa son identicos;
--  · sin listas que alcancen, el importe es EXACTAMENTE el de antes. Los tests
--    de pedido de P02 y P03 pasan sin tocar una linea, y eso es la prueba de
--    que el fallback funciona.
--
-- Que si cambia: la linea del pedido guarda POR QUE costo lo que costo.
-- `price_source` y `price_list_id` convierten "el sistema puso 8" en "lo puso
-- la lista mayorista", que es la unica respuesta util cuando alguien reclama.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- order_items — dos columnas de trazabilidad.
--
-- `price_list_id` con `on delete set null`, igual que `variant_id`: al borrar la
-- lista, la linea pierde el enlace y conserva su snapshot de precio.
-- `price_source` NO se borra nunca: aunque la lista desaparezca, la linea sigue
-- pudiendo decir que su precio no salio del catalogo.
-- ---------------------------------------------------------------------------
alter table public.order_items
  add column price_list_id uuid,
  add column price_source  text not null default 'catalog';

alter table public.order_items
  add constraint order_items_price_source check (price_source in ('catalog', 'price_list')),
  add constraint order_items_price_list_fk foreign key (price_list_id, store_id)
    references public.price_lists (id, store_id) on delete set null (price_list_id);

create index order_items_price_list_idx
  on public.order_items (price_list_id) where price_list_id is not null;

comment on column public.order_items.price_source is
  'De donde salio el precio de la linea: catalogo o lista. Sobrevive al borrado de la lista; price_list_id no.';
comment on column public.order_items.price_list_id is
  'Lista que decidio el precio, si fue una. Enlace vivo para analitica; el importe ya esta congelado en unit_price.';

-- ---------------------------------------------------------------------------
-- create_order — misma firma, mismas garantias, el precio lo pone el motor.
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
  v_uom_id      uuid;
  v_factor      numeric(18,6);
  v_priced      jsonb;
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

  -- La lista negra crece con las tres llaves del motor de precios. Un comprador
  -- que pudiera declarar `segment_id` o `customer_id` se estaria asignando a si
  -- mismo el acuerdo comercial de otro; uno que pudiera declarar
  -- `price_list_id` se saltaria la precedencia entera.
  if exists (
    select 1
    from jsonb_array_elements(p_items) as item,
         jsonb_object_keys(item) as k
    where k in ('price', 'unit_price', 'line_total', 'subtotal', 'total',
                'currency', 'organization_id', 'company_id', 'store_id',
                'order_id', 'tenant_id', 'tax_rate', 'tax_total',
                'tax_category_id', 'channel_id',
                'uom_id', 'uom_factor', 'factor', 'base_quantity', 'sku',
                'segment_id', 'customer_id', 'price_list_id', 'price_source')
  ) then
    raise exception 'CAMPO_NO_PERMITIDO: el precio, el canal, la lista, el factor y el tenant los decide el servidor, no el payload'
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
    -- Se resuelve aqui —y no dentro del motor— porque el pedido necesita el
    -- FACTOR para descontar existencia, no solo para tarifar. El motor vuelve a
    -- leerlo por su cuenta: prefiero la lectura repetida a pasarle un factor,
    -- porque un factor que se puede pasar se puede pasar mal.
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
    -- Sin segmento ni cliente: el checkout publico es anonimo. El dia que P05
    -- traiga cuentas B2B con sesion, lo que cambia son estos dos argumentos, no
    -- el motor ni el pedido.
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
      -- Trazabilidad del precio: la respuesta a "por que costo esto".
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
  public.create_order(uuid, text, jsonb, text, text, jsonb, text)
from public, anon, authenticated;

grant execute on function
  public.create_order(uuid, text, jsonb, text, text, jsonb, text)
to service_role;

comment on function public.create_order(uuid, text, jsonb, text, text, jsonb, text) is
  'Crea el pedido pidiendo el precio a ebim.resolve_price y bloqueando existencias. Ni precio, ni canal, ni lista, ni factor, ni tenant se aceptan del payload.';

-- ---------------------------------------------------------------------------
-- La capacidad deja de ser una promesa.
--
-- `pricing.lists` estaba `declared` desde P02-SaaS: se podia contratar y gatear
-- y no habia nada detras. Ahora tiene esquema, motor, pantalla y pedido. El
-- `state` dice la verdad sobre el producto HOY, y un test de paridad lo compara
-- contra `src/domain/capabilities.ts`.
-- ---------------------------------------------------------------------------
update public.app_capabilities
   set state = 'implemented'
 where code = 'pricing.lists';
