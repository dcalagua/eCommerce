-- =============================================================================
-- «Cargar del catalogo» se hace UNA vez por tienda, no una vez por almacen.
--
-- ## El problema
--
-- `seed_inventory_from_catalog` copia `products.stock` al almacen indicado. Su
-- idempotencia iba por `external_ref = seed:<almacen>:<producto>`: protegia
-- contra pulsar dos veces en el MISMO almacen, pero no contra pulsar en otro.
-- La existencia de la ficha es una sola; copiarla a dos almacenes la duplica.
-- Le paso a `ferromax`: 50 unidades por producto acabaron siendo 50 en Lima
-- Norte y otras 50 en Lima Sur, y la tienda ofrecia 100 de cada uno.
--
-- ## La regla
--
-- Si la existencia de esta tienda ya se migro a OTRO almacen de la sociedad,
-- la funcion se niega con INVENTARIO_YA_MIGRADO. Repetirla sobre el mismo
-- almacen sigue siendo idempotente, como antes. Para repartir entre almacenes
-- estan los traslados y los ajustes, que dejan asiento de por que.
--
-- Copia literal de la definicion vigente (20260827200200) con el bloque nuevo
-- marcado.
-- =============================================================================

create or replace function public.seed_inventory_from_catalog(
  p_warehouse_id uuid,
  p_store_id     uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_warehouse public.warehouses%rowtype;
  v_store     public.stores%rowtype;
  v_row       record;
  v_level     uuid;
  v_seeded    integer := 0;
  v_previo    text;
begin
  select * into v_warehouse from public.warehouses w where w.id = p_warehouse_id;
  if not found then
    raise exception 'ALMACEN_NO_ENCONTRADO: %', p_warehouse_id using errcode = '22023';
  end if;

  perform ebim.assert_inventory_role(
    v_warehouse.organization_id, v_warehouse.company_id,
    array['owner','admin']::public.app_role[]);

  select * into v_store from public.stores s where s.id = p_store_id;
  if not found
     or v_store.organization_id <> v_warehouse.organization_id
     or v_store.company_id <> v_warehouse.company_id then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda no es de la sociedad del almacen'
      using errcode = '22023';
  end if;

  -- ---- NUEVO: una sola migracion por tienda --------------------------------
  select w.code into v_previo
    from public.inventory_movements m
    join public.warehouses w on w.id = m.warehouse_id
    join public.products p   on p.id = m.product_id
   where m.company_id = v_store.company_id
     and m.external_ref like 'seed:%'
     and m.warehouse_id <> p_warehouse_id
     and p.store_id = v_store.id
   limit 1;

  if v_previo is not null then
    raise exception 'INVENTARIO_YA_MIGRADO: la existencia del catalogo ya se cargo en el almacen %', v_previo
      using errcode = '22023';
  end if;
  -- --------------------------------------------------------------------------

  for v_row in
    select p.id as product_id, null::uuid as variant_id, p.stock::numeric as qty
    from public.products p
    where p.store_id = v_store.id and p.kind = 'simple' and p.stock > 0
    union all
    select pv.product_id, pv.id, pv.stock::numeric
    from public.product_variants pv
    where pv.store_id = v_store.id and pv.stock > 0
  loop
    v_level := ebim.ensure_level(p_warehouse_id, v_row.product_id, v_row.variant_id);

    perform ebim.apply_movement(
      v_level, 'count'::public.movement_kind, v_row.qty,
      'existencia inicial migrada del catalogo',
      'import', null,
      'seed:' || p_warehouse_id::text || ':' || coalesce(v_row.variant_id, v_row.product_id)::text,
      ebim.user_id(), 'local'::public.inventory_source);

    v_seeded := v_seeded + 1;
  end loop;

  return jsonb_build_object('warehouse_id', p_warehouse_id, 'store_id', p_store_id, 'seeded', v_seeded);
end;
$fn$;

comment on function public.seed_inventory_from_catalog(uuid, uuid) is
  'Transicion de products.stock a un almacen, UNA vez por tienda: si ya se migro a otro almacen, INVENTARIO_YA_MIGRADO. Idempotente sobre el mismo almacen.';
