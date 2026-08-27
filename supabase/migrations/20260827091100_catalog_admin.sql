-- =============================================================================
-- P04 · 10/10 — Administración de catálogo desde el backoffice.
--
-- Tres cosas que el cliente NO puede hacer bien con consultas sueltas:
--   1. Cambiar la imagen principal. El índice único parcial
--      `product_images_primary_key` prohíbe dos principales por producto, así
--      que "quitar la anterior" y "poner la nueva" tienen que ser una sola
--      operación o el usuario se come un 409 a mitad de camino.
--   2. Reordenar. N updates desde el navegador dejan el orden a medias en
--      cuanto uno falle.
--   3. Contar el uso real antes de borrar (contrato §4.2: «desactivar conserva
--      los datos; eliminar muestra el conteo de uso real antes de borrar»).
--
-- Todas son `SECURITY INVOKER` (explícito, aunque sea el default): cuentan y
-- escriben bajo la RLS de quien pregunta. Una DEFINER aquí devolvería el
-- conteo de otro tenant o reordenaría su catálogo, y ninguna policy podría
-- impedirlo. Ninguna recibe `organization_id`/`company_id`: el tenant sale del
-- JWT a través de las policies.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- La primera imagen de un producto es la principal, y al borrar la principal
-- asciende la siguiente. Sin esto, un producto con fotos puede quedarse sin
-- miniatura en la vitrina y nadie se entera hasta que un comprador lo ve.
-- ---------------------------------------------------------------------------
create or replace function ebim.product_image_defaults()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if not new.is_primary
     and not exists (
       select 1 from public.product_images pi where pi.product_id = new.product_id
     )
  then
    new.is_primary := true;
  end if;
  return new;
end;
$fn$;

create trigger product_images_defaults
  before insert on public.product_images
  for each row execute function ebim.product_image_defaults();

create or replace function ebim.product_image_promote_next()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  -- En un borrado en cascada (se va el producto entero) la subconsulta no
  -- encuentra nada y esto no hace nada: los AFTER de fila corren cuando la
  -- sentencia ya borró todas las filas.
  if old.is_primary then
    update public.product_images
       set is_primary = true
     where id = (
       select pi.id
       from public.product_images pi
       where pi.product_id = old.product_id
       order by pi."position", pi.created_at
       limit 1
     );
  end if;
  return old;
end;
$fn$;

create trigger product_images_promote_next
  after delete on public.product_images
  for each row execute function ebim.product_image_promote_next();

-- ---------------------------------------------------------------------------
-- Imagen principal — atómica.
-- ---------------------------------------------------------------------------
create or replace function public.set_primary_product_image(p_image_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $fn$
declare
  v_product uuid;
begin
  select pi.product_id into v_product
  from public.product_images pi
  where pi.id = p_image_id;

  if v_product is null then
    raise exception 'IMAGEN_NO_ENCONTRADA: La imagen no existe para este tenant';
  end if;

  -- Primero se libera la anterior: al revés chocaría con el índice único.
  update public.product_images
     set is_primary = false
   where product_id = v_product
     and id <> p_image_id
     and is_primary;

  update public.product_images
     set is_primary = true
   where id = p_image_id;

  -- Sin rol de catálogo la RLS deja el UPDATE en cero filas y sin error. Un
  -- "guardado" que no guardó nada es peor que un fallo: se avisa.
  if not found then
    raise exception 'SIN_PERMISO: Tu rol no puede cambiar las imagenes de este producto';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Reordenar — todo el orden o ninguno.
-- ---------------------------------------------------------------------------
create or replace function public.reorder_product_images(p_product_id uuid, p_image_ids uuid[])
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $fn$
declare
  v_len     integer := coalesce(array_length(p_image_ids, 1), 0);
  v_unique  integer;
  v_visible integer;
  v_updated integer;
begin
  if v_len = 0 then
    raise exception 'ITEMS_REQUERIDOS: Hay que enviar el orden completo de las imagenes';
  end if;

  select count(distinct value) into v_unique from unnest(p_image_ids) as value;
  if v_unique <> v_len then
    raise exception 'CAMPO_INVALIDO: El orden no puede repetir imagenes';
  end if;

  select count(*) into v_visible
  from public.product_images pi
  where pi.product_id = p_product_id;

  -- Un orden parcial dejaría posiciones duplicadas. Se exige la lista entera.
  if v_visible <> v_len then
    raise exception 'CAMPO_INVALIDO: El orden tiene que incluir todas las imagenes del producto';
  end if;

  update public.product_images pi
     set "position" = ord.idx - 1
    from unnest(p_image_ids) with ordinality as ord(image_id, idx)
   where pi.id = ord.image_id
     and pi.product_id = p_product_id;

  get diagnostics v_updated = row_count;
  if v_updated <> v_len then
    raise exception 'SIN_PERMISO: No se pudo reordenar las imagenes de este producto';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Eliminación segura (contrato §4.2): antes de borrar, el conteo REAL de uso.
-- Se cuenta bajo RLS, así que las cifras son las del tenant que pregunta.
-- ---------------------------------------------------------------------------
create or replace function public.product_deletion_usage(p_product_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_name text;
begin
  select p.name into v_name from public.products p where p.id = p_product_id;
  if v_name is null then
    raise exception 'PRODUCTO_NO_ENCONTRADO: El producto no existe para este tenant';
  end if;

  return jsonb_build_object(
    'name', v_name,
    'order_lines', (
      select count(*) from public.order_items oi where oi.product_id = p_product_id
    ),
    'images', (
      select count(*) from public.product_images pi where pi.product_id = p_product_id
    )
  );
end;
$fn$;

create or replace function public.category_deletion_usage(p_category_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_name text;
begin
  select c.name into v_name from public.categories c where c.id = p_category_id;
  if v_name is null then
    raise exception 'CATEGORIA_NO_ENCONTRADA: La categoria no existe para este tenant';
  end if;

  return jsonb_build_object(
    'name', v_name,
    'products', (
      select count(*) from public.products p where p.category_id = p_category_id
    ),
    'children', (
      select count(*) from public.categories c where c.parent_id = p_category_id
    )
  );
end;
$fn$;

revoke execute on function
  public.set_primary_product_image(uuid),
  public.reorder_product_images(uuid, uuid[]),
  public.product_deletion_usage(uuid),
  public.category_deletion_usage(uuid)
from public, anon;

grant execute on function
  public.set_primary_product_image(uuid),
  public.reorder_product_images(uuid, uuid[]),
  public.product_deletion_usage(uuid),
  public.category_deletion_usage(uuid)
to authenticated, service_role;

comment on function public.set_primary_product_image(uuid) is
  'Cambia la imagen principal en una sola operacion. SECURITY INVOKER: la RLS decide.';
comment on function public.product_deletion_usage(uuid) is
  'Conteo de uso real antes de borrar (contrato 4.2). Cuenta bajo la RLS de quien pregunta.';
