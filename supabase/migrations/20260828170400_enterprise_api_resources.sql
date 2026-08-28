-- =============================================================================
-- P14-SaaS · 5/7 — Los RECURSOS de la API empresarial
--
-- ## Por que estas funciones existen en vez de dejar entrar a PostgREST
--
-- Porque un contrato empresarial no puede ser el esquema. Si el socio consulta
-- `GET /rest/v1/orders?select=*`, su integracion depende de nuestros nombres de
-- columna, de nuestros enums y de nuestro dialecto de filtros; renombrar
-- `grand_total` deja de ser un refactor y pasa a ser un incidente con un
-- tercero. Cada funcion de aqui es una **capa de traduccion**: dentro habla
-- Postgres, fuera habla el contrato `v1`.
--
-- Lo que el contrato promete y estas funciones cumplen:
--
--   · **importes como cadena decimal**, nunca como numero de coma flotante. Un
--     JSON con `118.0` se lee en el otro lado como `double` y el redondeo
--     binario acaba descuadrando una factura. `to_char` con dos decimales.
--   · **el pedido se identifica por su NUMERO**, no por un uuid. Es lo que el
--     socio ve en su ERP y lo que el comprador lee en su correo.
--   · **el producto se identifica por SKU**. El socio no conoce —ni tiene por
--     que conocer— nuestros uuid. La traduccion SKU → identificador interno se
--     hace AQUI, que es exactamente el trabajo de un adaptador.
--   · **paginacion por cursor** y no por `offset`: con `offset`, insertar una
--     fila mientras se pagina duplica o se salta registros, y una sincronia de
--     pedidos que se salta uno es peor que una que falla.
--
-- ## Y por que ninguna acepta el tenant
--
-- Todas reciben `p_api_client_id` y NADA MAS que identifique al inquilino.
-- `ebim.api_authorize` mira la fila de la credencial, comprueba el scope y
-- devuelve la sociedad. Un borde con un fallo no puede cruzar tenants porque no
-- existe el parametro con el que pedirselo. Es la regla 6 del contrato de
-- ejecucion llevada a su forma mas fuerte: no se valida lo que el cliente
-- declara, es que el cliente no puede declararlo.
--
-- ## Nota de operacion sobre `POST /v1/orders`
--
-- El alta reusa `public.create_order`, la MISMA funcion que la vitrina, y por
-- tanto pasa por `ebim.assert_checkout_allowed`: el limite anti-bot de P10
-- (5 pedidos por correo y hora, 20 por tienda y hora por defecto). Para un
-- socio que vuelca pedidos ese techo se queda corto, y es configurable por
-- tienda en `store_settings.config -> checkout_rate_limit` sin migracion. Se
-- deja asi a proposito en vez de abrir un camino de alta SIN limite: dos
-- caminos con dos politicas es como se acaba entrando por el que no mira.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.api_money — un solo sitio donde se decide como sale un importe
-- ---------------------------------------------------------------------------
create or replace function ebim.api_money(p_value numeric)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select to_char(coalesce(p_value, 0), 'FM9999999999990.00');
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.api_store — la tienda sobre la que opera esta credencial
--
-- El socio nombra la tienda por su SLUG (publico, estable, el mismo de la URL
-- de la vitrina). Si la sociedad tiene una sola tienda, puede no nombrarla.
-- Si tiene varias y no la nombra, se levanta: elegir por el la primera que
-- devuelva el indice es como se crean pedidos en la tienda equivocada.
-- ---------------------------------------------------------------------------
create or replace function ebim.api_store(
  p_organization_id uuid,
  p_company_id      uuid,
  p_slug            text default null
)
returns public.stores
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_count integer;
  v_slug  text := nullif(lower(btrim(coalesce(p_slug, ''))), '');
begin
  if v_slug is not null then
    select * into v_store
    from public.stores s
    where s.organization_id = p_organization_id
      and s.company_id      = p_company_id
      and lower(s.slug)     = v_slug;
    if not found then
      raise exception 'TIENDA_NO_DISPONIBLE: no hay ninguna tienda "%" en esta sociedad', v_slug
        using errcode = '22023';
    end if;
    return v_store;
  end if;

  select count(*) into v_count
  from public.stores s
  where s.organization_id = p_organization_id and s.company_id = p_company_id;

  if v_count = 0 then
    raise exception 'TIENDA_NO_DISPONIBLE: esta sociedad no tiene ninguna tienda'
      using errcode = '22023';
  end if;
  if v_count > 1 then
    raise exception 'TIENDA_REQUERIDA: esta sociedad tiene varias tiendas, indica cual'
      using errcode = '22023';
  end if;

  select * into v_store
  from public.stores s
  where s.organization_id = p_organization_id and s.company_id = p_company_id;
  return v_store;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.api_order_json — LA representacion canonica del pedido
--
-- Una sola funcion y no una consulta repetida en el listado y en el detalle:
-- dos copias de una representacion publica se separan, y entonces el socio ve
-- un campo en la lista que desaparece en el detalle.
-- ---------------------------------------------------------------------------
create or replace function ebim.api_order_json(p_order_id uuid, p_with_items boolean default true)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'number',             o.order_number,
    'status',             o.status::text,
    'payment_status',     o.payment_status::text,
    'fulfillment_status', o.fulfillment_status::text,
    'source',             o.source_channel::text,
    'currency',           o.currency,
    'subtotal',           ebim.api_money(o.subtotal),
    'tax_total',          ebim.api_money(o.tax_total),
    'shipping_total',     ebim.api_money(o.shipping_total),
    'discount_total',     ebim.api_money(o.discount_total),
    'total',              ebim.api_money(o.grand_total),
    'placed_at',          to_char(o.placed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'store',              (select s.slug from public.stores s where s.id = o.store_id),
    'customer', jsonb_build_object(
      'email', o.customer_email,
      'name',  o.customer_name,
      'phone', o.customer_phone),
    'items', case when p_with_items then coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku',        i.sku,
               'name',       i.name,
               'quantity',   i.quantity,
               'unit_price', ebim.api_money(i.unit_price),
               'line_total', ebim.api_money(i.line_total))
             order by i.created_at, i.sku)
      from public.order_items i where i.order_id = o.id), '[]'::jsonb)
      else null end)
  from public.orders o
  where o.id = p_order_id;
$fn$;

-- ---------------------------------------------------------------------------
-- GET /v1/orders  ·  scope `order.read`
-- ---------------------------------------------------------------------------
create or replace function public.api_orders_list(
  p_api_client_id uuid,
  p_limit         integer     default 50,
  p_cursor        timestamptz default null,
  p_status        text        default null,
  p_store         text        default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_client public.api_clients%rowtype;
  v_store  public.stores%rowtype;
  v_limit  integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_rows   jsonb;
  v_next   timestamptz;
begin
  v_client := ebim.api_authorize(p_api_client_id, 'order.read');
  v_store  := ebim.api_store(v_client.organization_id, v_client.company_id, p_store);

  with pagina as (
    select o.id, o.placed_at
    from public.orders o
    where o.organization_id = v_client.organization_id
      and o.company_id      = v_client.company_id
      and o.store_id        = v_store.id
      and (p_cursor is null or o.placed_at < p_cursor)
      and (p_status is null or o.status::text = lower(btrim(p_status)))
    order by o.placed_at desc, o.id desc
    limit v_limit
  )
  select coalesce(jsonb_agg(ebim.api_order_json(p.id, false) order by p.placed_at desc), '[]'::jsonb),
         min(p.placed_at)
    into v_rows, v_next
  from pagina p;

  return jsonb_build_object(
    'data', v_rows,
    -- El cursor solo se ofrece si la pagina vino LLENA. Devolverlo siempre hace
    -- que el socio pida una pagina de mas en cada sincronia.
    'next_cursor',
      case when jsonb_array_length(v_rows) = v_limit
           then to_char(v_next at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.USZ')
           else null end);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- GET /v1/orders/{number}  ·  scope `order.read`
-- ---------------------------------------------------------------------------
create or replace function public.api_order_get(
  p_api_client_id uuid,
  p_number        text,
  p_store         text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_client public.api_clients%rowtype;
  v_store  public.stores%rowtype;
  v_id     uuid;
begin
  v_client := ebim.api_authorize(p_api_client_id, 'order.read');
  v_store  := ebim.api_store(v_client.organization_id, v_client.company_id, p_store);

  select o.id into v_id
  from public.orders o
  where o.organization_id = v_client.organization_id
    and o.company_id      = v_client.company_id
    and o.store_id        = v_store.id
    and o.order_number    = btrim(coalesce(p_number, ''));

  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con ese numero'
      using errcode = '22023';
  end if;

  return ebim.api_order_json(v_id, true);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- POST /v1/orders  ·  scope `order.create`
--
-- La traduccion SKU → identificador interno vive aqui. Es el ejemplo mas claro
-- de por que la API empresarial no es PostgREST: el socio manda lo que conoce y
-- el servidor resuelve lo que no puede conocer.
-- ---------------------------------------------------------------------------
create or replace function public.api_order_create(
  p_api_client_id uuid,
  p_payload       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_client public.api_clients%rowtype;
  v_store  public.stores%rowtype;
  v_items  jsonb := '[]'::jsonb;
  v_item   jsonb;
  v_sku    text;
  v_qty    integer;
  v_pid    uuid;
  v_vid    uuid;
  v_result jsonb;
begin
  v_client := ebim.api_authorize(p_api_client_id, 'order.create');
  v_store  := ebim.api_store(v_client.organization_id, v_client.company_id,
                             p_payload ->> 'store');

  if jsonb_typeof(p_payload -> 'items') <> 'array'
     or jsonb_array_length(p_payload -> 'items') = 0 then
    raise exception 'ITEMS_REQUERIDOS: el pedido necesita al menos una linea'
      using errcode = '22023';
  end if;
  if jsonb_array_length(p_payload -> 'items') > 200 then
    raise exception 'ITEMS_EXCESIVOS: demasiadas lineas en un solo pedido'
      using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_payload -> 'items')
  loop
    v_sku := nullif(btrim(coalesce(v_item ->> 'sku', '')), '');
    if v_sku is null then
      raise exception 'SKU_REQUERIDO: cada linea se identifica por su sku'
        using errcode = '22023';
    end if;

    v_qty := coalesce((v_item ->> 'quantity')::integer, 0);
    if v_qty <= 0 then
      raise exception 'CANTIDAD_INVALIDA: la cantidad de % tiene que ser mayor que cero', v_sku
        using errcode = '22023';
    end if;

    -- Primero como VARIANTE, despues como producto: el espacio de nombres de
    -- SKU es unico por tienda (trigger `ebim.assert_sku_unique_in_store`), asi
    -- que no hay ambiguedad posible entre los dos.
    v_pid := null;
    v_vid := null;

    select pv.id, pv.product_id into v_vid, v_pid
    from public.product_variants pv
    where pv.store_id = v_store.id and pv.sku = v_sku;

    if v_vid is null then
      select p.id into v_pid
      from public.products p
      where p.store_id = v_store.id and p.sku = v_sku;
    end if;

    if v_pid is null then
      raise exception 'PRODUCTO_NO_DISPONIBLE: no hay ningun articulo con el sku %', v_sku
        using errcode = '22023';
    end if;

    v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'product_id', v_pid,
      'variant_id', v_vid,
      'uom_code',   nullif(btrim(coalesce(v_item ->> 'uom_code', '')), ''),
      'quantity',   v_qty)));
  end loop;

  v_result := public.create_order(
    v_store.id,
    p_payload #>> '{customer,email}',
    v_items,
    p_payload #>> '{customer,name}',
    p_payload #>> '{customer,phone}',
    coalesce(p_payload -> 'shipping_address', '{}'::jsonb),
    nullif(btrim(coalesce(p_payload ->> 'notes', '')), ''),
    null,
    -- El ORIGEN lo declara esta funcion, no el socio: por donde entro un pedido
    -- es un hecho del servidor. `api` ya existe en `order_source_channel`.
    'api');

  perform ebim.audit(
    p_organization_id => v_client.organization_id,
    p_company_id      => v_client.company_id,
    p_action          => 'order.created_via_api',
    p_entity_type     => 'order',
    p_entity_id       => ebim.safe_uuid(v_result ->> 'order_id'),
    p_entity_label    => v_result ->> 'order_number',
    p_store_id        => v_store.id,
    p_metadata        => jsonb_build_object('api_client_id', v_client.id,
                                            'client_id', v_client.client_id),
    p_actor_kind      => 'service'::public.audit_actor_kind);

  return public.api_order_get(p_api_client_id, v_result ->> 'order_number', v_store.slug);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- GET /v1/products  ·  scope `product.read`
--
-- Devuelve el catalogo de la tienda, publicado o no: quien pregunta es el
-- sistema del propio comercio, no un comprador. Lo que NO devuelve es la
-- existencia exacta: para eso esta `stock.read`, que se concede aparte porque
-- la cifra de inventario es informacion comercial sensible que un socio
-- logistico no necesita.
-- ---------------------------------------------------------------------------
create or replace function public.api_products_list(
  p_api_client_id uuid,
  p_limit         integer default 50,
  p_cursor        text    default null,
  p_store         text    default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_client public.api_clients%rowtype;
  v_store  public.stores%rowtype;
  v_limit  integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_rows   jsonb;
  v_next   text;
begin
  v_client := ebim.api_authorize(p_api_client_id, 'product.read');
  v_store  := ebim.api_store(v_client.organization_id, v_client.company_id, p_store);

  with pagina as (
    select p.sku, p.name, p.status::text as status, p.currency, p.price,
           p.kind::text as kind, p.slug
    from public.products p
    where p.organization_id = v_client.organization_id
      and p.company_id      = v_client.company_id
      and p.store_id        = v_store.id
      and (p_cursor is null or p.sku > p_cursor)
    order by p.sku
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'sku',       g.sku,
           'name',      g.name,
           'slug',      g.slug,
           'kind',      g.kind,
           'status',    g.status,
           'currency',  g.currency,
           'price',     ebim.api_money(g.price)) order by g.sku), '[]'::jsonb),
         max(g.sku)
    into v_rows, v_next
  from pagina g;

  return jsonb_build_object(
    'data', v_rows,
    'next_cursor', case when jsonb_array_length(v_rows) = v_limit then v_next else null end);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- GET /v1/stock  ·  scope `stock.read`
--
-- La cifra sale de `ebim.atp`, la UNICA autoridad de disponibilidad (P06). No
-- se lee `products.stock` a mano: eso daria una cifra distinta de la que ve la
-- vitrina y de la que usa el checkout, y entonces la sincronia con el ERP
-- discutiria con la propia tienda.
-- ---------------------------------------------------------------------------
create or replace function public.api_stock_read(
  p_api_client_id uuid,
  p_sku           text,
  p_store         text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_client public.api_clients%rowtype;
  v_store  public.stores%rowtype;
  v_sku    text := nullif(btrim(coalesce(p_sku, '')), '');
  v_pid    uuid;
  v_vid    uuid;
  v_atp    jsonb;
begin
  v_client := ebim.api_authorize(p_api_client_id, 'stock.read');
  v_store  := ebim.api_store(v_client.organization_id, v_client.company_id, p_store);

  if v_sku is null then
    raise exception 'SKU_REQUERIDO: indica el sku del que quieres la existencia'
      using errcode = '22023';
  end if;

  select pv.id, pv.product_id into v_vid, v_pid
  from public.product_variants pv
  where pv.store_id = v_store.id and pv.sku = v_sku;

  if v_vid is null then
    select p.id into v_pid
    from public.products p
    where p.store_id = v_store.id and p.sku = v_sku;
  end if;

  if v_pid is null then
    raise exception 'PRODUCTO_NO_DISPONIBLE: no hay ningun articulo con el sku %', v_sku
      using errcode = '22023';
  end if;

  v_atp := ebim.atp(v_store.id, v_pid, v_vid);

  return jsonb_build_object(
    'sku',       v_sku,
    'available', coalesce((v_atp ->> 'available')::numeric, 0)::integer,
    'in_stock',  coalesce((v_atp ->> 'available')::numeric, 0) > 0,
    'as_of',     to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- GET /v1/customers  ·  scope `customer.read`
--
-- La ficha, no el historial. Sin direcciones ni contactos: un scope de lectura
-- de clientes concedido a un socio de mensajeria no tiene por que llevarse la
-- agenda entera de la sociedad.
-- ---------------------------------------------------------------------------
create or replace function public.api_customers_list(
  p_api_client_id uuid,
  p_limit         integer default 50,
  p_cursor        timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_client public.api_clients%rowtype;
  v_limit  integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_rows   jsonb;
  v_next   timestamptz;
begin
  v_client := ebim.api_authorize(p_api_client_id, 'customer.read');

  with pagina as (
    select c.id, c.created_at, c.kind::text as kind, c.code, c.name,
           c.legal_name, c.email, c.phone, c.tax_id, c.is_active
    from public.customers c
    where c.organization_id = v_client.organization_id
      and c.company_id      = v_client.company_id
      and (p_cursor is null or c.created_at < p_cursor)
    order by c.created_at desc, c.id desc
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',         g.id,
           'kind',       g.kind,
           'code',       g.code,
           'name',       g.name,
           'legal_name', g.legal_name,
           'email',      g.email,
           'phone',      g.phone,
           'tax_id',     g.tax_id,
           'is_active',  g.is_active,
           'created_at', to_char(g.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
         order by g.created_at desc), '[]'::jsonb),
         min(g.created_at)
    into v_rows, v_next
  from pagina g;

  return jsonb_build_object(
    'data', v_rows,
    'next_cursor',
      case when jsonb_array_length(v_rows) = v_limit
           then to_char(v_next at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.USZ')
           else null end);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Permisos: SOLO el servidor. Estas funciones no pasan por la RLS —derivan el
-- tenant de la credencial— y por eso `authenticated` no puede ni rozarlas: un
-- usuario del backoffice que pudiera llamarlas con el uuid de una credencial
-- ajena leeria datos de otro tenant.
-- ---------------------------------------------------------------------------
revoke execute on function
  ebim.api_money(numeric),
  ebim.api_store(uuid, uuid, text),
  ebim.api_order_json(uuid, boolean),
  public.api_orders_list(uuid, integer, timestamptz, text, text),
  public.api_order_get(uuid, text, text),
  public.api_order_create(uuid, jsonb),
  public.api_products_list(uuid, integer, text, text),
  public.api_stock_read(uuid, text, text),
  public.api_customers_list(uuid, integer, timestamptz)
from public, anon, authenticated;

grant execute on function
  public.api_orders_list(uuid, integer, timestamptz, text, text),
  public.api_order_get(uuid, text, text),
  public.api_order_create(uuid, jsonb),
  public.api_products_list(uuid, integer, text, text),
  public.api_stock_read(uuid, text, text),
  public.api_customers_list(uuid, integer, timestamptz)
to service_role;

comment on function public.api_order_create(uuid, jsonb) is
  'Alta de pedido por la API de socio. Traduce SKU a identificador interno y declara el origen `api`: el socio no elige por donde entro su pedido.';
comment on function public.api_stock_read(uuid, text, text) is
  'Existencia por ebim.atp, la unica autoridad de disponibilidad: la API nunca contradice a la vitrina.';
comment on function ebim.api_money(numeric) is
  'Los importes salen como cadena decimal. Un numero JSON se lee como double al otro lado y descuadra facturas.';
