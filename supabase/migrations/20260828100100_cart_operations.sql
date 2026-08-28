-- =============================================================================
-- P07-SaaS · Las operaciones del carrito, y la fusion al iniciar sesion
--
-- Cuatro puertas y una sola forma de autorizarlas: **o una sesion o un
-- secreto**. Ninguna acepta un `cart_id`, un `store_id` ni un `user_id`
-- declarado por el navegador (regla 6 del contrato de ejecucion). La tienda
-- sale del slug de la URL publica —igual que en `create_order_for_slug` y en
-- `price_quote_for_slug`— y el canal lo elige el servidor.
--
-- ## La fusion, que es la parte que se hace mal
--
-- Tres reglas, y las tres estan escritas en `ebim.merge_cart_lines`:
--
--  1. **Solo se absorbe un carrito SIN dueño.** Un token de invitado no puede
--     apoderarse del carrito de alguien con sesion, ni al reves. La direccion
--     es unica: invitado -> usuario.
--  2. **Misma tienda y mismo canal, o no se fusiona.** Dos canales con precios
--     distintos no se pueden sumar en una lista.
--  3. **La cantidad que gana es el MAXIMO, no la suma.** Es la decision
--     incomoda y es deliberada: quien puso 2 unidades en el movil y 2 en el
--     portatil no pidio 4. Sumar inventa unidades que nadie eligio y se
--     descubre en la caja; el maximo conserva la intencion mas alta de las dos
--     y siempre se puede subir a mano.
--
-- ## El carrito vacio de un invitado dura dos horas
--
-- `cart_open` sin token crea una fila. Si esa fila naciera con los 30 dias del
-- defecto, un rastreador que abriera la vitrina mil veces dejaria mil carritos
-- vivos durante un mes. Nace con dos horas y solo cuando recibe lineas —o sea,
-- cuando hay una intencion de compra de verdad— pasa a durar una semana.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.public_channel — el canal por el que entra el comprador de la vitrina.
--
-- Es el MISMO criterio que ya aplican `create_order` (200400) y
-- `price_quote_for_slug` (180100): el canal por defecto, activo y que no exige
-- sesion. Se saca a una funcion porque el carrito seria la TERCERA copia, y una
-- regla copiada tres veces es una regla que ya diverge.
-- ---------------------------------------------------------------------------
create or replace function ebim.public_channel(p_store_id uuid)
returns public.channels
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_channel public.channels%rowtype;
  v_slug    text;
begin
  select s.slug into v_slug from public.stores s where s.id = p_store_id;

  select * into v_channel
  from public.channels c
  where c.store_id = p_store_id and c.is_default and c.is_active;

  if not found then
    raise exception 'CANAL_NO_DISPONIBLE: la tienda % no tiene canal por defecto activo',
      coalesce(v_slug, p_store_id::text)
      using errcode = '22023';
  end if;

  if v_channel.requires_auth then
    raise exception 'CANAL_NO_PUBLICO: el canal por defecto de % exige sesion',
      coalesce(v_slug, p_store_id::text)
      using errcode = '22023';
  end if;

  return v_channel;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.active_store_by_slug — la tienda, resuelta SIEMPRE por el servidor.
-- ---------------------------------------------------------------------------
create or replace function ebim.active_store_by_slug(p_store_slug text)
returns public.stores
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_slug  text := lower(btrim(coalesce(p_store_slug, '')));
begin
  if v_slug = '' then
    raise exception 'TIENDA_NO_DISPONIBLE: falta la tienda' using errcode = '22023';
  end if;

  select * into v_store
  from public.stores s
  where lower(s.slug) = v_slug and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  return v_store;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.expire_due_carts — soltar lo que ya no es de nadie.
--
-- Se llama al abrir un carrito, igual que `ebim.expire_due_reservations` se
-- llama al reservar: este proyecto no tiene un planificador garantizado, y una
-- caducidad que depende de un job que puede no existir no existe.
-- ---------------------------------------------------------------------------
create or replace function ebim.expire_due_carts(p_store_id uuid default null)
returns integer
language plpgsql
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  update public.carts c
     set status = 'abandoned'
   where c.status = 'active'
     and c.expires_at <= now()
     and (p_store_id is null or c.store_id = p_store_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.cart_authorize — o el token, o la sesion del dueño. Nunca un id.
--
-- Un carrito CON dueño exige la sesion de ese dueño ADEMAS del token: el token
-- viaja por la URL de una llamada y podria acabar en un registro; la sesion,
-- no. Un carrito de invitado se autoriza solo con el token, porque no hay otra
-- cosa que presentar.
--
-- No distingue "no existe" de "no es tuyo", por la misma razon que
-- `order_by_token`: dos mensajes distintos son un oraculo.
-- ---------------------------------------------------------------------------
create or replace function ebim.cart_authorize(p_store_id uuid, p_token text)
returns public.carts
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_cart public.carts%rowtype;
begin
  if p_token is null or char_length(btrim(p_token)) <> 64 then
    raise exception 'CARRITO_NO_ENCONTRADO: no hay ningun carrito con esos datos'
      using errcode = '22023';
  end if;

  select * into v_cart
  from public.carts c
  where c.store_id = p_store_id and c.token = btrim(p_token);

  if not found then
    raise exception 'CARRITO_NO_ENCONTRADO: no hay ningun carrito con esos datos'
      using errcode = '22023';
  end if;

  if v_cart.user_id is not null and v_cart.user_id is distinct from ebim.user_id() then
    raise exception 'CARRITO_NO_ENCONTRADO: no hay ningun carrito con esos datos'
      using errcode = '22023';
  end if;

  return v_cart;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.cart_payload — lo que ve el comprador.
--
-- Trae TRES cosas que el navegador no puede calcular por su cuenta, y esa es
-- justo la razon de que el carrito tenga servidor:
--
--   · `quote`          — la cotizacion vigente, de la MISMA funcion que cobra.
--   · `price_changed`  — si el precio guardado ya no es el de ahora.
--   · `availability`   — semaforo por cantidad, sin cifra (P06). Nunca sale un
--                        numero de existencia a un comprador.
--
-- Si la cotizacion no se puede hacer —una linea dejo de estar publicada, se
-- salio del canal— NO se cae: se devuelve `quote: null` con su codigo. Un
-- carrito que revienta entero porque una de cinco lineas caduco es un carrito
-- que el comprador no puede arreglar.
-- ---------------------------------------------------------------------------
create or replace function ebim.cart_payload(p_cart_id uuid, p_with_token boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_cart      public.carts%rowtype;
  v_channel   public.channels%rowtype;
  v_items     jsonb := '[]'::jsonb;
  v_quote     jsonb := null;
  v_error     text  := null;
  v_lines     jsonb := '[]'::jsonb;
  v_row       record;
  v_quoted    jsonb;
  v_atp       jsonb;
  v_price     text;
begin
  select * into v_cart from public.carts c where c.id = p_cart_id;
  if not found then
    raise exception 'CARRITO_NO_ENCONTRADO: no hay ningun carrito con esos datos'
      using errcode = '22023';
  end if;

  select * into v_channel from public.channels c where c.id = v_cart.channel_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', i.product_id,
           'variant_id', i.variant_id,
           'uom_code',   i.uom_code,
           'quantity',   i.quantity
         ) order by i.created_at, i.id), '[]'::jsonb)
    into v_items
  from public.cart_items i
  where i.cart_id = v_cart.id;

  if jsonb_array_length(v_items) > 0 then
    begin
      v_quote := ebim.build_quote(
        v_cart.store_id, v_cart.channel_id, v_items, null, null, now(), true);
    exception when others then
      -- El codigo de negocio, no el texto de Postgres: es lo que la pantalla
      -- puede traducir a algo que el comprador sepa arreglar.
      v_quote := null;
      v_error := coalesce(
        substring(sqlerrm from '^([A-Z][A-Z0-9_]{3,60}):'), 'COTIZACION_NO_DISPONIBLE');
    end;
  end if;

  for v_row in
    select i.*, p.slug as product_slug, p.name as product_name, p.kind,
           v.name as variant_name
    from public.cart_items i
    join public.products p on p.id = i.product_id
    left join public.product_variants v on v.id = i.variant_id
    where i.cart_id = v_cart.id
    order by i.created_at, i.id
  loop
    v_quoted := null;
    if v_quote is not null then
      select line into v_quoted
      from jsonb_array_elements(v_quote -> 'lines') as line
      where (line ->> 'product_id')::uuid = v_row.product_id
        and ebim.safe_uuid(line ->> 'variant_id') is not distinct from v_row.variant_id
        and nullif(line ->> 'uom_code', '') is not distinct from v_row.uom_code
      limit 1;
    end if;

    -- Semaforo, jamas la cifra: es la misma regla de `availability_for_slug`.
    v_atp := ebim.atp(v_cart.store_id, v_row.product_id, v_row.variant_id);
    v_price := v_quoted ->> 'unit_price';

    v_lines := v_lines || jsonb_build_object(
      'product_id',   v_row.product_id,
      'variant_id',   v_row.variant_id,
      'uom_code',     v_row.uom_code,
      'quantity',     v_row.quantity,
      'slug',         v_row.product_slug,
      'name',         case when v_row.variant_name is null
                           then v_row.product_name
                           else v_row.product_name || ' · ' || v_row.variant_name end,
      'unit_price_snapshot', case when v_row.unit_price_snapshot is null then null
                                  else v_row.unit_price_snapshot::text end,
      'unit_price',   v_price,
      -- El aviso solo aparece cuando hay las dos cifras y difieren. Sin
      -- snapshot no hay con que comparar, y decir "cambio" seria inventarlo.
      'price_changed', case
                         when v_row.unit_price_snapshot is null or v_price is null then false
                         else v_row.unit_price_snapshot <> v_price::numeric
                       end,
      'in_stock',     coalesce((v_atp ->> 'backorder')::boolean, false)
                      or coalesce((v_atp ->> 'unknown')::boolean, false)
                      or coalesce((v_atp ->> 'available')::numeric, 0) >= v_row.quantity,
      'availability_unknown', coalesce((v_atp ->> 'unknown')::boolean, false)
    );
  end loop;

  return jsonb_build_object(
    'cart_id',      v_cart.id,
    'token',        case when p_with_token then v_cart.token else null end,
    'status',       v_cart.status,
    'channel',      v_channel.code,
    'currency',     v_cart.currency,
    'owned',        v_cart.user_id is not null,
    'expires_at',   v_cart.expires_at,
    'order_id',     v_cart.order_id,
    'lines',        v_lines,
    'quote',        v_quote,
    'quote_error',  v_error
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.merge_cart_lines — la fusion, con sus tres reglas dentro.
-- ---------------------------------------------------------------------------
create or replace function ebim.merge_cart_lines(p_source uuid, p_target uuid)
returns integer
language plpgsql
set search_path = ''
as $fn$
declare
  v_source public.carts%rowtype;
  v_target public.carts%rowtype;
  v_moved  integer := 0;
begin
  select * into v_source from public.carts c where c.id = p_source for update;
  if not found then return 0; end if;

  select * into v_target from public.carts c where c.id = p_target for update;
  if not found then
    raise exception 'CARRITO_NO_ENCONTRADO: no hay ningun carrito con esos datos'
      using errcode = '22023';
  end if;

  if v_source.id = v_target.id then return 0; end if;

  -- Regla 1: solo se absorbe un carrito SIN dueño.
  if v_source.user_id is not null then
    raise exception 'CARRITO_CON_DUENO: un carrito de otra sesion no se puede absorber'
      using errcode = '22023';
  end if;

  -- Regla 2: misma tienda y mismo canal.
  if v_source.store_id <> v_target.store_id then
    raise exception 'CARRITO_DE_OTRA_TIENDA: no se pueden mezclar dos tiendas en un carrito'
      using errcode = '22023';
  end if;
  if v_source.channel_id <> v_target.channel_id then
    raise exception 'CARRITO_DE_OTRO_CANAL: no se pueden mezclar dos canales en un carrito'
      using errcode = '22023';
  end if;

  if v_source.status <> 'active' then
    -- Nada que fusionar y nada que romper: el carrito ya se cerro.
    return 0;
  end if;

  -- Regla 3: gana el MAXIMO, no la suma.
  insert into public.cart_items (
    organization_id, company_id, store_id, cart_id,
    product_id, variant_id, uom_code, quantity,
    unit_price_snapshot, currency_snapshot, quoted_at
  )
  select v_target.organization_id, v_target.company_id, v_target.store_id, v_target.id,
         s.product_id, s.variant_id, s.uom_code, s.quantity,
         s.unit_price_snapshot, s.currency_snapshot, s.quoted_at
  from public.cart_items s
  where s.cart_id = v_source.id
  on conflict (cart_id, product_id,
               coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(uom_code, ''))
  do update set quantity = greatest(cart_items.quantity, excluded.quantity);

  get diagnostics v_moved = row_count;

  delete from public.cart_items where cart_id = v_source.id;

  update public.carts
     set status = 'merged', merged_into = v_target.id
   where id = v_source.id;

  update public.carts
     set last_activity_at = now()
   where id = v_target.id;

  return v_moved;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.cart_open — abrir (o recuperar) el carrito de quien llama.
--
-- Con sesion: SU carrito de esta tienda y este canal, el mismo en cualquier
-- dispositivo. Sin sesion: el del token, o uno nuevo. Y si llega un token de
-- invitado teniendo sesion, ese carrito se FUSIONA en el del usuario: es el
-- momento exacto —y el unico— en el que la fusion tiene sentido.
--
-- Un token que no corresponde a nada NO es un error: se abre uno nuevo. Fallar
-- dejaria a alguien con un `localStorage` viejo sin poder comprar hasta que
-- supiera borrarlo.
-- ---------------------------------------------------------------------------
create or replace function public.cart_open(
  p_store_slug text,
  p_token      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store   public.stores%rowtype;
  v_channel public.channels%rowtype;
  v_user    uuid := ebim.user_id();
  v_token   text := nullif(btrim(coalesce(p_token, '')), '');
  v_guest   public.carts%rowtype;
  v_cart    public.carts%rowtype;
begin
  v_store   := ebim.active_store_by_slug(p_store_slug);
  v_channel := ebim.public_channel(v_store.id);

  perform ebim.expire_due_carts(v_store.id);

  if v_token is not null and char_length(v_token) = 64 then
    select * into v_guest
    from public.carts c
    where c.store_id = v_store.id
      and c.token = v_token
      and c.status = 'active';
    if not found then v_guest := null; end if;
  end if;

  if v_user is null then
    -- Invitado. Un token de un carrito CON dueño no vale: ese carrito exige la
    -- sesion de su dueño y aqui no hay ninguna.
    if v_guest.id is not null and v_guest.user_id is null then
      update public.carts
         set last_activity_at = now()
       where id = v_guest.id;
      return ebim.cart_payload(v_guest.id, true);
    end if;

    insert into public.carts (
      organization_id, company_id, store_id, channel_id, currency, expires_at
    ) values (
      v_store.organization_id, v_store.company_id, v_store.id, v_channel.id,
      v_store.currency, now() + interval '2 hours'
    )
    returning * into v_cart;

    return ebim.cart_payload(v_cart.id, true);
  end if;

  -- Con sesion: su carrito activo de esta tienda y este canal, o uno nuevo.
  select * into v_cart
  from public.carts c
  where c.store_id   = v_store.id
    and c.channel_id = v_channel.id
    and c.user_id    = v_user
    and c.status     = 'active';

  if not found then
    insert into public.carts (
      organization_id, company_id, store_id, channel_id, user_id, currency, expires_at
    ) values (
      v_store.organization_id, v_store.company_id, v_store.id, v_channel.id, v_user,
      v_store.currency, now() + interval '30 days'
    )
    returning * into v_cart;
  end if;

  -- La fusion, si el invitado traia carrito.
  if v_guest.id is not null and v_guest.user_id is null and v_guest.id <> v_cart.id then
    perform ebim.merge_cart_lines(v_guest.id, v_cart.id);
    perform ebim.cart_refresh_prices(v_cart.id);
  end if;

  update public.carts
     set last_activity_at = now()
   where id = v_cart.id;

  return ebim.cart_payload(v_cart.id, true);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.cart_refresh_prices — reescribe los SNAPSHOTS.
--
-- Se llama cuando el comprador cambia el carrito, no cuando lo mira: si se
-- reescribiera al mirar, el aviso de "el precio cambio" se borraria a si mismo
-- antes de que nadie lo leyera.
-- ---------------------------------------------------------------------------
create or replace function ebim.cart_refresh_prices(p_cart_id uuid)
returns void
language plpgsql
set search_path = ''
as $fn$
declare
  v_cart  public.carts%rowtype;
  v_items jsonb;
  v_quote jsonb;
begin
  select * into v_cart from public.carts c where c.id = p_cart_id;
  if not found then return; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', i.product_id,
           'variant_id', i.variant_id,
           'uom_code',   i.uom_code,
           'quantity',   i.quantity
         )), '[]'::jsonb)
    into v_items
  from public.cart_items i
  where i.cart_id = v_cart.id;

  if jsonb_array_length(v_items) = 0 then return; end if;

  begin
    v_quote := ebim.build_quote(
      v_cart.store_id, v_cart.channel_id, v_items, null, null, now(), true);
  exception when others then
    -- Sin cotizacion no se escribe un snapshot: es preferible no tener cifra a
    -- tener una que no salio del motor.
    return;
  end;

  update public.cart_items i
     set unit_price_snapshot = (q.line ->> 'unit_price')::numeric,
         currency_snapshot   = v_quote ->> 'currency',
         quoted_at           = now()
    from jsonb_array_elements(v_quote -> 'lines') as q(line)
   where i.cart_id = v_cart.id
     and i.product_id = (q.line ->> 'product_id')::uuid
     and i.variant_id is not distinct from ebim.safe_uuid(q.line ->> 'variant_id')
     and i.uom_code   is not distinct from nullif(q.line ->> 'uom_code', '');
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.cart_replace_lines — el carrito entero de una vez.
--
-- Reemplaza y no parchea: el navegador ya tiene el carrito completo en la mano
-- y una API de "suma una unidad" obliga a resolver conflictos de concurrencia
-- que aqui no aportan nada. Lo que SI hace el servidor es validar cada linea
-- contra el catalogo real —publicada, del canal, con su variante y su unidad—
-- con los MISMOS codigos de error que `create_order`, para que el comprador no
-- descubra en la caja algo que ya se sabia en el carrito.
-- ---------------------------------------------------------------------------
create or replace function public.cart_replace_lines(
  p_store_slug text,
  p_token      text,
  p_lines      jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store    public.stores%rowtype;
  v_cart     public.carts%rowtype;
  v_scoped   boolean := false;
  v_item     jsonb;
  v_product  public.products%rowtype;
  v_variant  public.product_variants%rowtype;
  v_has_var  boolean;
  v_uom_code text;
  v_qty      integer;
  v_normalized jsonb;
begin
  v_store := ebim.active_store_by_slug(p_store_slug);
  v_cart  := ebim.cart_authorize(v_store.id, p_token);

  if v_cart.status <> 'active' then
    raise exception 'CARRITO_NO_VIGENTE: ese carrito ya se cerro'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'ITEMS_REQUERIDOS: hace falta una lista de lineas'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_lines) > 100 then
    raise exception 'ITEMS_EXCESIVOS: maximo 100 lineas por carrito'
      using errcode = '22023';
  end if;

  -- La misma lista negra de `create_order` y `ebim.build_quote`. Un carrito con
  -- precio dentro seria la primera pieza de un checkout que se cree el precio.
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as item,
         jsonb_object_keys(item) as k
    where k in ('price', 'unit_price', 'unit_price_snapshot', 'line_total',
                'subtotal', 'total', 'currency', 'discount',
                'organization_id', 'company_id', 'store_id', 'tenant_id',
                'order_id', 'cart_id', 'user_id', 'channel_id',
                'tax_rate', 'tax_total', 'tax_category_id',
                'segment_id', 'customer_id', 'price_list_id', 'price_source',
                'uom_id', 'uom_factor', 'factor', 'base_quantity', 'sku',
                'warehouse_id', 'reservation_id', 'level_id', 'stock', 'available')
  ) then
    raise exception 'CAMPO_NO_PERMITIDO: el precio, el canal, el tenant y el almacen los decide el servidor, no el carrito'
      using errcode = '22023';
  end if;

  select exists (
    select 1 from public.product_channels pc where pc.channel_id = v_cart.channel_id
  ) into v_scoped;

  -- Agrupacion por la TERNA, la misma de `create_order` y de `build_quote`.
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
    select (item ->> 'product_id')                                     as product_id,
           nullif(btrim(coalesce(item ->> 'variant_id', '')), '')      as variant_id,
           nullif(upper(btrim(coalesce(item ->> 'uom_code', ''))), '') as uom_code,
           sum((item ->> 'quantity')::numeric)::integer                as quantity
    from jsonb_array_elements(p_lines) as item
    group by 1, 2, 3
  ) grouped;

  delete from public.cart_items where cart_id = v_cart.id;

  for v_item in select * from jsonb_array_elements(v_normalized)
  loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'CANTIDAD_INVALIDA: la cantidad debe ser un entero mayor que cero'
        using errcode = '22023';
    end if;
    if v_qty > 10000 then
      raise exception 'CANTIDAD_INVALIDA: la cantidad maxima por linea es 10000'
        using errcode = '22023';
    end if;

    select * into v_product
    from public.products p
    where p.id = ebim.safe_uuid(v_item ->> 'product_id')
      and p.store_id = v_store.id
      and p.status = 'published'
      and p.published_at is not null
      and p.published_at <= now();

    if not found then
      raise exception 'PRODUCTO_NO_DISPONIBLE: %', coalesce(v_item ->> 'product_id', 'null')
        using errcode = '22023';
    end if;

    if v_scoped and not exists (
      select 1 from public.product_channels pc
      where pc.channel_id = v_cart.channel_id and pc.product_id = v_product.id
    ) then
      raise exception 'PRODUCTO_FUERA_DE_CANAL: % no esta a la venta en este canal', v_product.sku
        using errcode = '22023';
    end if;

    if v_product.currency <> v_store.currency then
      raise exception 'MONEDA_INCONSISTENTE: % esta en % y la tienda en %',
        v_product.sku, v_product.currency, v_store.currency
        using errcode = '22023';
    end if;

    v_has_var := (v_item ->> 'variant_id') is not null;

    if v_product.kind = 'variant' and not v_has_var then
      raise exception 'VARIANTE_REQUERIDA: % se vende por variante y el carrito no dice cual', v_product.sku
        using errcode = '22023';
    end if;
    if v_product.kind <> 'variant' and v_has_var then
      raise exception 'VARIANTE_NO_APLICA: % no tiene variantes', v_product.sku
        using errcode = '22023';
    end if;

    if v_has_var then
      select * into v_variant
      from public.product_variants pv
      where pv.id = ebim.safe_uuid(v_item ->> 'variant_id')
        and pv.product_id = v_product.id
        and pv.is_active;
      if not found then
        raise exception 'VARIANTE_NO_DISPONIBLE: %', coalesce(v_item ->> 'variant_id', 'null')
          using errcode = '22023';
      end if;
    end if;

    v_uom_code := v_item ->> 'uom_code';
    if v_uom_code is not null and not exists (
      select 1
      from public.product_uoms pu
      join public.units_of_measure u
        on u.id = pu.uom_id
       and u.organization_id = pu.organization_id
       and u.company_id      = pu.company_id
      where pu.product_id = v_product.id
        and upper(u.code) = v_uom_code
        and pu.is_sellable
        and u.is_active
    ) then
      raise exception 'UOM_NO_DISPONIBLE: % no se vende en la unidad %', v_product.sku, v_uom_code
        using errcode = '22023';
    end if;

    insert into public.cart_items (
      organization_id, company_id, store_id, cart_id,
      product_id, variant_id, uom_code, quantity
    ) values (
      v_cart.organization_id, v_cart.company_id, v_cart.store_id, v_cart.id,
      v_product.id,
      case when v_has_var then v_variant.id else null end,
      v_uom_code, v_qty
    );
  end loop;

  -- Un carrito con intencion de compra deja de ser el de un rastreador.
  update public.carts
     set last_activity_at = now(),
         expires_at = greatest(expires_at,
                               now() + case when user_id is null
                                            then interval '7 days'
                                            else interval '30 days' end)
   where id = v_cart.id;

  perform ebim.cart_refresh_prices(v_cart.id);

  return ebim.cart_payload(v_cart.id, false);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.cart_price_drift — que lineas valen ahora otra cosa.
--
-- ## Por que esta comparacion vive en el SERVIDOR y no en el navegador
--
-- Porque la alternativa era que el checkout aceptara del cliente una lista de
-- "esto es lo que yo creia que costaba", y eso es dinero saliendo del
-- navegador. Aunque no se cobre con ello —no se cobraria—, seria el primer
-- campo con un importe dentro de la peticion de compra, y el dia que alguien
-- añadiera el segundo ya no habria una regla que citar. Aqui no hay ninguno:
-- la referencia es `cart_items.unit_price_snapshot`, que lo escribio el motor
-- de precios cuando el comprador toco el carrito por ultima vez.
--
-- Devuelve QUE cambio y de cuanto a cuanto, para que la pantalla pueda decirlo
-- linea a linea en vez de soltar un "los precios cambiaron" que obliga a
-- comparar a mano.
--
-- Si el carrito no tiene snapshots —nunca se cotizo— la respuesta es una lista
-- vacia, y es lo correcto: sin referencia no hay cambio que detectar, y
-- inventarse una seria peor que no tenerla.
-- ---------------------------------------------------------------------------
create or replace function public.cart_price_drift(
  p_store_slug text,
  p_token      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store   public.stores%rowtype;
  v_cart    public.carts%rowtype;
  v_items   jsonb;
  v_quote   jsonb;
  v_changed jsonb := '[]'::jsonb;
begin
  v_store := ebim.active_store_by_slug(p_store_slug);
  v_cart  := ebim.cart_authorize(v_store.id, p_token);

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', i.product_id,
           'variant_id', i.variant_id,
           'uom_code',   i.uom_code,
           'quantity',   i.quantity
         )), '[]'::jsonb)
    into v_items
  from public.cart_items i
  where i.cart_id = v_cart.id;

  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('changed', '[]'::jsonb);
  end if;

  begin
    v_quote := ebim.build_quote(
      v_cart.store_id, v_cart.channel_id, v_items, null, null, now(), true);
  exception when others then
    -- No se pudo cotizar. Eso NO es "el precio cambio": es otro problema, y lo
    -- va a levantar la etapa de precios del pipeline con su propio codigo.
    return jsonb_build_object('changed', '[]'::jsonb);
  end;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', i.product_id,
           'variant_id', i.variant_id,
           'uom_code',   i.uom_code,
           'was',        i.unit_price_snapshot::text,
           'now',        q.line ->> 'unit_price')), '[]'::jsonb)
    into v_changed
  from public.cart_items i
  join jsonb_array_elements(v_quote -> 'lines') as q(line)
    on (q.line ->> 'product_id')::uuid = i.product_id
   and ebim.safe_uuid(q.line ->> 'variant_id') is not distinct from i.variant_id
   and nullif(q.line ->> 'uom_code', '') is not distinct from i.uom_code
  where i.cart_id = v_cart.id
    and i.unit_price_snapshot is not null
    and i.unit_price_snapshot <> (q.line ->> 'unit_price')::numeric;

  return jsonb_build_object('changed', v_changed);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.cart_abandon — cerrar el carrito a mano.
-- ---------------------------------------------------------------------------
create or replace function public.cart_abandon(
  p_store_slug text,
  p_token      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_cart  public.carts%rowtype;
begin
  v_store := ebim.active_store_by_slug(p_store_slug);
  v_cart  := ebim.cart_authorize(v_store.id, p_token);

  if v_cart.status = 'active' then
    update public.carts set status = 'abandoned' where id = v_cart.id;
  end if;

  return ebim.cart_payload(v_cart.id, false);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.expire_carts — el barrido explicito, para un planificador que no
-- tiene por que saber nada del dominio.
-- ---------------------------------------------------------------------------
create or replace function public.expire_carts()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return ebim.expire_due_carts(null);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Permisos
--
-- Las tres puertas del comprador son `anon` y `authenticated`: la autorizacion
-- vive DENTRO (token o sesion), que es la unica forma admitida de usar
-- `SECURITY DEFINER` en este repositorio. Las de dentro del esquema `ebim` no
-- las puede llamar nadie desde fuera.
-- ---------------------------------------------------------------------------
revoke execute on function
  ebim.public_channel(uuid),
  ebim.active_store_by_slug(text),
  ebim.expire_due_carts(uuid),
  ebim.cart_authorize(uuid, text),
  ebim.cart_payload(uuid, boolean),
  ebim.cart_refresh_prices(uuid),
  ebim.merge_cart_lines(uuid, uuid)
from public, anon, authenticated;

revoke execute on function public.cart_open(text, text)                    from public;
revoke execute on function public.cart_replace_lines(text, text, jsonb)    from public;
revoke execute on function public.cart_abandon(text, text)                 from public;
revoke execute on function public.cart_price_drift(text, text)             from public;
revoke execute on function public.expire_carts()                           from public, anon, authenticated;

-- `ebim.merge_cart_lines` SI se concede al servidor, y solo a el: sus tres
-- reglas —solo carritos sin dueño, mismo canal, maximo y no suma— son su
-- autorizacion, y hay un test que las compra llamandola directamente. Lo que no
-- puede es ser alcanzable desde el navegador, porque ahi el `cart_id` seria un
-- id declarado por el cliente.
grant execute on function ebim.merge_cart_lines(uuid, uuid)            to service_role;

grant execute on function public.cart_open(text, text)                 to anon, authenticated, service_role;
grant execute on function public.cart_replace_lines(text, text, jsonb) to anon, authenticated, service_role;
grant execute on function public.cart_abandon(text, text)              to anon, authenticated, service_role;
grant execute on function public.cart_price_drift(text, text)          to anon, authenticated, service_role;
grant execute on function public.expire_carts()                        to service_role;

comment on function public.cart_open(text, text) is
  'Abre o recupera el carrito de quien llama: con sesion el suyo, sin sesion el del token. Un token de invitado presentado CON sesion fusiona ese carrito en el del usuario.';
comment on function public.cart_replace_lines(text, text, jsonb) is
  'Reemplaza las lineas validandolas contra el catalogo con los mismos codigos que create_order. El precio no viaja: se resuelve y se guarda solo como snapshot informativo.';
comment on function public.cart_price_drift(text, text) is
  'Que lineas del carrito valen ahora otra cosa, comparando el snapshot que escribio el motor con la cotizacion vigente. La comparacion es del servidor: asi no hace falta que el navegador mande ningun importe.';
comment on function ebim.merge_cart_lines(uuid, uuid) is
  'Fusion invitado -> usuario. Solo absorbe carritos sin dueño, exige mismo canal y toma el MAXIMO de cada linea: sumar inventaria unidades que nadie eligio.';
