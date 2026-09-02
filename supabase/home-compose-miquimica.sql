-- =============================================================================
-- Portada de MiQuimica, compuesta como la referencia visual.
--
-- Esto son DATOS del tenant, no una migracion: no cambia ni una regla, solo
-- coloca los bloques que ya existen y llena el que estaba vacio. Vive en el
-- repositorio porque lo que se aplica a DEV tiene que poder revisarse en un
-- diff, y es idempotente: correrlo dos veces deja lo mismo.
--
-- ## Lo que hace, y por que
--
-- 1. **«Por categoria» estaba vacio.** Un `category_collection` sin items y sin
--    categoria de la que colgar no pinta NADA — la vitrina no puede inventarse
--    de que categorias es la coleccion. De ahi que las puertas de categoria no
--    aparecieran nunca por mucho que se rediseñaran.
--
-- 2. **Las dos campanas quedan juntas.** El mural solo se forma con campanas
--    CONSECUTIVAS (`groupCampaigns`): es una decision deliberada — el orden lo
--    pone el comercio y reordenar al pintar seria enseñar una portada que nadie
--    compuso. Con una campana en 6 y otra en 15 se agrupaban igual, pero
--    dejarlas pegadas hace explicito lo que se quiere.
--
-- 3. **El orden pasa a ser el de la referencia:** cabecera, ofertas, puertas de
--    categoria, banners de marca, mas vendidos y ofertas del catalogo.
--
-- Para deshacerlo: `supabase/home-restore-miquimica.sql`.
-- =============================================================================

-- --- 1 · Las puertas de categoria ------------------------------------------
-- Las tres raices ACTIVAS. `Descontinuado` queda fuera a proposito: esta
-- inactiva, y una puerta que lleva a una categoria apagada no lleva a ningun
-- sitio.
insert into public.content_block_items
  (organization_id, company_id, store_id, block_id, block_type, item_kind,
   category_id, position)
select b.organization_id, b.company_id, b.store_id, b.id, b.block_type, 'category',
       c.id, row_number() over (order by c.position, c.name) - 1
from public.content_blocks b
join public.content_pages p on p.id = b.page_id and p.kind = 'home'
join public.categories c on c.store_id = b.store_id
where b.block_type = 'category_collection'
  and c.parent_id is null
  and c.is_active
  -- Idempotente por la clave natural: si la puerta ya esta, no se duplica.
  and not exists (
    select 1 from public.content_block_items i
    where i.block_id = b.id and i.category_id = c.id
  );

-- --- 2 · El orden de la portada --------------------------------------------
-- Se hace con un `case` sobre el titulo y no con ids fijos: los bloques los
-- creo el sembrado y sus ids cambian en cada reconstruccion del cliente.
update public.content_blocks b
   set position = v.pos
  from (values
    -- Cabecera: el carrusel de la campana del momento.
    ('Probiotico Infantil',   5),
    -- Las dos campanas, pegadas: forman el mural «Ofertas de la semana».
    ('Semana de la Salud',   10),
    ('Semana dermocosmetica', 11),
    -- Las puertas de categoria, que es lo que ordena la portada por dentro.
    ('Por categoria',        15),
    -- Los banners de marca.
    ('Anuncios',             20),
    ('Lo mas vendido',       25),
    ('Ofertas de la semana', 30)
  ) as v(titulo, pos)
 where b.title = v.titulo
   and b.position is distinct from v.pos
   and exists (
     select 1 from public.content_pages p
      where p.id = b.page_id and p.kind = 'home'
   );
