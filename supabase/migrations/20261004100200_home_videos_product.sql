-- ===========================================================================
-- Videos de la portada enlazados a un producto (2026-10-04)
--
-- El carrusel pasa a formato Reels: debajo del video activo sale la tarjeta
-- del producto que enseña (foto, nombre, precio) y lleva a su ficha. Cada
-- video admite una clave más, `product_id`, opcional.
--
-- La base solo exige que sea un uuid: una función de CHECK es inmutable y no
-- puede mirar `products`. Tampoco hace falta para la seguridad: la vitrina
-- busca el producto en `public_products` FILTRANDO por la tienda, así que un
-- id de otra tienda —o despublicado— simplemente no pinta tarjeta.
--
-- Copia fiel de 20261004100000 más esa clave. CREATE OR REPLACE conserva los
-- permisos.
-- ===========================================================================

create or replace function ebim.home_videos_are_valid(p_value jsonb, p_org uuid, p_store uuid)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce((
    select jsonb_typeof(p_value) = 'array'
     and jsonb_array_length(p_value) <= 8
     and not exists (
       select 1
       from jsonb_array_elements(p_value) as e(video)
       where not (
         jsonb_typeof(e.video) = 'object'
         and not exists (
           select 1 from jsonb_object_keys(e.video) as k(clave)
           where k.clave not in ('path', 'title', 'duration', 'product_id')
         )
         and jsonb_typeof(e.video -> 'path') = 'string'
         and (e.video ->> 'path') ~ (
           '^' || p_org::text || '/' || p_store::text
           || '/content/video-[0-9a-f-]{36}\.(mp4|webm)$'
         )
         and (
           not (e.video ? 'title')
           or jsonb_typeof(e.video -> 'title') = 'null'
           or (jsonb_typeof(e.video -> 'title') = 'string' and char_length(e.video ->> 'title') <= 80)
         )
         -- 2026-10-04 · el producto que enseña el video (opcional)
         and (
           not (e.video ? 'product_id')
           or jsonb_typeof(e.video -> 'product_id') = 'null'
           or (
             jsonb_typeof(e.video -> 'product_id') = 'string'
             and (e.video ->> 'product_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           )
         )
         and jsonb_typeof(e.video -> 'duration') = 'number'
         and (e.video ->> 'duration') ~ '^[0-9]{2}$'
         and (e.video ->> 'duration')::int between 30 and 60
       )
     )
     and (
       select count(distinct e.video ->> 'path') from jsonb_array_elements(p_value) as e(video)
     ) = jsonb_array_length(p_value)
  ), false);
$fn$;

revoke execute on function ebim.home_videos_are_valid(jsonb, uuid, uuid) from public;
grant  execute on function ebim.home_videos_are_valid(jsonb, uuid, uuid)
  to anon, authenticated, service_role;

comment on function ebim.home_videos_are_valid(jsonb, uuid, uuid) is
  'Videos de la portada: 0..8 {path de la propia tienda en content/video-*.mp4|webm, title <=80, duration 30..60, product_id uuid opcional} sin rutas repetidas.';
