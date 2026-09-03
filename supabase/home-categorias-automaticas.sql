-- =============================================================================
-- La portada deja de llevar las categorias a mano.
--
-- Esto son DATOS del tenant, no una migracion: la regla la pone
-- `20260903120000_cms_root_categories.sql`, que enseña que ese bloque puede
-- llenarse solo. Aqui solo se RETIRA la curacion que lo impedia.
--
-- ## Por que habia curacion que retirar
--
-- `home-compose-miquimica.sql` metio «las tres raices ACTIVAS» porque, hasta la
-- migracion de arriba, un `category_collection` sin items y sin categoria madre
-- no pintaba nada: el automatico solo sabia resolver las HIJAS de una madre, y
-- en la raiz no hay madre a la que apuntar. Aquello no era una eleccion
-- editorial, era el unico modo de que la seccion existiera.
--
-- El precio de aquel apaño es que era una FOTO FIJA: las familias que se
-- añadian al catalogo despues salian en la barra de la cabecera —que lee el
-- arbol entero— y no en la portada. Desde fuera parecia codigo fijo.
--
-- Con los items fuera, manda `auto_root_categories` y la seccion enseña todas
-- las familias de primer nivel, tambien las que se creen mañana.
--
-- ## Alcance, a proposito estrecho
--
-- Solo toca bloques `category_collection` de la pagina de INICIO y **sin
-- categoria madre**, que son exactamente los que la migracion sabe llenar. Un
-- bloque que cuelga de una madre sigue resolviendo sus hijas, y una coleccion
-- de categorias curada de verdad en otra pagina no se toca.
--
-- Idempotente: correrlo dos veces deja lo mismo, porque la segunda no encuentra
-- nada que borrar.
--
-- Para deshacerlo: `supabase/home-compose-miquimica.sql`, que vuelve a insertar
-- las raices activas del momento.
-- =============================================================================

begin;

-- --- 1 · Fuera la foto fija -------------------------------------------------
delete from public.content_block_items i
using public.content_blocks b
join public.content_pages p on p.id = b.page_id
where i.block_id = b.id
  and p.kind = 'home'
  and b.block_type = 'category_collection'
  and b.category_id is null
  and i.item_kind = 'category';

commit;

-- --- 2 · Comprobacion -------------------------------------------------------
-- `items_a_mano` tiene que salir 0, y `sale_en_portada` tiene que listar TODAS
-- las familias activas de primer nivel: si falta alguna, la migracion
-- 20260903120000 no esta aplicada.
select
  b.title,
  b.item_limit,
  count(i.id) as items_a_mano,
  (
    select string_agg(x.name, ' · ' order by x.position, x.name)
    from public.categories x
    where x.store_id = b.store_id and x.parent_id is null and x.is_active
  ) as sale_en_portada
from public.content_blocks b
join public.content_pages p on p.id = b.page_id
left join public.content_block_items i on i.block_id = b.id
where p.kind = 'home'
  and b.block_type = 'category_collection'
  and b.category_id is null
group by b.id, b.title, b.item_limit, b.store_id;
