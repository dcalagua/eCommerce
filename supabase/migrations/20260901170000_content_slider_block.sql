-- =============================================================================
-- P18 · Carrusel de imagenes (2 de 2): la diapositiva.
--
-- El bloque `slider` ensena IMAGENES que rotan, y cada diapositiva es una fila
-- de `content_block_items` con `item_kind = 'media'`. Se reutiliza esa tabla y
-- no una nueva porque una diapositiva es exactamente lo que esa tabla ya
-- modela: algo que pertenece a un bloque, tiene ORDEN y se borra con el. Lo
-- unico que le faltaba es que el item pudiera no apuntar a otra fila.
--
-- Tres columnas y ni una mas:
--   · `media_url` — la RUTA en el bucket privado, nunca una URL. Igual que el
--     logo desde P07: quien firma es cada lado con su cliente.
--   · `media_alt` — lo que lee quien no ve la imagen. En un carrusel de portada
--     no es opcional de verdad: es el unico texto que tiene la diapositiva.
--   · `href`      — a donde lleva, si lleva. Pasa por `ebim.is_safe_href`, la
--     misma lista blanca que el boton de un bloque y que los enlaces del texto
--     enriquecido.
--
-- Sin titulo ni subtitulo por diapositiva a proposito: un texto encima de una
-- imagen que el comercio no controla se lee mal en la mitad de las pantallas.
-- Si hace falta decir algo, se dice EN la imagen, que es donde el disenador
-- puede colocarlo.
-- =============================================================================

alter table public.content_block_items
  add column if not exists media_url text,
  add column if not exists media_alt text,
  add column if not exists href      text;

-- ---------------------------------------------------------------------------
-- Los CHECK, rehechos: los tres hablaban de tres clases de item y ahora son
-- cuatro. Se sustituyen enteros en vez de anadir uno nuevo al lado, porque dos
-- reglas que dicen cosas distintas sobre lo mismo acaban discrepando.
-- ---------------------------------------------------------------------------
alter table public.content_block_items
  drop constraint if exists content_block_items_target;
alter table public.content_block_items
  add constraint content_block_items_target check (
       (item_kind = 'product'  and product_id is not null and variant_id is null
                               and category_id is null and media_url is null)
    or (item_kind = 'variant'  and product_id is not null and variant_id is not null
                               and category_id is null and media_url is null)
    or (item_kind = 'category' and category_id is not null and product_id is null
                               and variant_id is null and media_url is null)
    -- La diapositiva no apunta a ninguna fila del catalogo: se sostiene sola.
    or (item_kind = 'media'    and media_url is not null and product_id is null
                               and variant_id is null and category_id is null)
  );

alter table public.content_block_items
  drop constraint if exists content_block_items_block_kind;
alter table public.content_block_items
  add constraint content_block_items_block_kind
    check (block_type in ('product_collection', 'category_collection', 'carousel', 'slider'));

alter table public.content_block_items
  drop constraint if exists content_block_items_kind_matches_block;
alter table public.content_block_items
  add constraint content_block_items_kind_matches_block check (
    (block_type = 'category_collection' and item_kind = 'category')
    or (block_type in ('product_collection', 'carousel') and item_kind in ('product', 'variant'))
    -- Y el carrusel de imagenes solo lleva imagenes: un producto ahi seria una
    -- diapositiva que nadie sabe pintar.
    or (block_type = 'slider' and item_kind = 'media')
  );

-- Contenido de la diapositiva: mismos topes y misma lista blanca de enlaces que
-- el resto del CMS.
alter table public.content_block_items
  drop constraint if exists content_block_items_media_shape;
alter table public.content_block_items
  add constraint content_block_items_media_shape check (
    (media_url is null or char_length(media_url) between 1 and 400)
    and (media_alt is null or char_length(media_alt) between 1 and 200)
    and (href is null or ebim.is_safe_href(href))
  );

-- ---------------------------------------------------------------------------
-- La forma del bloque. El `case` original no tenia `else`, asi que un tipo
-- nuevo devolvia NULL — y un CHECK que recibe NULL PASA: el `slider` habria
-- entrado sin ninguna regla. Ahora el `else false` cierra la puerta al proximo.
-- ---------------------------------------------------------------------------
alter table public.content_blocks
  drop constraint if exists content_blocks_shape;
alter table public.content_blocks
  add constraint content_blocks_shape check (
    case block_type
      when 'hero'   then title is not null or media_url is not null
      when 'banner' then title is not null or media_url is not null
      when 'rich_text' then body is not null
      when 'campaign'  then title is not null
      when 'category_collection' then true
      when 'carousel'            then true
      when 'product_collection'  then true
      -- Un carrusel vacio no es invalido: es un carrusel al que todavia no le
      -- han puesto diapositivas, y eso se resuelve en la pantalla de items, no
      -- rechazando el bloque al crearlo.
      when 'slider'              then true
      else false
    end
  );

-- ---------------------------------------------------------------------------
-- El resolutor de items devuelve tambien diapositivas.
--
-- Se reescribe entera por lo de siempre. Los cambios: las tres columnas nuevas
-- viajan por las tres ramas de la union, y hay un caso `media` que se resuelve
-- SIN join — una diapositiva no apunta a ninguna otra fila.
-- ---------------------------------------------------------------------------
create or replace function ebim.content_block_items_json(
  p_block public.content_blocks
)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
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
  chosen as (
    select * from manual
    union all select * from auto_products
    union all select * from auto_categories
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
$fn$;
