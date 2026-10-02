-- ===========================================================================
-- Foto por variante (2026-10-02)
--
-- Hasta hoy una foto era del PRODUCTO: la ficha enseñaba todas a la vez y, al
-- elegir «Azul» en una mochila, seguía viéndose la negra. Ahora una foto puede
-- pertenecer a una variante concreta (`variant_id`); la que no lleva variante
-- sigue siendo del producto y vale para todas.
--
-- La regla de qué se enseña vive en la vitrina (`variantGallery.ts`): las de
-- la variante elegida y las de sus hermanas del MISMO color (una maleta negra
-- de 20" y la de 28" comparten fotos); si ese color no tiene ninguna, las del
-- producto, y si tampoco, la principal.
--
-- Sin tabla nueva ni policy nueva: la fila sigue siendo de `product_images`,
-- con su tenant, su RLS forzada y sus policies de siempre. La FK compuesta
-- (variante, producto) impide colgar una foto de una variante de OTRO
-- producto, y al borrar la variante la foto vuelve a ser del producto
-- (`set null (variant_id)`: solo esa columna, no el producto).
-- ===========================================================================

alter table public.product_images
  add column if not exists variant_id uuid;

alter table public.product_images
  drop constraint if exists product_images_variant_fk;
alter table public.product_images
  add constraint product_images_variant_fk foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete set null (variant_id);

create index if not exists product_images_variant_idx
  on public.product_images (variant_id) where variant_id is not null;

comment on column public.product_images.variant_id is
  'Variante a la que pertenece la foto (sus hermanas del mismo color la comparten en la ficha). NULL = foto del producto, vale para todas.';

-- La vitrina lee por columnas: anon solo ve lo que se le concede una a una.
grant select (variant_id) on public.product_images to anon;

-- Misma vista, una columna más AL FINAL (`create or replace` no permite otra
-- cosa, y así sus grants y su comentario se conservan).
create or replace view public.public_product_images
with (security_invoker = on) as
select
  i.id         as image_id,
  i.product_id,
  i.store_id,
  i.storage_path,
  i.alt,
  i.position,
  i.is_primary,
  i.variant_id
from public.product_images i;
