-- =============================================================================
-- P18 · Carrusel de imagenes (1 de 2): los valores de enum.
--
-- Va en su propio fichero por una razon de Postgres, no de estilo: un valor
-- anadido con `alter type ... add value` NO se puede USAR en la misma
-- transaccion en la que se crea. Y la migracion siguiente lo usa en cada uno de
-- sus CHECK. Separarlos es la unica forma de que las dos apliquen.
--
-- `slider` es un bloque de IMAGENES, distinto de `carousel`, que desde P11 es un
-- carrusel de PRODUCTOS. Se podria haber reutilizado aquel diciendo «si no
-- tiene categoria, entonces son imagenes», pero eso es un tipo que significa
-- dos cosas segun lo que le falte: el dia que alguien borre la categoria de un
-- carrusel de productos se encontraria con un carrusel de imagenes vacio.
--
-- `media` es la diapositiva: una imagen con su texto alternativo y, si acaso, un
-- enlace. Es el primer item que no apunta a otra fila del catalogo, y por eso
-- necesita valor propio en vez de colarse como 'product' sin producto.
-- =============================================================================

alter type public.content_block_type add value if not exists 'slider';
alter type public.content_item_kind  add value if not exists 'media';
