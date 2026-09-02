-- =============================================================================
-- P18 · La linea del carrito del servidor devuelve su foto.
--
-- ## El fallo
--
-- `ebim.cart_payload` devolvia nombre, precio y disponibilidad, pero no la
-- imagen. El navegador la ponia de su copia local (`local?.image_path ?? null`
-- en `cart/cart.ts`), y eso funciona mientras el carrito local exista.
--
-- Con SESION INICIADA no existe: el carrito del servidor manda entero, se
-- reconstruye desde el, y cada linea se quedaba sin foto. Resultado: quien
-- entra a su cuenta ve un cajon de carrito lleno de cuadros grises, con los
-- productos bien y las miniaturas vacias. Tambien pasaba al recuperar un
-- carrito por su token desde otro dispositivo.
--
-- ## Por que se arregla aqui y no en el navegador
--
-- Porque el carrito del servidor es la fuente de verdad de esas lineas. Taparlo
-- en el cliente —buscar cada producto del carrito en el catalogo para sacarle la
-- foto— seria una consulta mas por cada apertura del cajon para recuperar un
-- dato que el servidor ya tiene delante mientras construye la respuesta.
--
-- Es un campo mas en un objeto que ya viajaba. No cambia ninguna regla: ni
-- precio, ni impuesto, ni disponibilidad, ni quien puede leer que.
-- =============================================================================

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
           v.name as variant_name, img.storage_path as image_path
    from public.cart_items i
    join public.products p on p.id = i.product_id
    left join public.product_variants v on v.id = i.variant_id
    -- La foto, con la MISMA regla que `public_products`: la marcada como
    -- principal y, a igualdad, la primera por posicion. Dos sitios que eligen
    -- la foto de un producto con criterios distintos acaban ensenando dos
    -- fotos distintas del mismo producto en la misma pagina.
    left join lateral (
      select pi.storage_path
      from public.product_images pi
      where pi.product_id = i.product_id
      order by pi.is_primary desc, pi.position asc
      limit 1
    ) img on true
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
      -- La RUTA del bucket, nunca una URL: la firma cada lado con su cliente,
      -- igual que la foto del catalogo desde P04.
      'image_path',   v_row.image_path,
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
