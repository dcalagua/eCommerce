-- =============================================================================
-- P18 · La diapositiva sin texto alternativo deja de ser valida.
--
-- `content_block_items_media_shape` acota `media_alt` cuando existe, pero no
-- obligaba a que existiera. En un item de catalogo eso da igual —el alt sale de
-- la imagen del producto—, pero una diapositiva de carrusel NO tiene ningun
-- otro texto: sin alt, el banner de la portada es literalmente mudo para quien
-- navega con lector de pantalla, y suele ser justo el que anuncia la oferta.
--
-- Va en `content_block_items_target`, que es donde se decide que columnas exige
-- cada clase de item, y no en un CHECK aparte: dos reglas sobre la misma cosa
-- acaban discrepando.
-- =============================================================================

-- Red de seguridad para las diapositivas creadas entre la migracion anterior y
-- esta: sin esto el `add constraint` fallaria y dejaria la tabla sin la regla.
update public.content_block_items
   set media_alt = coalesce(nullif(btrim(media_alt), ''), 'Imagen')
 where item_kind = 'media'
   and (media_alt is null or btrim(media_alt) = '');

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
    -- La diapositiva no apunta a ninguna fila del catalogo: se sostiene sola, y
    -- por eso tiene que traer su propio texto.
    or (item_kind = 'media'    and media_url is not null and media_alt is not null
                               and product_id is null and variant_id is null
                               and category_id is null)
  );
