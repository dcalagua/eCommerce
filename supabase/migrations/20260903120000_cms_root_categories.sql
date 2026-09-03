-- ---------------------------------------------------------------------------
-- La portada se llena sola: `category_collection` en la raiz
-- ---------------------------------------------------------------------------
--
-- Sintoma: se anaden familias al catalogo, salen en la barra de la cabecera
-- —que lee el arbol entero— y NO salen en la seccion de la portada, que leia
-- solo los items elegidos a mano en el CMS. Desde fuera parece codigo fijo.
--
-- `ebim.content_block_items_json` se reescribe entera porque es `create or
-- replace` y no hay forma de anadir un CTE por partes. Lo unico que cambia es
-- el CTE `auto_root_categories` y su `union all`; el resto es la definicion
-- viva, copiada tal cual.
--
-- Lo que NO cambia, y es deliberado: la curacion manual sigue ganando. Un
-- comercio que eligio tres familias a dedo las conserva; el automatico es para
-- quien no ha elegido ninguna. Es la misma regla que ya seguian
-- `auto_products` y `auto_categories`.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ebim.content_block_items_json(p_block content_blocks)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with manual as (
    select i.item_kind, i.product_id, i.variant_id, i.category_id, i.position,
           i.media_url, i.media_alt, i.href
    from public.content_block_items i
    where i.block_id = p_block.id
    order by i.position, i.id
    limit p_block.item_limit
  ),
  has_manual as (select exists (select 1 from manual) as yes),
  -- Automatica por categoria, solo si no hay curacion manual.
  auto_products as (
    select 'product'::public.content_item_kind as item_kind,
           pp.product_id, null::uuid as variant_id, null::uuid as category_id,
           row_number() over (order by pp.published_at desc, pp.product_id)::int as position,
           null::text as media_url, null::text as media_alt, null::text as href
    from public.public_products pp
    where p_block.category_id is not null
      and p_block.block_type in ('product_collection', 'carousel')
      and not (select yes from has_manual)
      and pp.store_id = p_block.store_id
      -- P18 · Con `descendants` encendido, la coleccion incluye lo que cuelga
      -- de la categoria. Apagado por defecto: un bloque publicado no cambia de
      -- contenido porque alguien anada una subcategoria manana.
      and (
        case when coalesce((p_block.settings ->> 'descendants')::boolean, false)
          then pp.category_id in (
            select category_id from ebim.category_subtree(p_block.category_id))
          else pp.category_id = p_block.category_id
        end
      )
    order by pp.published_at desc, pp.product_id
    limit p_block.item_limit
  ),
  auto_categories as (
    select 'category'::public.content_item_kind as item_kind,
           null::uuid as product_id, null::uuid as variant_id, pc.category_id,
           row_number() over (order by pc.position, pc.name)::int as position,
           null::text as media_url, null::text as media_alt, null::text as href
    from public.public_categories pc
    where p_block.category_id is not null
      and p_block.block_type = 'category_collection'
      and not (select yes from has_manual)
      and pc.store_id = p_block.store_id
      and pc.parent_id = p_block.category_id
    order by pc.position, pc.name
    limit p_block.item_limit
  ),
  -- Raiz automatica: un `category_collection` SIN categoria madre y sin
  -- curacion manual enseña las familias de primer nivel, y las enseña todas.
  --
  -- Antes ese caso no daba nada: `auto_categories` exige
  -- `p_block.category_id is not null` porque resuelve las HIJAS de una madre, y
  -- en la raiz no hay madre que apuntar. El unico modo de tener portada era
  -- elegir las familias a mano, asi que anadir una categoria al catalogo no la
  -- ponia en la portada — habia que acordarse de volver al CMS.
  --
  -- Sigue mandando la curacion: con items elegidos a mano, esto no se activa.
  auto_root_categories as (
    select 'category'::public.content_item_kind as item_kind,
           null::uuid as product_id, null::uuid as variant_id, pc.category_id,
           row_number() over (order by pc.position, pc.name)::int as position,
           null::text as media_url, null::text as media_alt, null::text as href
    from public.public_categories pc
    where p_block.category_id is null
      and p_block.block_type = 'category_collection'
      and not (select yes from has_manual)
      and pc.store_id = p_block.store_id
      and pc.parent_id is null
    order by pc.position, pc.name
    limit p_block.item_limit
  ),
  chosen as (
    select * from manual
    union all select * from auto_products
    union all select * from auto_categories
    union all select * from auto_root_categories
  )
  select coalesce(
    jsonb_agg(resolved.item order by resolved.position) filter (where resolved.item is not null),
    '[]'::jsonb
  )
  from (
    select c.position, case c.item_kind
      when 'product' then (
        select jsonb_build_object(
          'kind',       'product',
          'product_id', pp.product_id,
          'slug',       pp.slug,
          'name',       pp.name,
          'brand_name', pp.brand_name,
          -- El importe sale como TEXTO: el centimo no pasa por el float del
          -- navegador (regla de dinero del repositorio desde P02).
          'price',      pp.price::text,
          'compare_at_price', pp.compare_at_price::text,
          'price_from', pp.price_from::text,
          'currency',   pp.currency,
          'in_stock',   pp.in_stock,
          'image_path', pp.primary_image_path,
          'image_alt',  pp.primary_image_alt
        )
        from public.public_products pp
        where pp.product_id = c.product_id and pp.store_id = p_block.store_id
      )
      when 'variant' then (
        select jsonb_build_object(
          'kind',       'variant',
          'product_id', pv.product_id,
          'variant_id', pv.variant_id,
          'slug',       pp.slug,
          'name',       pp.name,
          'variant_label', pv.name,
          'price',      pv.price::text,
          'compare_at_price', pv.compare_at_price::text,
          'currency',   pv.currency,
          'in_stock',   pv.in_stock,
          'image_path', pp.primary_image_path,
          'image_alt',  pp.primary_image_alt
        )
        from public.public_product_variants pv
        join public.public_products pp
          on pp.product_id = pv.product_id and pp.store_id = p_block.store_id
        where pv.variant_id = c.variant_id
      )
      when 'media' then jsonb_build_object(
        'kind',       'media',
        -- La RUTA del objeto, no una URL: el bucket es privado y firma cada
        -- lado con su propio cliente (misma regla que el logo desde P07).
        'image_path', c.media_url,
        'image_alt',  coalesce(c.media_alt, ''),
        -- El destino ya paso `ebim.is_safe_href` al guardarse; la vitrina lo
        -- vuelve a comprobar en el borde, que es donde entra al DOM.
        'href',       c.href
      )
      else (
        select jsonb_build_object(
          'kind',     'category',
          'category_id', pc.category_id,
          'slug',     pc.slug,
          'name',     pc.name
        )
        from public.public_categories pc
        where pc.category_id = c.category_id and pc.store_id = p_block.store_id
      )
    end as item
    from chosen c
  ) resolved;
$function$
;
