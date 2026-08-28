-- =============================================================================
-- P03-SaaS · Cierre de la fase: el conteo de borrado y el estado de la capacidad
--
-- Dos cosas pequeñas que el PIM deja pendientes en tablas que ya existían.
--
-- 1. El conteo previo al borrado tiene que contar lo que ahora existe
--
-- `product_deletion_usage` contaba lineas de pedido e imagenes. Con el PIM, un
-- producto puede tener ademas variantes, unidades de venta y —sobre todo— ser
-- COMPONENTE de un kit. Ese ultimo caso no es informativo: la FK
-- `bundle_items_component_fk` es `restrict`, asi que el borrado FALLA. Sin este
-- conteo, el usuario ve el dialogo de confirmacion, pulsa Eliminar y recibe un
-- error de integridad sin explicacion — que es exactamente el patron que el
-- contrato §4.2 pide evitar ("mostrar el conteo de uso real antes de borrar").
--
-- Sigue siendo SECURITY INVOKER: cuenta bajo la RLS de quien pregunta.
-- =============================================================================

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
    ),
    'variants', (
      select count(*) from public.product_variants pv where pv.product_id = p_product_id
    ),
    -- Kits DISTINTOS que lo llevan dentro. Es el conteo que decide si el
    -- borrado va a poder ocurrir: si es mayor que cero, la FK lo impedira.
    'bundles', (
      select count(distinct bi.bundle_product_id)
      from public.bundle_items bi
      where bi.component_product_id = p_product_id
    )
  );
end;
$fn$;

comment on function public.product_deletion_usage(uuid) is
  'Conteo de uso real antes de borrar (contrato 4.2): lineas, imagenes, variantes y kits que lo usan. Cuenta bajo la RLS de quien pregunta.';

-- ---------------------------------------------------------------------------
-- 2. `catalog.advanced` deja de ser una promesa
--
-- P02 sembro las once capacidades vendibles como `declared`: gateaban modulos
-- que todavia no existian, que era el estado honesto. Con el PIM, esta tiene
-- pantalla, esquema y pedido detras. El `state` no es decorativo — el test de
-- paridad `supabase/tests/capabilities.test.ts` compara esta fila contra
-- `src/domain/capabilities.ts`, y el diagnostico de `/app/diagnostics` lo
-- ensena—, asi que se actualiza en los dos sitios a la vez.
--
-- Se hace con UPDATE y no editando la migracion 160000: una migracion aplicada
-- es inmutable (regla del repo).
-- ---------------------------------------------------------------------------
update public.app_capabilities
   set state = 'implemented'
 where code = 'catalog.advanced';
