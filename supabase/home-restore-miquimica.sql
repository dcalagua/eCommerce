-- =============================================================================
-- Deshace `supabase/home-compose-miquimica.sql`.
--
-- Devuelve la portada de MiQuimica al estado del sembrado: las posiciones que
-- tenia y el bloque de categorias vacio. Existe porque el que compone la
-- portada toca DATOS del cliente, y un cambio de datos sin vuelta atras es un
-- cambio que nadie se atreve a probar.
--
-- Solo quita las puertas que puso el compositor —las tres raices activas—; si
-- alguien anadio otras a mano desde el backoffice, se quedan.
-- =============================================================================

delete from public.content_block_items i
 using public.content_blocks b,
       public.content_pages p,
       public.categories c
 where i.block_id = b.id
   and p.id = b.page_id
   and p.kind = 'home'
   and b.block_type = 'category_collection'
   and c.id = i.category_id
   and c.parent_id is null
   and c.is_active;

update public.content_blocks b
   set position = v.pos
  from (values
    ('Probiotico Infantil',   5),
    ('Semana de la Salud',    6),
    ('Semana dermocosmetica', 15),
    ('Anuncios',              16),
    ('Lo mas vendido',        20),
    ('Ofertas de la semana',  25),
    ('Por categoria',         30)
  ) as v(titulo, pos)
 where b.title = v.titulo
   and b.position is distinct from v.pos
   and exists (
     select 1 from public.content_pages p
      where p.id = b.page_id and p.kind = 'home'
   );
