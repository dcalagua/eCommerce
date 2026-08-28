-- =============================================================================
-- P03-SaaS · La vitrina aprende a leer variantes y kits
--
-- Con el PIM, `products.in_stock` (columna generada `stock > 0`) deja de ser la
-- verdad para dos de los tres tipos de producto:
--
--   · un maestro de VARIANTES no tiene existencia propia — la tienen sus
--     variantes, y el maestro puede estar a cero mientras la talla M sobra;
--   · un KIT tampoco — su disponibilidad es la de sus componentes.
--
-- Si `public_products.in_stock` siguiera saliendo de la columna generada, el
-- filtro "solo disponibles" de la vitrina escondaria camisetas que hay en
-- almacen y anunciaria packs que no se pueden armar. Por eso la vista pasa a
-- calcularla POR TIPO. `products.in_stock` se queda: es correcta para el
-- producto simple, que es lo que sigue siendo la mayoria del catalogo, y hay
-- un indice parcial que la usa.
--
-- Todo sigue siendo `security_invoker`: estas vistas no amplian ni un permiso.
-- Lo unico que necesita ayuda es la existencia del kit, y se explica abajo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.bundle_is_available — la unica pieza que NO puede ser invoker.
--
-- Un componente de kit normalmente NO esta publicado por su cuenta: el pack se
-- anuncia, sus piezas no. Un comprador anonimo no ve esas filas —y hace bien—,
-- asi que una vista invoker calcularia "kit sin componentes visibles" = no
-- disponible para TODOS los kits. Seria un fallo silencioso: el catalogo
-- publicado se veria correcto y los packs simplemente no se venderian.
--
-- Por eso es SECURITY DEFINER, y por eso lleva su autorizacion DENTRO (regla
-- del repo y leccion esupplier-030): solo responde por un kit que ya es
-- publicamente visible —publicado, con fecha, en tienda activa—. Para
-- cualquier otro uuid devuelve `false` sin mirar nada. No hay forma de sacar de
-- aqui una existencia, un tenant ni un componente: la respuesta es un booleano
-- sobre algo que el que pregunta ya podia ver.
-- ---------------------------------------------------------------------------
create or replace function ebim.bundle_is_available(p_bundle_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select case
    when not exists (
      select 1
      from public.products p
      join public.stores s on s.id = p.store_id
      where p.id = p_bundle_product_id
        and p.kind = 'bundle'
        and p.status = 'published'
        and p.published_at is not null
        and p.published_at <= now()
        and s.status = 'active'
    ) then false
    else coalesce(
      (
        select bool_and(
          case
            -- Cantidad expresada en una UoM que el componente no tiene
            -- configurada: no se sabe cuanto hace falta, asi que no se promete.
            when bi.uom_id is not null and pu.factor is null then false
            else
              case when bi.component_variant_id is not null
                   then coalesce(cv.stock, 0)
                   else coalesce(cp.stock, 0)
              end >= bi.quantity * coalesce(pu.factor, 1)
          end
        )
        from public.bundle_items bi
        left join public.products         cp on cp.id = bi.component_product_id
        left join public.product_variants cv on cv.id = bi.component_variant_id
        left join public.product_uoms     pu on pu.product_id = bi.component_product_id
                                            and pu.uom_id     = bi.uom_id
        where bi.bundle_product_id = p_bundle_product_id
      ),
      -- `bool_and` sobre cero filas es NULL: un kit sin componentes no se
      -- puede armar, asi que no esta disponible.
      false
    )
  end;
$fn$;

revoke execute on function ebim.bundle_is_available(uuid) from public;
grant  execute on function ebim.bundle_is_available(uuid) to anon, authenticated, service_role;

comment on function ebim.bundle_is_available(uuid) is
  'Disponibilidad de un kit por sus componentes. DEFINER con autorizacion dentro: solo responde por kits ya publicos.';

-- ---------------------------------------------------------------------------
-- public_products — se recrea porque cambia de columnas.
--
-- Nuevo: `kind`, `brand_name`, `variant_count` y `price_from`. `in_stock` pasa
-- a depender del tipo. `price` NO cambia de significado para el producto
-- simple; en un maestro de variantes es el precio base que heredan las
-- variantes sin precio propio, y `price_from` es el minimo real de la vitrina.
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
  p.price,
  p.compare_at_price,
  p.currency,
  p.published_at,
  p.custom_fields,
  p.kind,
  b.name          as brand_name,
  case p.kind
    when 'variant' then coalesce(v.any_available, false)
    when 'bundle'  then ebim.bundle_is_available(p.id)
    else p.in_stock
  end             as in_stock,
  coalesce(v.variant_count, 0) as variant_count,
  -- "desde": con variantes, el precio que ve el comprador en la tarjeta es el
  -- mas barato que puede pagar, no el del maestro.
  coalesce(v.min_price, p.price) as price_from,
  c.slug          as category_slug,
  c.name          as category_name,
  img.storage_path as primary_image_path,
  img.alt          as primary_image_alt
from public.products p
left join public.categories c
  on c.id = p.category_id
 and c.store_id = p.store_id
 and c.is_active
-- La marca solo aparece si `anon` puede verla (policy `brands_select_public`).
-- Un LEFT JOIN degrada a NULL en vez de esconder el producto.
left join public.brands b
  on b.id = p.brand_id
left join lateral (
  select count(*)::int             as variant_count,
         bool_or(pv.in_stock)      as any_available,
         min(coalesce(pv.price, p.price)) as min_price
  from public.product_variants pv
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
-- public_product_variants — lo que el comprador elige en la ficha.
--
-- El precio se resuelve aqui y no en el navegador: `coalesce(v.price, p.price)`
-- es la misma herencia que aplica `create_order`, y tenerla escrita dos veces
-- en dos lenguajes distintos es como acaba costando distinto de lo que decia.
-- `compare_at_price` NO se hereda cuando la variante tiene precio propio: el
-- tachado del maestro sobre un precio de variante anuncia un descuento que no
-- existe.
-- ---------------------------------------------------------------------------
create view public.public_product_variants
with (security_invoker = on) as
select
  v.id            as variant_id,
  v.product_id,
  v.store_id,
  v.name,
  v.position,
  v.is_default,
  v.in_stock,
  coalesce(v.price, p.price) as price,
  case when v.price is null then p.compare_at_price else v.compare_at_price end
                  as compare_at_price,
  p.currency
from public.product_variants v
join public.products p
  on p.id = v.product_id
 and p.store_id = v.store_id
where v.is_active;

-- ---------------------------------------------------------------------------
-- Lo que NO se publica en esta fase, y por que.
--
-- No hay vista publica de la COMPOSICION del kit. Se escribio y se retiro: los
-- componentes de un pack normalmente no estan publicados por separado, asi que
-- una vista `security_invoker` los habria dejado fuera y el pack se anunciaria
-- "vacio" — peor que no anunciarlo. Hacerlo bien exige otra funcion DEFINER con
-- su propia autorizacion, y eso es superficie de vitrina (P11), no PIM. Aqui la
-- unica pregunta publica sobre el kit es si se puede comprar, que ya responde
-- `ebim.bundle_is_available`.
--
-- Tampoco salen los atributos: filtrar por faceta en la vitrina necesita UI de
-- facetas, y el modelo ya queda indexado para cuando la haya
-- (`product_attribute_values_filter`).
-- ---------------------------------------------------------------------------

revoke all on public.public_products         from public;
revoke all on public.public_product_variants from public;

grant select on public.public_products         to anon, authenticated, service_role;
grant select on public.public_product_variants to anon, authenticated, service_role;

comment on view public.public_products is
  'Producto publicado de tienda activa. `in_stock` se calcula por tipo: simple, por variantes o por componentes del kit.';
comment on view public.public_product_variants is
  'Variantes vendibles de un producto publicado. Sin SKU ni existencia exacta: el comprador ve precio y semaforo.';
