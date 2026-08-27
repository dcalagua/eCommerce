-- =============================================================================
-- P09 · El impuesto del pedido sale de la categoria fiscal, no de una tasa unica
-- 17/17 — `create_order` aplicaba `store_settings.tax_rate` sobre el subtotal
--         entero. Con `tax_categories` un carrito puede llevar IVA general y
--         productos exentos a la vez, asi que el impuesto se calcula POR LINEA
--         y se redondea POR GRUPO DE TASA, que es como se factura.
--
-- Con una sola tasa el resultado es identico al anterior —round(subtotal*tasa)—,
-- asi que los pedidos existentes no cambian de importe.
--
-- Soporta ademas `store_settings.tax_inclusive`: cuando los precios del catalogo
-- ya llevan impuesto (RFP Alicorp §2.5.3.b), el impuesto se EXTRAE del precio en
-- vez de sumarse encima, y el total sigue siendo exactamente lo que vio el
-- comprador.
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

  -- Un payload que intenta fijar el precio o el tenant se RECHAZA, no se
  -- ignora en silencio: ignorar deja a quien llama creyendo que su valor se
  -- uso, y el error aparece en produccion en vez de en la primera prueba
  -- (contrato §2.6).
  if exists (
    select 1
    from jsonb_array_elements(p_items) as item,
         jsonb_object_keys(item) as k
    where k in ('price', 'unit_price', 'line_total', 'subtotal', 'total',
                'currency', 'organization_id', 'company_id', 'store_id',
                'order_id', 'tenant_id', 'tax_rate', 'tax_total',
                'tax_category_id')
  ) then
    raise exception 'CAMPO_NO_PERMITIDO: el precio y el tenant los decide el servidor, no el payload'
      using errcode = '22023';
  end if;

  -- La tienda fija el tenant del pedido. `organization_id`/`company_id` NUNCA
  -- llegan por parametro: se derivan de la tienda (contrato §2.6).
  select * into v_store
  from public.stores s
  where s.id = p_store_id and s.status = 'active'
  for update;

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda % no existe o no esta activa', p_store_id
      using errcode = '22023';
  end if;

  select coalesce(ss.tax_inclusive, false) into v_inclusive
  from public.store_settings ss where ss.store_id = v_store.id;
  v_inclusive := coalesce(v_inclusive, false);

  -- Agrupa cantidades por producto: dos lineas del mismo SKU son una compra.
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

    -- La tasa la decide el servidor a partir de la categoria fiscal del
    -- producto; si no tiene, cae a la de la tienda y de ahi al legado.
    v_rate := coalesce(
      ebim.effective_tax_rate(v_store.id, v_product.tax_category_id, now()),
      0
    );

    -- Importe de la linea tal como lo vio el comprador. Con `tax_inclusive`
    -- este importe ya lleva el impuesto dentro.
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

  -- Redondeo POR GRUPO DE TASA, no por linea ni sobre el total: es lo que exige
  -- una factura con varios tipos impositivos. Con una sola tasa coincide al
  -- centimo con el calculo anterior.
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
    organization_id, company_id, store_id, order_number, status,
    customer_email, customer_name, customer_phone, currency,
    subtotal, tax_total, shipping_total, discount_total, grand_total,
    shipping_address, notes
  ) values (
    v_store.organization_id, v_store.company_id, v_store.id, v_number, 'pending',
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

  -- El dinero sale como TEXTO decimal exacto. Si saliera como numero JSON, el
  -- primer `JSON.parse` del navegador lo convertiria en float y volveria por la
  -- puerta de atras el problema que el `numeric` de la base evita.
  return jsonb_build_object(
    'order_id',      v_order_id,
    'order_number',  v_number,
    'status',        'pending',
    'currency',      v_store.currency,
    'subtotal',      v_subtotal::text,
    'tax_total',     v_tax::text,
    'grand_total',   (v_subtotal + v_tax)::text,
    'tax_inclusive', v_inclusive,
    'items',         v_lines
  );
end;
$fn$;

-- `create or replace` conserva permisos, pero se reafirman: que un cambio de
-- firma futuro no abra la funcion a `anon` en silencio.
revoke execute on function
  public.create_order(uuid, text, jsonb, text, text, jsonb, text)
from public, anon, authenticated;

grant execute on function
  public.create_order(uuid, text, jsonb, text, text, jsonb, text)
to service_role;

comment on function public.create_order(uuid, text, jsonb, text, text, jsonb, text) is
  'Crea el pedido leyendo precios y tasas de la base. Impuesto por categoria fiscal, redondeado por grupo de tasa. Sin parametros de precio: no hay total que falsificar.';
