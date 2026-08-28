-- =============================================================================
-- P06-SaaS · El motor: repartir, prometer, comprometer y soltar
--
-- La migracion anterior puso las tablas. Esta pone la unica pieza que de verdad
-- decide si un comercio puede vender sin sobrevender: **como se toman las
-- unidades**.
--
-- ## El patron que NO se usa, y por que
--
-- El descuento de existencia de P02 era, en esencia:
--
--     select stock into v_disponible from products where id = ... for update;
--     if v_disponible < v_pedido then raise; end if;
--     update products set stock = stock - v_pedido where id = ...;
--
-- Funciona —el `for update` bloquea— pero solo porque las tres sentencias caben
-- en una transaccion corta y el bloqueo se toma en la primera. En cuanto entre
-- un carrito con reserva previa, un reparto entre varios almacenes o un backoff
-- de reintento, la distancia entre la lectura y la escritura crece y la ventana
-- se abre. Y sobre todo: la garantia queda depositada en que quien escriba la
-- siguiente funcion se acuerde de poner el `for update`.
--
-- ## Lo que se usa: la decision se toma DENTRO de la sentencia que escribe
--
--     with locked as (
--       select id, least(<lo que falta>, <lo que hay libre>) as take
--         from public.inventory_levels where id = ... for update
--     )
--     update public.inventory_levels l
--        set reserved_qty = l.reserved_qty + k.take
--       from locked k where l.id = k.id and k.take > 0
--     returning k.take;
--
-- La CTE toma el bloqueo Y relee la fila ya bloqueada —en READ COMMITTED,
-- `SELECT ... FOR UPDATE` devuelve la version mas reciente confirmada despues
-- de esperar al que iba delante—, asi que `take` se calcula sobre la cifra
-- verdadera y no sobre una foto vieja. Dos checkouts simultaneos sobre el mismo
-- nivel se serializan en esa espera: el segundo ve el saldo que dejo el primero.
-- No hay bucle de reintento porque no hay conflicto que reintentar.
--
-- Y detras, la red: `inventory_levels_no_oversell`. Si algun dia alguien
-- escribe un `update` sin guarda, la transaccion aborta. La correccion no
-- depende de que este archivo sea correcto para siempre.
--
-- ## Consultar no es reservar
--
-- `ebim.atp` es una FOTO: no bloquea, no compromete y caduca en cuanto se toma.
-- `ebim.hold_stock` es lo unico que impide vender dos veces la misma unidad, y
-- por eso devuelve un identificador con caducidad y no un booleano. Es la
-- distincion que `src/domain/ports/inventory.ts` fijo en P01 y que aqui se
-- implementa por primera vez.
--
-- ## "No se sabe" no es "no hay"
--
-- Un almacen cuyo sistema de registro es un ERP y cuya cifra caduco no aporta
-- cero: aporta *nada*, y la respuesta pasa a ser desconocida (regla 9). Cero
-- vaciaria la tienda entera durante una caida ajena; inventarse la ultima cifra
-- sin decirlo seria prometer lo que no se puede cumplir. Las dos salidas
-- honestas son las dos politicas del almacen, y la elige el tenant.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.serving_warehouses — de que almacenes se sirve una tienda, en orden.
--
-- **Sin filas declaradas = todos los activos de la sociedad.** Es lo que hace
-- que dar de alta el primer almacen no rompa la tienda y que el caso de un solo
-- almacen no obligue a configurar una relacion con una sola respuesta posible.
-- Declarar es RESTRINGIR.
-- ---------------------------------------------------------------------------
create or replace function ebim.serving_warehouses(p_store_id uuid)
returns table (
  warehouse_id     uuid,
  code             text,
  priority         integer,
  source           public.inventory_source,
  stale_after      interval,
  stale_policy     public.stock_staleness_policy,
  allows_backorder boolean
)
language sql
stable
set search_path = ''
as $fn$
  with declared as (
    select sw.warehouse_id, sw.priority
    from public.store_warehouses sw
    where sw.store_id = p_store_id and sw.is_active
  )
  select w.id, w.code, coalesce(d.priority, w.priority),
         w.source, w.stale_after, w.stale_policy, w.allows_backorder
  from public.warehouses w
  join public.stores s
    on s.id = p_store_id
   and s.organization_id = w.organization_id
   and s.company_id      = w.company_id
  left join declared d on d.warehouse_id = w.id
  where w.is_active
    and (d.warehouse_id is not null or not exists (select 1 from declared))
  order by coalesce(d.priority, w.priority), w.code;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.expand_stock_lines — que existencia mueve realmente una linea.
--
-- Un kit no tiene existencia propia: mueve la de sus componentes. Esta funcion
-- es la traduccion, y esta AQUI y no repetida en cada llamante porque cada
-- copia de esta regla es una forma distinta de descuadrar un pack.
--
-- Cantidades siempre en unidades BASE del componente.
-- ---------------------------------------------------------------------------
create or replace function ebim.expand_stock_lines(
  p_store_id   uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_base_qty   numeric
)
returns table (product_id uuid, variant_id uuid, quantity numeric)
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_kind public.product_kind;
begin
  select p.kind into v_kind
  from public.products p
  where p.id = p_product_id and p.store_id = p_store_id;

  if v_kind is null then
    raise exception 'PRODUCTO_NO_DISPONIBLE: %', coalesce(p_product_id::text, 'null')
      using errcode = '22023';
  end if;

  if v_kind <> 'bundle' then
    return query select p_product_id, p_variant_id, p_base_qty;
    return;
  end if;

  if not exists (select 1 from public.bundle_items bi where bi.bundle_product_id = p_product_id) then
    raise exception 'KIT_SIN_COMPONENTES: el kit % no tiene componentes definidos', p_product_id
      using errcode = '22023';
  end if;

  -- Un componente expresado en una unidad que no tiene configurada: no se sabe
  -- cuanto hace falta, asi que no se mueve nada. Falla en vez de aproximar.
  if exists (
    select 1
    from public.bundle_items bi
    left join public.product_uoms pu
      on pu.product_id = bi.component_product_id and pu.uom_id = bi.uom_id
    where bi.bundle_product_id = p_product_id
      and bi.uom_id is not null
      and pu.factor is null
  ) then
    raise exception 'KIT_UOM_INVALIDA: un componente del kit % usa una unidad sin configurar', p_product_id
      using errcode = '22023';
  end if;

  return query
    select bi.component_product_id,
           bi.component_variant_id,
           bi.quantity * coalesce(pu.factor, 1) * p_base_qty
    from public.bundle_items bi
    left join public.product_uoms pu
      on pu.product_id = bi.component_product_id and pu.uom_id = bi.uom_id
    where bi.bundle_product_id = p_product_id
    order by bi.position, bi.component_product_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.atp — cuanto se puede PROMETER. Una foto, no un compromiso.
--
-- Devuelve `{ available, unknown, backorder, source, warehouses }`:
--
--  · `available` — suma de `on_hand - reserved - safety_stock` sobre los
--    almacenes que aportan. Es una COTA INFERIOR cuando `unknown` es cierto.
--  · `unknown`  — algun almacen que sirve a esta tienda tiene la cifra caducada
--    y politica `unknown`. La respuesta correcta es "no se sabe", nunca cero.
--  · `backorder` — algun almacen que tiene esta referencia admite venta bajo
--    cero; entonces la cantidad deja de ser el limite.
--  · `source`   — `catalog` (sin almacenes: la columna `stock` de siempre),
--    `warehouse` o `erp`. Son los tres valores exactos de `InventoryPort`.
--
-- El **camino de catalogo** es lo que hace que esta fase no rompa a nadie
-- (regla 10): una tienda sin almacenes responde exactamente lo que respondia
-- antes, leyendo `products.stock` / `product_variants.stock`.
-- ---------------------------------------------------------------------------
create or replace function ebim.atp(
  p_store_id   uuid,
  p_product_id uuid,
  p_variant_id uuid default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_kind       public.product_kind;
  v_available  numeric := 0;
  v_unknown    boolean := false;
  v_backorder  boolean := false;
  v_any_erp    boolean := false;
  v_count      integer := 0;
  v_component  record;
  v_child      jsonb;
  v_per_unit   numeric;
  v_possible   numeric;
  v_min        numeric := null;
begin
  select p.kind into v_kind
  from public.products p
  where p.id = p_product_id and p.store_id = p_store_id;

  if v_kind is null then
    return jsonb_build_object(
      'available', null, 'unknown', true, 'backorder', false,
      'source', 'catalog', 'warehouses', 0);
  end if;

  -- ---- Kit: su disponibilidad es la del componente que menos alcanza -------
  if v_kind = 'bundle' then
    for v_component in
      select l.product_id, l.variant_id, l.quantity
      from ebim.expand_stock_lines(p_store_id, p_product_id, null, 1) l
    loop
      v_per_unit := v_component.quantity;
      if v_per_unit is null or v_per_unit <= 0 then continue; end if;

      v_child := ebim.atp(p_store_id, v_component.product_id, v_component.variant_id);
      v_unknown   := v_unknown   or coalesce((v_child ->> 'unknown')::boolean, false);
      v_backorder := v_backorder or coalesce((v_child ->> 'backorder')::boolean, false);
      if (v_child ->> 'source') = 'erp' then v_any_erp := true; end if;

      v_possible := floor(coalesce((v_child ->> 'available')::numeric, 0) / v_per_unit);
      v_min := least(coalesce(v_min, v_possible), v_possible);
    end loop;

    return jsonb_build_object(
      'available',  coalesce(v_min, 0),
      'unknown',    v_unknown,
      'backorder',  v_backorder,
      'source',     case when v_any_erp then 'erp' else 'warehouse' end,
      'warehouses', 0);
  end if;

  -- ---- ¿Hay almacenes que sirvan a esta tienda? ---------------------------
  select count(*) into v_count from ebim.serving_warehouses(p_store_id);

  if v_count = 0 then
    -- Camino de CATALOGO: exactamente lo de antes de esta fase.
    if p_variant_id is not null then
      select coalesce(pv.stock, 0) into v_available
      from public.product_variants pv where pv.id = p_variant_id;
    else
      select coalesce(p.stock, 0) into v_available
      from public.products p where p.id = p_product_id;
    end if;

    return jsonb_build_object(
      'available',  coalesce(v_available, 0),
      'unknown',    false,
      'backorder',  false,
      'source',     'catalog',
      'warehouses', 0);
  end if;

  -- ---- Camino de ALMACEN --------------------------------------------------
  select
    coalesce(sum(
      case when x.is_unknown then 0
           else greatest(x.available_qty - x.safety_stock, 0) end), 0),
    coalesce(bool_or(x.is_unknown), false),
    coalesce(bool_or(x.allows_backorder), false),
    coalesce(bool_or(x.source = 'erp'), false),
    count(*)::integer
  into v_available, v_unknown, v_backorder, v_any_erp, v_count
  from (
    select l.available_qty,
           l.safety_stock,
           w.allows_backorder,
           w.source,
           (w.source = 'erp'
             and w.stale_after is not null
             and l.synced_at < now() - w.stale_after
             and w.stale_policy = 'unknown') as is_unknown
    from ebim.serving_warehouses(p_store_id) w
    join public.inventory_levels l
      on l.warehouse_id = w.warehouse_id
     and l.product_id   = p_product_id
     and l.variant_id is not distinct from p_variant_id
  ) x;

  return jsonb_build_object(
    'available',  coalesce(v_available, 0),
    'unknown',    coalesce(v_unknown, false),
    'backorder',  coalesce(v_backorder, false),
    'source',     case when v_any_erp then 'erp' else 'warehouse' end,
    'warehouses', coalesce(v_count, 0));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.take_units — EL reparto. Es la funcion critica de la fase.
--
-- `p_mode`:
--   · `reserve` — sube `reserved_qty`. No mueve mercancia: compromete.
--   · `issue`   — baja `on_hand_qty`. La mercancia sale.
--
-- Devuelve `{ ok, reason, allocations }`. No lanza excepcion por falta de
-- existencia: quien llama sabe que error de negocio corresponde (el checkout
-- dice `STOCK_INSUFICIENTE`, la reserva dice otra cosa) y traducir aqui seria
-- decidir el mensaje de una pantalla desde el motor.
--
-- `reason` distingue las dos negativas que NO son la misma:
--   · `insufficient` — se miro todo y no alcanza.
--   · `unknown`      — no alcanza con lo que se sabe, y hay un almacen cuya
--                      cifra caduco. Prometer aqui seria inventar.
-- ---------------------------------------------------------------------------
create or replace function ebim.take_units(
  p_store_id   uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_quantity   numeric,
  p_mode       text
)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_remaining numeric := p_quantity;
  v_alloc     jsonb   := '[]'::jsonb;
  v_row       record;
  v_take      numeric;
  v_after     numeric;
  v_skipped   boolean := false;
begin
  if p_mode not in ('reserve', 'issue') then
    raise exception 'MODO_INVALIDO: %', p_mode using errcode = '22023';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'CANTIDAD_INVALIDA: la cantidad a tomar debe ser mayor que cero'
      using errcode = '22023';
  end if;

  for v_row in
    select l.id as level_id,
           w.warehouse_id,
           (w.source = 'erp'
             and w.stale_after is not null
             and l.synced_at < now() - w.stale_after
             and w.stale_policy = 'unknown') as is_unknown
    from ebim.serving_warehouses(p_store_id) w
    join public.inventory_levels l
      on l.warehouse_id = w.warehouse_id
     and l.product_id   = p_product_id
     and l.variant_id is not distinct from p_variant_id
    order by w.priority, w.code
  loop
    exit when v_remaining <= 0;

    -- Cifra caducada con politica "no se sabe": este almacen no aporta y, si al
    -- final falta, la negativa sera `unknown` y no `insufficient`.
    if v_row.is_unknown then
      v_skipped := true;
      continue;
    end if;

    v_take  := null;
    v_after := null;

    if p_mode = 'reserve' then
      -- La CTE bloquea la fila Y la relee ya bloqueada: `take` sale de la cifra
      -- verdadera, no de una lectura anterior. Ver la cabecera del archivo.
      with locked as (
        select l.id,
               least(
                 v_remaining,
                 case when l.allow_backorder then v_remaining
                      else greatest(l.on_hand_qty - l.reserved_qty - l.safety_stock, 0) end
               ) as take
        from public.inventory_levels l
        where l.id = v_row.level_id
        for update
      )
      update public.inventory_levels l
         set reserved_qty = l.reserved_qty + k.take
        from locked k
       where l.id = k.id and k.take > 0
      returning k.take, l.on_hand_qty into v_take, v_after;
    else
      with locked as (
        select l.id,
               least(
                 v_remaining,
                 case when l.allow_backorder then v_remaining
                      else greatest(l.on_hand_qty - l.reserved_qty - l.safety_stock, 0) end
               ) as take
        from public.inventory_levels l
        where l.id = v_row.level_id
        for update
      )
      update public.inventory_levels l
         set on_hand_qty = l.on_hand_qty - k.take
        from locked k
       where l.id = k.id and k.take > 0
      returning k.take, l.on_hand_qty into v_take, v_after;
    end if;

    if v_take is null or v_take <= 0 then continue; end if;

    v_remaining := v_remaining - v_take;
    v_alloc := v_alloc || jsonb_build_object(
      'level_id',      v_row.level_id,
      'warehouse_id',  v_row.warehouse_id,
      'quantity',      v_take,
      'on_hand_after', v_after);
  end loop;

  if v_remaining > 0 then
    return jsonb_build_object(
      'ok', false,
      'reason', case when v_skipped then 'unknown' else 'insufficient' end,
      'allocations', v_alloc);
  end if;

  return jsonb_build_object('ok', true, 'reason', null, 'allocations', v_alloc);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.give_back_units — devolver lo tomado. Simetrica de `take_units`.
--
-- No necesita reparto: la reserva guardo de que nivel salio cada unidad
-- (`inventory_reservation_items`), y ahi es a donde vuelven. Devolverlas al
-- almacen "que toque hoy" descuadraria los dos.
-- ---------------------------------------------------------------------------
create or replace function ebim.give_back_units(
  p_level_id uuid,
  p_quantity numeric,
  p_mode     text
)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  if p_quantity is null or p_quantity <= 0 then return; end if;

  if p_mode = 'reserve' then
    update public.inventory_levels
       set reserved_qty = greatest(reserved_qty - p_quantity, 0)
     where id = p_level_id;
  elsif p_mode = 'issue' then
    update public.inventory_levels
       set on_hand_qty = on_hand_qty + p_quantity
     where id = p_level_id;
  else
    raise exception 'MODO_INVALIDO: %', p_mode using errcode = '22023';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.apply_movement — mover existencia dejando asiento, una sola vez.
--
-- `p_quantity` es un DELTA CON SIGNO sobre `on_hand_qty`.
--
-- **Idempotencia** (regla 4): con `p_external_ref`, si ya existe un asiento con
-- esa referencia en ese almacen se devuelve el que hay y NO se toca nada. Es lo
-- que hace que un webhook reenviado o una cola que reparte dos veces no
-- descuente dos veces. La comprobacion se apoya en el indice unico parcial, asi
-- que tampoco hay carrera entre dos reintentos simultaneos: el segundo choca.
-- ---------------------------------------------------------------------------
create or replace function ebim.apply_movement(
  p_level_id       uuid,
  p_kind           public.movement_kind,
  p_quantity       numeric,
  p_reason         text default null,
  p_reference_kind text default null,
  p_reference_id   uuid default null,
  p_external_ref   text default null,
  p_actor          uuid default null,
  p_source         public.inventory_source default 'local'
)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_level    public.inventory_levels%rowtype;
  v_existing public.inventory_movements%rowtype;
  v_after    numeric;
  v_id       uuid;
begin
  if p_quantity is null or p_quantity = 0 then
    raise exception 'CANTIDAD_INVALIDA: un movimiento de cero no es un movimiento'
      using errcode = '22023';
  end if;

  select * into v_level
  from public.inventory_levels l
  where l.id = p_level_id
  for update;

  if not found then
    raise exception 'EXISTENCIA_NO_ENCONTRADA: no hay nivel % en este almacen', p_level_id
      using errcode = '22023';
  end if;

  if p_external_ref is not null then
    select * into v_existing
    from public.inventory_movements m
    where m.organization_id = v_level.organization_id
      and m.company_id      = v_level.company_id
      and m.warehouse_id    = v_level.warehouse_id
      and m.external_ref    = p_external_ref;

    if found then
      return jsonb_build_object(
        'movement_id',   v_existing.id,
        'on_hand_after', v_existing.on_hand_after,
        'applied',       false);
    end if;
  end if;

  update public.inventory_levels
     set on_hand_qty = on_hand_qty + p_quantity,
         synced_at   = case when p_source = 'erp' then now() else synced_at end
   where id = p_level_id
  returning on_hand_qty into v_after;

  insert into public.inventory_movements (
    organization_id, company_id, warehouse_id, store_id, product_id, variant_id,
    level_id, kind, quantity, on_hand_after, reason,
    reference_kind, reference_id, external_ref, source, actor_id
  ) values (
    v_level.organization_id, v_level.company_id, v_level.warehouse_id, v_level.store_id,
    v_level.product_id, v_level.variant_id, v_level.id, p_kind, p_quantity, v_after,
    nullif(btrim(coalesce(p_reason, '')), ''),
    p_reference_kind, p_reference_id,
    nullif(btrim(coalesce(p_external_ref, '')), ''),
    p_source, p_actor
  )
  returning id into v_id;

  return jsonb_build_object('movement_id', v_id, 'on_hand_after', v_after, 'applied', true);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.log_allocation — asiento por cada trozo de un reparto ya aplicado.
--
-- `take_units` en modo `issue` ya movio `on_hand_qty` dentro de la sentencia
-- que decidia cuanto tomar; separar el asiento es lo que permite que la
-- decision y la escritura sigan siendo la misma sentencia. El saldo resultante
-- viaja en la asignacion, leido bajo el mismo bloqueo.
-- ---------------------------------------------------------------------------
create or replace function ebim.log_allocation(
  p_allocations    jsonb,
  p_kind           public.movement_kind,
  p_sign           integer,
  p_reason         text,
  p_reference_kind text,
  p_reference_id   uuid,
  p_actor          uuid
)
returns integer
language plpgsql
set search_path = ''
as $fn$
declare
  v_item  jsonb;
  v_level public.inventory_levels%rowtype;
  v_n     integer := 0;
begin
  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    select * into v_level
    from public.inventory_levels l
    where l.id = (v_item ->> 'level_id')::uuid;

    continue when not found;

    insert into public.inventory_movements (
      organization_id, company_id, warehouse_id, store_id, product_id, variant_id,
      level_id, kind, quantity, on_hand_after, reason,
      reference_kind, reference_id, actor_id
    ) values (
      v_level.organization_id, v_level.company_id, v_level.warehouse_id, v_level.store_id,
      v_level.product_id, v_level.variant_id, v_level.id, p_kind,
      p_sign * (v_item ->> 'quantity')::numeric,
      coalesce((v_item ->> 'on_hand_after')::numeric, v_level.on_hand_qty),
      p_reason, p_reference_kind, p_reference_id, p_actor
    );
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.expire_due_reservations — soltar lo que ya no vale.
--
-- Se llama SOLA, al principio de cada reserva y de cada pedido de la tienda, y
-- no solo desde un planificador. Es deliberado: este proyecto no tiene cron
-- garantizado, y una caducidad que depende de un job que puede no existir es
-- una caducidad que no existe. El coste es un `update` sobre un indice parcial
-- que en la inmensa mayoria de las llamadas no toca ni una fila.
-- ---------------------------------------------------------------------------
create or replace function ebim.expire_due_reservations(p_store_id uuid default null)
returns integer
language plpgsql
set search_path = ''
as $fn$
declare
  v_res   record;
  v_item  record;
  v_count integer := 0;
begin
  for v_res in
    select r.id
    from public.inventory_reservations r
    where r.status = 'held'
      and r.expires_at <= now()
      and (p_store_id is null or r.store_id = p_store_id)
    order by r.expires_at
    for update skip locked
  loop
    for v_item in
      select i.level_id, i.quantity
      from public.inventory_reservation_items i
      where i.reservation_id = v_res.id
    loop
      perform ebim.give_back_units(v_item.level_id, v_item.quantity, 'reserve');
    end loop;

    update public.inventory_reservations
       set status = 'expired', released_at = now(),
           release_reason = coalesce(release_reason, 'expired')
     where id = v_res.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.hold_stock — LA reserva. Atomica sobre el conjunto.
--
-- `p_items`: `[{ product_id, variant_id?, uom_code?, quantity }]`. La
-- presentacion se resuelve AQUI, contra `product_uoms`, por la misma razon que
-- en `create_order`: un factor que se puede pasar se puede pasar mal. Un kit se
-- expande a sus componentes.
--
-- **Idempotente por `reference_key`**: si ya hay una reserva viva con esa
-- referencia en esa tienda, se devuelve ESA. Reservar dos veces para el mismo
-- carrito —un reintento de red, un doble clic— no compromete el doble.
--
-- **O todas las lineas o ninguna**: la excepcion tumba la transaccion y con
-- ella lo ya comprometido. Media reserva es un carrito que el comprador cree
-- cerrado y no lo esta.
-- ---------------------------------------------------------------------------
create or replace function ebim.hold_stock(
  p_store_id       uuid,
  p_reference_kind text,
  p_reference_key  text,
  p_items          jsonb,
  p_ttl_seconds    integer,
  p_actor          uuid default null
)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_store       public.stores%rowtype;
  v_existing    public.inventory_reservations%rowtype;
  v_reservation uuid;
  v_token       text;
  v_expires     timestamptz;
  v_item        jsonb;
  v_product     public.products%rowtype;
  v_variant_id  uuid;
  v_uom_code    text;
  v_factor      numeric(18,6);
  v_qty         numeric;
  v_base        numeric;
  v_line        record;
  v_result      jsonb;
  v_alloc       jsonb;
  v_lines       jsonb := '[]'::jsonb;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'CADUCIDAD_INVALIDA: la reserva dura entre 60 y 86400 segundos'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ITEMS_REQUERIDOS: la reserva necesita al menos una linea'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > 100 then
    raise exception 'ITEMS_EXCESIVOS: maximo 100 lineas por reserva'
      using errcode = '22023';
  end if;

  select * into v_store
  from public.stores s
  where s.id = p_store_id and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda % no existe o no esta activa', p_store_id
      using errcode = '22023';
  end if;

  -- Antes de decir que no hay: soltar lo caducado de esta tienda.
  perform ebim.expire_due_reservations(p_store_id);

  -- Idempotencia de negocio.
  select * into v_existing
  from public.inventory_reservations r
  where r.store_id = p_store_id
    and r.reference_kind = p_reference_kind
    and lower(r.reference_key) = lower(p_reference_key)
    and r.status = 'held';

  if found then
    return jsonb_build_object(
      'reservation_id', v_existing.id,
      'token',          v_existing.token,
      'status',         v_existing.status,
      'expires_at',     v_existing.expires_at,
      'created',        false,
      'lines',          coalesce((
        select jsonb_agg(jsonb_build_object(
                 'product_id', i.product_id,
                 'variant_id', i.variant_id,
                 'warehouse_id', i.warehouse_id,
                 'quantity', i.quantity))
        from public.inventory_reservation_items i
        where i.reservation_id = v_existing.id), '[]'::jsonb));
  end if;

  v_expires := now() + make_interval(secs => p_ttl_seconds);

  insert into public.inventory_reservations (
    organization_id, company_id, store_id, reference_kind, reference_key,
    expires_at, created_by
  ) values (
    v_store.organization_id, v_store.company_id, v_store.id,
    p_reference_kind, p_reference_key, v_expires, p_actor
  )
  returning id, token into v_reservation, v_token;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'CANTIDAD_INVALIDA: la cantidad debe ser mayor que cero'
        using errcode = '22023';
    end if;

    select * into v_product
    from public.products p
    where p.id = ebim.safe_uuid(v_item ->> 'product_id')
      and p.store_id = v_store.id;

    if not found then
      raise exception 'PRODUCTO_NO_DISPONIBLE: %', coalesce(v_item ->> 'product_id', 'null')
        using errcode = '22023';
    end if;

    v_variant_id := ebim.safe_uuid(v_item ->> 'variant_id');

    if v_product.kind = 'variant' and v_variant_id is null then
      raise exception 'VARIANTE_REQUERIDA: % se vende por variante', v_product.sku
        using errcode = '22023';
    end if;
    if v_product.kind <> 'variant' and v_variant_id is not null then
      raise exception 'VARIANTE_NO_APLICA: % no tiene variantes', v_product.sku
        using errcode = '22023';
    end if;
    if v_variant_id is not null and not exists (
      select 1 from public.product_variants pv
      where pv.id = v_variant_id and pv.product_id = v_product.id and pv.is_active
    ) then
      raise exception 'VARIANTE_NO_DISPONIBLE: %', v_variant_id using errcode = '22023';
    end if;

    -- Presentacion -> unidades base. Misma regla que el pedido: una conversion
    -- que no da un entero de unidades base no se puede descontar sin inventarse
    -- un redondeo, asi que se rechaza.
    v_uom_code := nullif(upper(btrim(coalesce(v_item ->> 'uom_code', ''))), '');
    if v_uom_code is null then
      v_factor := 1;
    else
      select pu.factor into v_factor
      from public.product_uoms pu
      join public.units_of_measure u
        on u.id = pu.uom_id
       and u.organization_id = pu.organization_id
       and u.company_id      = pu.company_id
      where pu.product_id = v_product.id
        and upper(u.code) = v_uom_code
        and pu.is_sellable
        and u.is_active;

      if v_factor is null then
        raise exception 'UOM_NO_DISPONIBLE: % no se vende en la unidad %', v_product.sku, v_uom_code
          using errcode = '22023';
      end if;
    end if;

    v_base := v_qty * v_factor;
    if v_base <> trunc(v_base) then
      raise exception 'CANTIDAD_INVALIDA: % x % no da un numero entero de unidades base',
        v_qty, v_factor using errcode = '22023';
    end if;

    for v_line in
      select l.product_id, l.variant_id, l.quantity
      from ebim.expand_stock_lines(v_store.id, v_product.id, v_variant_id, v_base) l
    loop
      if v_line.quantity <> trunc(v_line.quantity) then
        raise exception 'KIT_CANTIDAD_INVALIDA: % necesita % unidades de un componente y no es un entero',
          v_product.sku, v_line.quantity using errcode = '22023';
      end if;

      v_result := ebim.take_units(
        v_store.id, v_line.product_id, v_line.variant_id, v_line.quantity, 'reserve');

      if not coalesce((v_result ->> 'ok')::boolean, false) then
        if (v_result ->> 'reason') = 'unknown' then
          raise exception 'DISPONIBILIDAD_DESCONOCIDA: % no se puede prometer ahora mismo', v_product.sku
            using errcode = '22023';
        end if;
        raise exception 'STOCK_INSUFICIENTE: % (no hay existencia suficiente para reservar)', v_product.sku
          using errcode = '22023';
      end if;

      for v_alloc in select * from jsonb_array_elements(v_result -> 'allocations')
      loop
        insert into public.inventory_reservation_items (
          organization_id, company_id, reservation_id, level_id, warehouse_id,
          product_id, variant_id, quantity
        ) values (
          v_store.organization_id, v_store.company_id, v_reservation,
          (v_alloc ->> 'level_id')::uuid, (v_alloc ->> 'warehouse_id')::uuid,
          v_line.product_id, v_line.variant_id, (v_alloc ->> 'quantity')::numeric
        );

        v_lines := v_lines || jsonb_build_object(
          'product_id',   v_line.product_id,
          'variant_id',   v_line.variant_id,
          'warehouse_id', (v_alloc ->> 'warehouse_id')::uuid,
          'quantity',     (v_alloc ->> 'quantity')::numeric);
      end loop;
    end loop;
  end loop;

  return jsonb_build_object(
    'reservation_id', v_reservation,
    'token',          v_token,
    'status',         'held',
    'expires_at',     v_expires,
    'created',        true,
    'lines',          v_lines);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.close_reservation — soltar o confirmar. Idempotente por construccion.
--
-- `p_status`: `released`, `expired` o `committed`.
--
-- **Soltar dos veces no libera el doble** (contrato del puerto): si la reserva
-- ya no esta `held`, se devuelve su estado y no se toca una sola unidad. La
-- comprobacion se hace con la fila BLOQUEADA, asi que dos liberaciones
-- simultaneas tampoco se cuelan las dos.
--
-- Confirmar convierte el compromiso en salida real: baja `reserved_qty` Y
-- `on_hand_qty` del MISMO nivel del que salio, y deja asiento. No se vuelve a
-- repartir: el reparto ya se decidio al reservar.
-- ---------------------------------------------------------------------------
create or replace function ebim.close_reservation(
  p_reservation_id uuid,
  p_status         public.reservation_status,
  p_reason         text default null,
  p_order_id       uuid default null,
  p_actor          uuid default null
)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_res   public.inventory_reservations%rowtype;
  v_item  record;
  v_after numeric;
  v_n     integer := 0;
begin
  if p_status not in ('released', 'expired', 'committed') then
    raise exception 'ESTADO_INVALIDO: %', p_status using errcode = '22023';
  end if;

  select * into v_res
  from public.inventory_reservations r
  where r.id = p_reservation_id
  for update;

  if not found then
    raise exception 'RESERVA_NO_ENCONTRADA: %', p_reservation_id using errcode = '22023';
  end if;

  if v_res.status <> 'held' then
    return jsonb_build_object(
      'reservation_id', v_res.id, 'status', v_res.status, 'changed', false, 'lines', 0);
  end if;

  for v_item in
    select i.id, i.level_id, i.quantity
    from public.inventory_reservation_items i
    where i.reservation_id = v_res.id
    order by i.created_at, i.id
  loop
    if p_status = 'committed' then
      -- Sale de verdad: baja lo comprometido y lo fisico a la vez, sobre la
      -- fila bloqueada. El CHECK anti-sobreventa vigila el resultado.
      update public.inventory_levels
         set reserved_qty = greatest(reserved_qty - v_item.quantity, 0),
             on_hand_qty  = on_hand_qty - v_item.quantity
       where id = v_item.level_id
      returning on_hand_qty into v_after;

      perform ebim.log_allocation(
        jsonb_build_array(jsonb_build_object(
          'level_id', v_item.level_id,
          'quantity', v_item.quantity,
          'on_hand_after', v_after)),
        'issue'::public.movement_kind, -1,
        coalesce(p_reason, 'reserva confirmada'),
        case when p_order_id is not null then 'order' else 'reservation' end,
        coalesce(p_order_id, v_res.id),
        p_actor);
    else
      perform ebim.give_back_units(v_item.level_id, v_item.quantity, 'reserve');
    end if;

    v_n := v_n + 1;
  end loop;

  update public.inventory_reservations
     set status         = p_status,
         committed_at   = case when p_status = 'committed' then now() else null end,
         released_at    = case when p_status = 'committed' then null else now() end,
         release_reason = case when p_status = 'committed' then null
                               else nullif(btrim(coalesce(p_reason, '')), '') end,
         order_id       = coalesce(p_order_id, order_id)
   where id = v_res.id;

  return jsonb_build_object(
    'reservation_id', v_res.id, 'status', p_status, 'changed', true, 'lines', v_n);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.consume_stock — la salida de existencia de un pedido.
--
-- Es la funcion que `create_order` llama en lugar de su viejo
-- `update products set stock = stock - n` (migracion 200300), y la que hace
-- posible la regla 10: **si la tienda no tiene almacenes que la sirvan, hace
-- exactamente lo de antes**, sobre `products.stock` / `product_variants.stock`,
-- con las mismas excepciones y el mismo texto. Un tenant que nunca abra la
-- pantalla de inventario no nota esta fase.
-- ---------------------------------------------------------------------------
create or replace function ebim.consume_stock(
  p_store_id   uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_base_qty   numeric,
  p_reference_kind text default 'order',
  p_reference_id   uuid default null,
  p_actor          uuid default null
)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_product   public.products%rowtype;
  v_count     integer;
  v_line      record;
  v_result    jsonb;
  v_available numeric;
  v_moves     integer := 0;
  v_sku       text;
begin
  select * into v_product
  from public.products p where p.id = p_product_id and p.store_id = p_store_id;

  if not found then
    raise exception 'PRODUCTO_NO_DISPONIBLE: %', coalesce(p_product_id::text, 'null')
      using errcode = '22023';
  end if;

  v_sku := v_product.sku;
  select count(*) into v_count from ebim.serving_warehouses(p_store_id);

  -- ---- Camino de ALMACEN --------------------------------------------------
  if v_count > 0 then
    for v_line in
      select l.product_id, l.variant_id, l.quantity
      from ebim.expand_stock_lines(p_store_id, p_product_id, p_variant_id, p_base_qty) l
    loop
      if v_line.quantity <> trunc(v_line.quantity) then
        raise exception 'KIT_CANTIDAD_INVALIDA: % necesita % unidades de un componente y no es un entero',
          v_sku, v_line.quantity using errcode = '22023';
      end if;

      v_result := ebim.take_units(
        p_store_id, v_line.product_id, v_line.variant_id, v_line.quantity, 'issue');

      if not coalesce((v_result ->> 'ok')::boolean, false) then
        if (v_result ->> 'reason') = 'unknown' then
          raise exception 'DISPONIBILIDAD_DESCONOCIDA: % no se puede prometer ahora mismo', v_sku
            using errcode = '22023';
        end if;
        raise exception 'STOCK_INSUFICIENTE: % (no hay existencia suficiente)', v_sku
          using errcode = '22023';
      end if;

      v_moves := v_moves + ebim.log_allocation(
        v_result -> 'allocations', 'issue'::public.movement_kind, -1,
        null, p_reference_kind, p_reference_id, p_actor);
    end loop;

    return jsonb_build_object('source', 'warehouse', 'movements', v_moves);
  end if;

  -- ---- Camino de CATALOGO (lo de siempre) ---------------------------------
  if v_product.kind = 'bundle' then
    for v_line in
      select l.product_id, l.variant_id, l.quantity
      from ebim.expand_stock_lines(p_store_id, p_product_id, p_variant_id, p_base_qty) l
    loop
      if v_line.quantity <> trunc(v_line.quantity) then
        raise exception 'KIT_CANTIDAD_INVALIDA: % necesita % unidades de un componente y no es un entero',
          v_sku, v_line.quantity using errcode = '22023';
      end if;

      if v_line.variant_id is not null then
        select pv.stock into v_available
        from public.product_variants pv where pv.id = v_line.variant_id for update;
      else
        select p2.stock into v_available
        from public.products p2 where p2.id = v_line.product_id for update;
      end if;

      if coalesce(v_available, 0) < v_line.quantity then
        raise exception 'STOCK_INSUFICIENTE: % (componente sin existencia suficiente)', v_sku
          using errcode = '22023';
      end if;

      if v_line.variant_id is not null then
        update public.product_variants
           set stock = stock - v_line.quantity::integer
         where id = v_line.variant_id;
      else
        update public.products
           set stock = stock - v_line.quantity::integer
         where id = v_line.product_id;
      end if;
    end loop;

  elsif p_variant_id is not null then
    select pv.stock into v_available
    from public.product_variants pv where pv.id = p_variant_id for update;

    if coalesce(v_available, 0) < p_base_qty then
      raise exception 'STOCK_INSUFICIENTE: % (disponible %, pedido %)',
        v_sku, coalesce(v_available, 0), p_base_qty using errcode = '22023';
    end if;

    update public.product_variants
       set stock = stock - p_base_qty::integer
     where id = p_variant_id;

  else
    select p2.stock into v_available
    from public.products p2 where p2.id = p_product_id for update;

    if coalesce(v_available, 0) < p_base_qty then
      raise exception 'STOCK_INSUFICIENTE: % (disponible %, pedido %)',
        v_sku, coalesce(v_available, 0), p_base_qty using errcode = '22023';
    end if;

    update public.products
       set stock = stock - p_base_qty::integer
     where id = p_product_id;
  end if;

  return jsonb_build_object('source', 'catalog', 'movements', 0);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Permisos del motor.
--
-- Nada de `ebim.*` se concede a `anon`: el comprador anonimo llega por las
-- puertas publicas de la migracion siguiente, que son `SECURITY DEFINER` y
-- llevan su autorizacion dentro. Dentro de una funcion definer el permiso que
-- cuenta es el del DUENO, asi que estas no necesitan GRANT para funcionar por
-- ese camino.
-- ---------------------------------------------------------------------------
revoke execute on function
  ebim.serving_warehouses(uuid),
  ebim.expand_stock_lines(uuid, uuid, uuid, numeric),
  ebim.atp(uuid, uuid, uuid),
  ebim.take_units(uuid, uuid, uuid, numeric, text),
  ebim.give_back_units(uuid, numeric, text),
  ebim.apply_movement(uuid, public.movement_kind, numeric, text, text, uuid, text, uuid, public.inventory_source),
  ebim.log_allocation(jsonb, public.movement_kind, integer, text, text, uuid, uuid),
  ebim.expire_due_reservations(uuid),
  ebim.hold_stock(uuid, text, text, jsonb, integer, uuid),
  ebim.close_reservation(uuid, public.reservation_status, text, uuid, uuid),
  ebim.consume_stock(uuid, uuid, uuid, numeric, text, uuid, uuid)
from public, anon, authenticated;

grant execute on function
  ebim.serving_warehouses(uuid),
  ebim.expand_stock_lines(uuid, uuid, uuid, numeric),
  ebim.atp(uuid, uuid, uuid)
to service_role;

comment on function ebim.take_units(uuid, uuid, uuid, numeric, text) is
  'Reparto entre almacenes. La cantidad a tomar se calcula DENTRO de la sentencia que escribe, sobre la fila ya bloqueada: no hay ventana entre leer y escribir.';
comment on function ebim.atp(uuid, uuid, uuid) is
  'Cuanto se puede prometer. Foto sin compromiso. unknown=true significa "no se sabe", nunca cero.';
comment on function ebim.hold_stock(uuid, text, text, jsonb, integer, uuid) is
  'Reserva atomica sobre el conjunto de lineas, idempotente por reference_key y con caducidad obligatoria.';
comment on function ebim.close_reservation(uuid, public.reservation_status, text, uuid, uuid) is
  'Suelta o confirma. Idempotente: sobre una reserva que ya no esta held no toca ni una unidad.';
comment on function ebim.consume_stock(uuid, uuid, uuid, numeric, text, uuid, uuid) is
  'Salida de existencia del pedido. Sin almacenes que sirvan a la tienda hace exactamente lo de antes sobre products.stock.';
