-- =============================================================================
-- P10 · `create_order` pasa a ser consciente del canal
-- 21/21 — El pedido nace ahora en un canal concreto, y el canal lo decide el
--         SERVIDOR: si el payload trae `channel_id` se rechaza, igual que el
--         precio o el tenant. La vitrina publica solo puede comprar por el canal
--         por defecto de la tienda, que por construccion no exige sesion.
--
-- Ademas se respeta la visibilidad del catalogo: un producto que no esta
-- publicado en el canal NO se puede comprar por ese canal, aunque se conozca su
-- uuid y este publicado en la tienda. Es la regla que hace util el catalogo
-- restringido del canal interno (RFP §4.4.2).
--
-- Compatibilidad: `product_channels` vacio para un canal significa "todo el
-- catalogo de la tienda". Sin esa regla, la migracion 20 habria dejado todas las
-- tiendas existentes sin nada que vender hasta poblar la tabla a mano.
-- =============================================================================

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
  v_subtotal    numeric(14,2) := 0;
  v_tax         numeric(14,2) := 0;
  v_item        jsonb;
  v_product     public.products%rowtype;
  v_qty         integer;
  v_rate        numeric(6,4);
  v_amount      numeric(14,2);
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
  -- interno, con sus precios preferenciales.
  if exists (
    select 1
    from jsonb_array_elements(p_items) as item,
         jsonb_object_keys(item) as k
    where k in ('price', 'unit_price', 'line_total', 'subtotal', 'total',
                'currency', 'organization_id', 'company_id', 'store_id',
                'order_id', 'tenant_id', 'tax_rate', 'tax_total',
                'tax_category_id', 'channel_id')
  ) then
    raise exception 'CAMPO_NO_PERMITIDO: el precio, el canal y el tenant los decide el servidor, no el payload'
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

  -- Canal por defecto de la tienda. El CHECK `channels_auth_matches_kind`
  -- garantiza que un canal `b2c` nunca exige sesion, pero se comprueba igual:
  -- si alguien marcase por defecto un canal cerrado, la vitrina publica no
  -- puede seguir vendiendo por el.
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

  -- Un canal sin filas en `product_channels` vende todo el catalogo de la
  -- tienda; en cuanto tiene una, la lista pasa a ser cerrada.
  select exists (
    select 1 from public.product_channels pc where pc.channel_id = v_channel.id
  ) into v_scoped;

  select coalesce(ss.tax_inclusive, false) into v_inclusive
  from public.store_settings ss where ss.store_id = v_store.id;
  v_inclusive := coalesce(v_inclusive, false);

  select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity)), '[]'::jsonb)
    into v_normalized
  from (
    select (item ->> 'product_id') as product_id, sum((item ->> 'quantity')::numeric)::integer as quantity
    from jsonb_array_elements(p_items) as item
    group by 1
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

    if v_product.stock < v_qty then
      raise exception 'STOCK_INSUFICIENTE: % (disponible %, pedido %)',
        v_product.sku, v_product.stock, v_qty
        using errcode = '22023';
    end if;

    if v_product.currency <> v_store.currency then
      raise exception 'MONEDA_INCONSISTENTE: % esta en % y la tienda en %',
        v_product.sku, v_product.currency, v_store.currency
        using errcode = '22023';
    end if;

    v_rate := coalesce(
      ebim.effective_tax_rate(v_store.id, v_product.tax_category_id, now()),
      0
    );

    v_amount := round(v_product.price * v_qty, 2);

    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product.id,
      'sku',        v_product.sku,
      'name',       v_product.name,
      'unit_price', v_product.price::text,
      'quantity',   v_qty,
      'amount',     v_amount::text,
      'tax_rate',   v_rate::text
    );

    update public.products
       set stock = stock - v_qty
     where id = v_product.id;
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

  insert into public.order_items (
    organization_id, company_id, store_id, order_id,
    product_id, sku, name, unit_price, quantity
  )
  select
    v_store.organization_id, v_store.company_id, v_store.id, v_order_id,
    (line ->> 'product_id')::uuid, line ->> 'sku', line ->> 'name',
    (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer
  from jsonb_array_elements(v_lines) as line;

  return jsonb_build_object(
    'order_id',      v_order_id,
    'order_number',  v_number,
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
  'Crea el pedido en el canal por defecto de la tienda, leyendo precios y tasas de la base. Ni precio ni canal ni tenant se aceptan del payload.';
