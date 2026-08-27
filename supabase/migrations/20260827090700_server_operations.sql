-- =============================================================================
-- P02 · 08/08 — Operaciones de servidor.
--
-- Dos operaciones no pueden vivir en el cliente:
--   1. el alta de tenant (tenant + owner + tienda, todo o nada);
--   2. la creación de un pedido (precios y totales los pone la base).
--
-- Ambas son SECURITY DEFINER con autorización explícita dentro y REVOKE a
-- anon/authenticated/public: el llamador legítimo es el servidor
-- (Edge Function con service_role) — lección esupplier-030.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- bootstrap_tenant — alta atómica. El correo del administrador es OBLIGATORIO
-- y se valida AQUÍ, en la base, no solo en la edge ni en la pantalla
-- (contrato §3.2: un parámetro con default null es la puerta por la que se
-- cuela un espacio sin dueño).
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_tenant(
  p_organization_id uuid,
  p_company_id      uuid,
  p_tenant_slug     text,
  p_tenant_name     text,
  p_admin_email     text,
  p_owner_user_id   uuid,
  p_store_slug      text,
  p_store_name      text,
  p_currency        text default 'PEN'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store_id uuid;
  v_member_id uuid;
  v_email text := lower(btrim(coalesce(p_admin_email, '')));
begin
  if p_organization_id is null or p_company_id is null then
    raise exception 'TENANT_REQUERIDO: organization_id y company_id son obligatorios'
      using errcode = '22023';
  end if;

  -- Contrato §3.2 — sin correo de administrador, el alta no se hace.
  if v_email = '' or position('@' in v_email) < 2 then
    raise exception 'ADMIN_EMAIL_REQUERIDO: el alta de tenant exige el correo de un administrador'
      using errcode = '22023';
  end if;

  if p_owner_user_id is null then
    raise exception 'OWNER_REQUERIDO: el alta de tenant exige el usuario propietario'
      using errcode = '22023';
  end if;

  -- El super admin de suite no es actor de negocio de un tenant (contrato §13).
  if v_email like '%@ebim.pe' then
    raise exception 'ADMIN_EMAIL_INVALIDO: un correo @ebim.pe no puede ser administrador de un tenant'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.tenants t where t.organization_id = p_organization_id) then
    raise exception 'TENANT_YA_EXISTE: la organizacion % ya esta dada de alta', p_organization_id
      using errcode = '23505';
  end if;

  insert into public.tenants (organization_id, slug, name, admin_email)
  values (p_organization_id, lower(btrim(p_tenant_slug)), btrim(p_tenant_name), v_email);

  insert into public.tenant_members
    (organization_id, company_id, user_id, email, role, status)
  values
    (p_organization_id, p_company_id, p_owner_user_id, v_email, 'owner', 'active')
  returning id into v_member_id;

  insert into public.stores
    (organization_id, company_id, slug, name, status, currency)
  values
    (p_organization_id, p_company_id, lower(btrim(p_store_slug)), btrim(p_store_name),
     'draft', upper(coalesce(nullif(btrim(p_currency), ''), 'PEN')))
  returning id into v_store_id;

  insert into public.store_settings (store_id, organization_id, company_id)
  values (v_store_id, p_organization_id, p_company_id);

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'company_id',      p_company_id,
    'tenant_slug',     lower(btrim(p_tenant_slug)),
    'admin_email',     v_email,
    'owner_member_id', v_member_id,
    'store_id',        v_store_id,
    'store_slug',      lower(btrim(p_store_slug))
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- create_order — el cliente manda QUÉ y CUÁNTO; el precio y el total los pone
-- la base. La función no tiene ni un parámetro de precio: no hay nada que
-- manipular desde el navegador.
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
  v_tax_rate    numeric(6,4);
  v_order_id    uuid;
  v_seq         bigint;
  v_number      text;
  v_subtotal    numeric(14,2) := 0;
  v_tax         numeric(14,2) := 0;
  v_item        jsonb;
  v_product     public.products%rowtype;
  v_qty         integer;
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
                'order_id', 'tenant_id')
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

  select coalesce(ss.tax_rate, 0) into v_tax_rate
  from public.store_settings ss where ss.store_id = v_store.id;
  v_tax_rate := coalesce(v_tax_rate, 0);

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

    v_subtotal := v_subtotal + round(v_product.price * v_qty, 2);
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product.id,
      'sku',        v_product.sku,
      'name',       v_product.name,
      'unit_price', v_product.price::text,
      'quantity',   v_qty
    );

    update public.products
       set stock = stock - v_qty
     where id = v_product.id;
  end loop;

  v_tax := round(v_subtotal * v_tax_rate, 2);

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
    'order_id',     v_order_id,
    'order_number', v_number,
    'status',       'pending',
    'currency',     v_store.currency,
    'subtotal',     v_subtotal::text,
    'tax_total',    v_tax::text,
    'grand_total',  (v_subtotal + v_tax)::text,
    'items',        v_lines
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Solo el servidor. `anon` y `authenticated` no pueden invocarlas ni por
-- accidente ni por PostgREST.
-- ---------------------------------------------------------------------------
revoke execute on function
  public.bootstrap_tenant(uuid, uuid, text, text, text, uuid, text, text, text),
  public.create_order(uuid, text, jsonb, text, text, jsonb, text)
from public, anon, authenticated;

grant execute on function
  public.bootstrap_tenant(uuid, uuid, text, text, text, uuid, text, text, text),
  public.create_order(uuid, text, jsonb, text, text, jsonb, text)
to service_role;

comment on function public.bootstrap_tenant(uuid, uuid, text, text, text, uuid, text, text, text) is
  'Alta atomica tenant + owner + tienda. Exige admin_email (contrato §3.2). Solo service_role.';
comment on function public.create_order(uuid, text, jsonb, text, text, jsonb, text) is
  'Crea el pedido leyendo precios de la base. Sin parametros de precio: no hay total que falsificar.';
