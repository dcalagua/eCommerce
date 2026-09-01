-- =============================================================================
-- FIX · El logo del tenant nunca se veia en la vitrina.
--
-- Sintoma: una tienda con `logo_url` guardado enseñaba las iniciales. Firmar la
-- ruta con el cliente ANONIMO —que es lo que hace la vitrina— devolvia
-- `permission denied for table stores`.
--
-- Causa: la policy `ebim_objects_select_public_asset` delega en
-- `ebim.store_object_visible(name)`, y esa funcion consulta `public.stores`
-- SIN ser `security definer`. El cuerpo de una funcion se ejecuta con los
-- permisos de quien llama, y `anon` no tiene ningun GRANT sobre `stores`: la
-- vitrina lee por las vistas `public_*`, nunca por la tabla. Por eso la policy
-- hermana de las fotos de producto si funciona — esa hace el `exists` DENTRO de
-- la expresion de la policy, donde no se comprueban permisos de tabla.
--
-- Arreglo: la funcion pasa a `security definer` y, como la RLS de `stores` deja
-- de filtrar por ella, **la condicion de visibilidad se escribe explicitamente**
-- (`status = 'active'`). Antes esa parte la ponia la policy publica de `stores`
-- y el comentario de la funcion la daba por hecha; ahora esta en el cuerpo, que
-- es donde el contrato exige que este la autorizacion de una definer.
--
-- Lo que la funcion revela sigue siendo un BOOLEANO: «esta ruta cae en una
-- tienda activa». Ni una columna de `stores` sale de aqui.
--
-- `EXECUTE` se mantiene para `anon`: el llamante legitimo es justamente la
-- policy de Storage evaluada como anonimo cuando un comprador pide el logo.
-- =============================================================================

create or replace function ebim.store_object_visible(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.stores s
    where s.id              = ebim.storage_store(p_name)
      and s.organization_id = ebim.storage_org(p_name)
      -- Explicito: con `security definer` la RLS de `stores` ya no filtra, y
      -- sin esta linea el branding de una tienda en BORRADOR seria publico.
      and s.status = 'active'
  );
$fn$;

revoke execute on function ebim.store_object_visible(text) from public;
grant execute on function ebim.store_object_visible(text) to anon, authenticated, service_role;

comment on function ebim.store_object_visible(text) is
  'Booleano: la ruta cae en una tienda ACTIVA. Definer porque anon no lee public.stores; la condicion de visibilidad va escrita en el cuerpo.';
