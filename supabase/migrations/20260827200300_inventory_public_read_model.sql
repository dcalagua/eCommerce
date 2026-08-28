-- =============================================================================
-- P06-SaaS · La vitrina deja de leer una columna y pasa a preguntar
--
-- `products.in_stock` y `product_variants.in_stock` son columnas generadas
-- (`stock > 0`) y siguen siendo correctas para el tenant que nunca abra la
-- pantalla de almacenes. Para el que la abra dejan de serlo: la existencia esta
-- repartida entre almacenes, una parte esta comprometida por carritos vivos y
-- otra apartada como colchon. Si el semaforo siguiera saliendo de la columna,
-- la tienda anunciaria como disponible lo que ya vendio a otro y esconderia lo
-- que tiene en el otro almacen.
--
-- El mismo movimiento que P03-SaaS hizo con el kit —de columna a pregunta— y
-- que P04-SaaS hizo con el precio. La respuesta la da `ebim.atp`, y la pregunta
-- entra por una funcion `SECURITY DEFINER` con su autorizacion dentro, porque
-- `anon` no tiene —ni tendra— un solo GRANT sobre `inventory_levels`.
--
-- ## Lo que sale y lo que no
--
-- Sale un BOOLEANO. No sale la cifra, no sale de que almacen, no sale si hay
-- una reserva viva. La existencia exacta es informacion competitiva del tenant
-- y ademas cambia cada segundo; publicarla seria dar un dato que envejece antes
-- de llegar al navegador.
--
-- ## "No se sabe" se anuncia, no se esconde
--
-- Cuando un almacen con sistema de registro externo tiene la cifra caducada y
-- politica `unknown`, el producto **sigue apareciendo disponible en la vitrina**
-- y es el checkout el que se niega (`DISPONIBILIDAD_DESCONOCIDA`). Es la
-- decision incomoda de la fase y esta razonada: tratar «no se sabe» como cero
-- vaciaria el catalogo entero durante una caida ajena —el escenario que el
-- puerto describe desde P01—, y el comprador se encontraria una tienda sin
-- productos en vez de un producto que hoy no se puede confirmar. Se pierde un
-- carrito; no se pierde la tienda.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.product_is_available — el semaforo de una referencia concreta.
--
-- `SECURITY DEFINER` con la autorizacion DENTRO, exactamente como
-- `ebim.bundle_is_available` (170100): solo responde por un producto que el que
-- pregunta YA podia ver —publicado, con fecha, en tienda activa—. Para
-- cualquier otro uuid devuelve `false` sin mirar nada. De aqui no se puede
-- sacar una cantidad, ni un almacen, ni un tenant: la respuesta es un booleano
-- sobre algo publico.
--
-- Coste: una llamada por fila de la vitrina, igual que `bundle_is_available`
-- desde P03. Para el tenant sin almacenes el camino corto de `ebim.atp` es una
-- lectura de la columna de siempre. **Disparador para materializarlo:** el dia
-- que la vitrina pagine sobre decenas de miles de referencias (P11).
-- ---------------------------------------------------------------------------
create or replace function ebim.product_is_available(
  p_product_id uuid,
  p_variant_id uuid default null,
  p_quantity   numeric default 1
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store uuid;
  v_atp   jsonb;
begin
  select p.store_id into v_store
  from public.products p
  join public.stores s on s.id = p.store_id
  where p.id = p_product_id
    and p.status = 'published'
    and p.published_at is not null
    and p.published_at <= now()
    and s.status = 'active';

  if not found then return false; end if;

  if p_variant_id is not null and not exists (
    select 1 from public.product_variants pv
    where pv.id = p_variant_id and pv.product_id = p_product_id and pv.is_active
  ) then
    return false;
  end if;

  v_atp := ebim.atp(v_store, p_product_id, p_variant_id);

  return coalesce((v_atp ->> 'backorder')::boolean, false)
      or coalesce((v_atp ->> 'unknown')::boolean, false)
      or coalesce((v_atp ->> 'available')::numeric, 0) >= coalesce(p_quantity, 1);
end;
$fn$;

revoke execute on function ebim.product_is_available(uuid, uuid, numeric) from public;
grant  execute on function ebim.product_is_available(uuid, uuid, numeric)
  to anon, authenticated, service_role;

comment on function ebim.product_is_available(uuid, uuid, numeric) is
  'Semaforo de una referencia publica. DEFINER con autorizacion dentro: solo responde por producto publicado de tienda activa, y solo un booleano.';

-- ---------------------------------------------------------------------------
-- ebim.bundle_is_available — el kit, ahora contra el ATP de sus componentes.
--
-- Misma firma, misma autorizacion, misma respuesta para el tenant sin
-- almacenes. Lo que cambia es de donde sale la existencia del componente.
--
-- Los dos casos que hacen INARMABLE un kit —sin componentes, o con un
-- componente en una unidad sin configurar— se comprueban antes de preguntar,
-- porque `ebim.expand_stock_lines` levanta excepcion en ambos y una excepcion
-- dentro de una vista tumbaria la consulta entera de la vitrina, no una fila.
-- ---------------------------------------------------------------------------
create or replace function ebim.bundle_is_available(p_bundle_product_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store uuid;
  v_atp   jsonb;
begin
  select p.store_id into v_store
  from public.products p
  join public.stores s on s.id = p.store_id
  where p.id = p_bundle_product_id
    and p.kind = 'bundle'
    and p.status = 'published'
    and p.published_at is not null
    and p.published_at <= now()
    and s.status = 'active';

  if not found then return false; end if;

  -- Un kit sin componentes no se puede armar.
  if not exists (
    select 1 from public.bundle_items bi where bi.bundle_product_id = p_bundle_product_id
  ) then
    return false;
  end if;

  -- Cantidad expresada en una unidad que el componente no tiene configurada: no
  -- se sabe cuanto hace falta, asi que no se promete.
  if exists (
    select 1
    from public.bundle_items bi
    left join public.product_uoms pu
      on pu.product_id = bi.component_product_id and pu.uom_id = bi.uom_id
    where bi.bundle_product_id = p_bundle_product_id
      and bi.uom_id is not null
      and pu.factor is null
  ) then
    return false;
  end if;

  v_atp := ebim.atp(v_store, p_bundle_product_id, null);

  return coalesce((v_atp ->> 'backorder')::boolean, false)
      or coalesce((v_atp ->> 'unknown')::boolean, false)
      or coalesce((v_atp ->> 'available')::numeric, 0) > 0;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public_products — se recrea porque `in_stock` cambia de ORIGEN.
--
-- Ni una columna mas, ni una menos, ni un significado distinto: el precio sigue
-- saliendo del motor de P04 y la disponibilidad sigue siendo un booleano por
-- tipo de producto. Lo unico que cambia es que la existencia del producto
-- simple y la de cada variante ya no se leen de una columna.
-- ---------------------------------------------------------------------------
drop view if exists public.public_products;

create view public.public_products
with (security_invoker = on) as
select
  p.id            as product_id,
  p.store_id,
  p.category_id,
  p.slug,
  p.name,
  p.description,
  coalesce(up.unit_price, p.price) as price,
  case when up.unit_price is null then p.compare_at_price else up.compare_at_price end
                  as compare_at_price,
  p.currency,
  p.published_at,
  p.custom_fields,
  p.kind,
  b.name          as brand_name,
  case p.kind
    when 'variant' then coalesce(v.any_available, false)
    when 'bundle'  then ebim.bundle_is_available(p.id)
    else ebim.product_is_available(p.id, null, 1)
  end             as in_stock,
  coalesce(v.variant_count, 0) as variant_count,
  coalesce(v.min_price, up.unit_price, p.price) as price_from,
  c.slug          as category_slug,
  c.name          as category_name,
  img.storage_path as primary_image_path,
  img.alt          as primary_image_alt
from public.products p
left join public.categories c
  on c.id = p.category_id
 and c.store_id = p.store_id
 and c.is_active
left join public.brands b
  on b.id = p.brand_id
left join ebim.public_unit_prices up
  on up.product_id = p.id
 and up.variant_id is null
left join lateral (
  select count(*)::int as variant_count,
         bool_or(ebim.product_is_available(pv.product_id, pv.id, 1)) as any_available,
         min(coalesce(vup.unit_price, pv.price, p.price)) as min_price
  from public.product_variants pv
  left join ebim.public_unit_prices vup on vup.variant_id = pv.id
  where pv.product_id = p.id
    and pv.is_active
) v on true
left join lateral (
  select i.storage_path, i.alt
  from public.product_images i
  where i.product_id = p.id
  order by i.is_primary desc, i.position asc
  limit 1
) img on true
where p.status = 'published'
  and p.published_at is not null
  and p.published_at <= now();

-- ---------------------------------------------------------------------------
-- public_product_variants — idem: `in_stock` pasa a ser la pregunta.
-- ---------------------------------------------------------------------------
drop view if exists public.public_product_variants;

create view public.public_product_variants
with (security_invoker = on) as
select
  v.id            as variant_id,
  v.product_id,
  v.store_id,
  v.name,
  v.position,
  v.is_default,
  ebim.product_is_available(v.product_id, v.id, 1) as in_stock,
  coalesce(up.unit_price, v.price, p.price) as price,
  case
    when up.unit_price is not null then up.compare_at_price
    when v.price is null           then p.compare_at_price
    else v.compare_at_price
  end             as compare_at_price,
  p.currency
from public.product_variants v
join public.products p
  on p.id = v.product_id
 and p.store_id = v.store_id
left join ebim.public_unit_prices up
  on up.variant_id = v.id
where v.is_active;

revoke all on public.public_products         from public;
revoke all on public.public_product_variants from public;

grant select on public.public_products         to anon, authenticated, service_role;
grant select on public.public_product_variants to anon, authenticated, service_role;

comment on view public.public_products is
  'Producto publicado de tienda activa. `price` sale del motor de precios; `in_stock` del ATP por almacen, o de la columna de catalogo si la tienda no tiene almacenes.';
comment on view public.public_product_variants is
  'Variantes vendibles con precio resuelto y semaforo por ATP. Sin SKU ni existencia exacta.';

-- ---------------------------------------------------------------------------
-- public.availability_for_slug — la puerta ANONIMA de disponibilidad.
--
-- Hermana de `price_quote_for_slug` (180100): la vitrina pregunta por el slug
-- publico de la URL y el servidor resuelve la tienda. Sirve para lo que el
-- semaforo de la tarjeta no puede responder —«¿me puedo llevar 12?»— sin que la
-- respuesta lleve dentro cuantos hay.
--
-- Lo que devuelve por linea: `in_stock` para la cantidad pedida, `unknown` y
-- `source`. **`available` no existe en esta respuesta**: no es que valga null,
-- es que la cifra no sale a `anon` en ninguna circunstancia. El backoffice
-- tiene su propia puerta (`inventory_availability`) y ahi si sale.
-- ---------------------------------------------------------------------------
create or replace function public.availability_for_slug(
  p_store_slug text,
  p_items      jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store_id uuid;
  v_slug     text := lower(btrim(coalesce(p_store_slug, '')));
  v_item     jsonb;
  v_product  uuid;
  v_variant  uuid;
  v_qty      numeric;
  v_atp      jsonb;
  v_visible  boolean;
  v_out      jsonb := '[]'::jsonb;
begin
  if v_slug = '' then
    raise exception 'TIENDA_NO_DISPONIBLE: falta la tienda' using errcode = '22023';
  end if;

  select s.id into v_store_id
  from public.stores s
  where lower(s.slug) = v_slug and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'ITEMS_REQUERIDOS: hace falta una lista de referencias' using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > 100 then
    raise exception 'ITEMS_EXCESIVOS: maximo 100 lineas por consulta' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product := ebim.safe_uuid(v_item ->> 'product_id');
    v_variant := ebim.safe_uuid(v_item ->> 'variant_id');
    v_qty     := greatest(coalesce((v_item ->> 'quantity')::numeric, 1), 1);

    -- La misma autorizacion que el semaforo: solo se responde por producto
    -- publicado de esta tienda activa. Un uuid de otra tienda no revela nada.
    select exists (
      select 1 from public.products p
      where p.id = v_product
        and p.store_id = v_store_id
        and p.status = 'published'
        and p.published_at is not null
        and p.published_at <= now()
    ) into v_visible;

    if not v_visible then
      v_out := v_out || jsonb_build_object(
        'product_id', v_item ->> 'product_id',
        'variant_id', v_item ->> 'variant_id',
        'quantity',   v_qty,
        'in_stock',   false,
        'unknown',    false,
        'source',     'catalog');
      continue;
    end if;

    v_atp := ebim.atp(v_store_id, v_product, v_variant);

    v_out := v_out || jsonb_build_object(
      'product_id', v_item ->> 'product_id',
      'variant_id', v_item ->> 'variant_id',
      'quantity',   v_qty,
      'in_stock',   coalesce((v_atp ->> 'backorder')::boolean, false)
                    or coalesce((v_atp ->> 'unknown')::boolean, false)
                    or coalesce((v_atp ->> 'available')::numeric, 0) >= v_qty,
      'unknown',    coalesce((v_atp ->> 'unknown')::boolean, false),
      'source',     v_atp ->> 'source');
  end loop;

  return v_out;
end;
$fn$;

revoke execute on function public.availability_for_slug(text, jsonb) from public;
grant  execute on function public.availability_for_slug(text, jsonb)
  to anon, authenticated, service_role;

comment on function public.availability_for_slug(text, jsonb) is
  'Disponibilidad para el comprador anonimo: semaforo por cantidad, sin cifra. La tienda la resuelve el servidor por slug.';
