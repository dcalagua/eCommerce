-- =============================================================================
-- P02 · 07/08 — Storage: `product-images` y `store-assets`.
--
-- Layout obligatorio: {organization_id}/{store_id}/...
-- Los buckets NO son públicos. "Lectura pública" aquí significa: `anon` puede
-- leer el objeto SOLO si el asset está publicado (producto publicado en tienda
-- activa, o branding de tienda activa). Un bucket `public = true` daría lectura
-- a cualquier ruta del bucket, incluida la de un borrador o la de otro tenant.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', false),
       ('store-assets',   'store-assets',   false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- El tenant sale de la RUTA, y la ruta se contrasta contra `stores` bajo RLS.
-- No son SECURITY DEFINER a propósito: quien pregunta responde con sus propios
-- permisos, así una ruta de otro tenant simplemente no encuentra fila.
-- ---------------------------------------------------------------------------
create or replace function ebim.storage_org(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $fn$
  select ebim.safe_uuid(split_part(p_name, '/', 1));
$fn$;

create or replace function ebim.storage_store(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $fn$
  select ebim.safe_uuid(split_part(p_name, '/', 2));
$fn$;

/** ¿El objeto cae en una tienda visible para quien pregunta, con rol de catálogo? */
create or replace function ebim.can_write_store_object(p_name text)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.stores s
    where s.id              = ebim.storage_store(p_name)
      and s.organization_id = ebim.storage_org(p_name)
      and ebim.has_role(s.organization_id, s.company_id,
                        array['owner','admin','catalog']::public.app_role[])
  );
$fn$;

/** ¿El objeto pertenece a una tienda que quien pregunta puede ver? (anon: activa) */
create or replace function ebim.store_object_visible(p_name text)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.stores s
    where s.id              = ebim.storage_store(p_name)
      and s.organization_id = ebim.storage_org(p_name)
  );
$fn$;

revoke execute on function
  ebim.storage_org(text), ebim.storage_store(text),
  ebim.can_write_store_object(text), ebim.store_object_visible(text)
from public;

grant execute on function ebim.store_object_visible(text) to anon, authenticated, service_role;
grant execute on function ebim.storage_org(text), ebim.storage_store(text) to anon, authenticated, service_role;
grant execute on function ebim.can_write_store_object(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Policies. `storage.objects` ya trae RLS activada en Supabase.
-- ---------------------------------------------------------------------------
alter table storage.objects enable row level security;

-- Lectura del tenant sobre sus propios objetos (incluye borradores).
create policy ebim_objects_select_member on storage.objects
  for select to authenticated
  using (
    bucket_id in ('product-images', 'store-assets')
    and ebim.can_write_store_object(name)
  );

create policy ebim_objects_insert_catalog on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('product-images', 'store-assets')
    and ebim.can_write_store_object(name)
  );

create policy ebim_objects_update_catalog on storage.objects
  for update to authenticated
  using      (bucket_id in ('product-images', 'store-assets') and ebim.can_write_store_object(name))
  with check (bucket_id in ('product-images', 'store-assets') and ebim.can_write_store_object(name));

create policy ebim_objects_delete_catalog on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('product-images', 'store-assets')
    and ebim.can_write_store_object(name)
  );

-- Lectura anónima de imágenes: solo si existe una fila de `product_images` que
-- apunte a esa ruta y que `anon` pueda ver — es decir, producto publicado en
-- tienda activa. El filtro lo hace la RLS de `product_images`, no una copia.
create policy ebim_objects_select_public_product on storage.objects
  for select to anon
  using (
    bucket_id = 'product-images'
    and exists (
      select 1 from public.product_images pi
      where pi.storage_path = storage.objects.name
    )
  );

-- Branding de tienda: publicable por definición, pero solo de tienda activa
-- (la policy `stores_select_public` es la que decide qué es "activa").
create policy ebim_objects_select_public_asset on storage.objects
  for select to anon
  using (
    bucket_id = 'store-assets'
    and ebim.store_object_visible(storage.objects.name)
  );

comment on function ebim.can_write_store_object(text) is
  'Autorizacion de escritura en Storage derivada de la ruta {organization_id}/{store_id}/ y del rol.';
