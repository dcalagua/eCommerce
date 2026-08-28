-- =============================================================================
-- P12-SaaS · 3/7 — El MOTOR: cobertura, tarifa, ventanas y eleccion de almacen
--
-- ## La regla que este archivo hace imposible romper
--
--   **El coste y la disponibilidad de un metodo de entrega se resuelven en el
--   servidor** (regla 3 del encargo).
--
-- No es una recomendacion: `delivery_rates` no tiene GRANT de SELECT para
-- `anon`, asi que el navegador NO PUEDE leer la tarifa aunque quiera. Lo unico
-- que puede hacer es preguntar «¿cuanto me cuesta llevar ESTO a AQUI?» y
-- recibir un importe ya calculado. Y el subtotal con el que se evalua el
-- umbral de envio gratis tampoco viaja en la pregunta: lo calcula esta misma
-- funcion llamando al motor de precios, porque un subtotal declarado por el
-- comprador es un envio gratis declarado por el comprador.
--
-- ## Las cinco decisiones que aqui se toman una sola vez
--
-- 1. **La zona gana por especificidad, no por orden de creacion.** Prefijo
--    postal mas largo, luego region declarada, luego `priority`. Sin esta regla
--    una zona «Peru» creada despues taparia a «Lima 15001».
-- 2. **`null` de peso no es cero.** Una tarifa por kilo sobre un catalogo que
--    no declara pesos NO se aplica: se descarta con motivo. Tratarlo como cero
--    regalaria el transporte de un palet.
-- 3. **Un metodo sin tarifa aplicable no es un metodo gratis**: es un metodo NO
--    disponible, con motivo. La alternativa —cobrar cero— convierte cada
--    agujero de configuracion en una perdida silenciosa.
-- 4. **Las ventanas se proyectan, no se almacenan.** La franja es semanal
--    (migracion 150000) y las fechas concretas salen de aqui a partir del plazo
--    prometido, respetando corte y aforo.
-- 5. **El almacen lo elige una regla configurable**, no una constante. Y un
--    punto de recojo con almacen propio MANDA sobre la regla: la mercancia
--    tiene que salir de donde el comprador va a ir.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 · ebim.delivery_zone_for — donde cae esta direccion.
--
-- Devuelve la zona MAS ESPECIFICA que cubre la direccion, o NULL si ninguna la
-- cubre —y NULL aqui significa «no llegamos», que es una respuesta legitima y
-- no un error—.
--
-- La comparacion de region pasa por `ebim.search_normalize` (P11): «Áncash» y
-- «ancash» son la misma region y el comprador escribe la que le sale.
-- ---------------------------------------------------------------------------
create or replace function ebim.delivery_zone_for(
  p_store_id uuid,
  p_country  text,
  p_region   text,
  p_postal   text
)
returns public.delivery_zones
language sql
stable
set search_path = ''
as $fn$
  select z.*
  from public.delivery_zones z
  where z.store_id = p_store_id
    and z.is_active
    and z.country = upper(btrim(coalesce(p_country, '')))
    -- Sin regiones declaradas, la zona cubre todo el pais.
    and (
      coalesce(array_length(z.regions, 1), 0) = 0
      or exists (
        select 1 from unnest(z.regions) as r(name)
        where ebim.search_normalize(r.name) = ebim.search_normalize(coalesce(p_region, ''))
          and ebim.search_normalize(coalesce(p_region, '')) <> ''
      )
    )
    -- Sin prefijos declarados, la zona cubre todo lo anterior.
    and (
      coalesce(array_length(z.postal_prefixes, 1), 0) = 0
      or exists (
        select 1 from unnest(z.postal_prefixes) as p(prefix)
        where btrim(coalesce(p_postal, '')) <> ''
          and btrim(coalesce(p_postal, '')) like p.prefix || '%'
      )
    )
  order by
    -- 1 · el prefijo mas LARGO que encaja. Es lo que hace que la tarifa de la
    --     ciudad le gane a la del pais.
    (
      select coalesce(max(char_length(p.prefix)), 0)
      from unnest(z.postal_prefixes) as p(prefix)
      where btrim(coalesce(p_postal, '')) <> ''
        and btrim(coalesce(p_postal, '')) like p.prefix || '%'
    ) desc,
    -- 2 · una zona que nombra la region es mas especifica que una que no.
    (coalesce(array_length(z.regions, 1), 0) > 0) desc,
    -- 3 · lo que el comercio declaro para desempatar.
    z.priority asc,
    z.code asc
  limit 1;
$fn$;

-- ---------------------------------------------------------------------------
-- 2 · ebim.basket_weight — cuanto pesa el carrito, y si se sabe.
--
-- Devuelve `{weight, known}`. `known = false` en cuanto UNA linea no declara
-- peso: un total parcial es peor que no tenerlo, porque parece una cifra.
--
-- La variante manda sobre el producto (dos tallas no pesan igual) y un kit
-- pesa lo que pesan sus componentes — por eso pasa por `ebim.expand_stock_lines`
-- (P06), que es la unica traduccion de kit a existencia real que hay en el
-- repositorio, en vez de una segunda copia de esa regla.
-- ---------------------------------------------------------------------------
create or replace function ebim.basket_weight(
  p_store_id uuid,
  p_lines    jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_line    jsonb;
  v_total   numeric(14,3) := 0;
  v_known   boolean := true;
  v_part    record;
  v_unit    numeric(12,3);
begin
  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    for v_part in
      select l.product_id, l.variant_id, l.quantity
      from ebim.expand_stock_lines(
             p_store_id,
             (v_line ->> 'product_id')::uuid,
             ebim.safe_uuid(v_line ->> 'variant_id'),
             coalesce((v_line ->> 'quantity')::numeric, 0)) l
    loop
      select coalesce(v.shipping_weight, p.shipping_weight) into v_unit
      from public.products p
      left join public.product_variants v on v.id = v_part.variant_id
      where p.id = v_part.product_id;

      if v_unit is null then
        v_known := false;
      else
        v_total := v_total + v_unit * v_part.quantity;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'weight', case when v_known then v_total::text else null end,
    'known',  v_known);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3 · ebim.delivery_rate_for — cuanto cuesta, y por que.
--
-- Devuelve `{amount, free, rate_id, zone_scoped}` o NULL si NINGUN renglon
-- aplica. NULL es informacion: significa «este metodo no puede servir esta
-- compra», y quien llama lo traduce a «no disponible» con motivo. Devolver cero
-- seria regalar el transporte cada vez que falta un renglon de tarifa.
--
-- El orden de precedencia es TOTAL y esta escrito, no emergente:
--   renglon con zona  >  renglon sin zona  >  menor `priority`  >  mas antiguo
--
-- Se elige el mas ESPECIFICO y no el mas barato a proposito: con «el mas
-- barato» un renglon olvidado abarata en silencio y nadie lo encuentra; con
-- este orden, la tarifa que se cobra se puede señalar con el dedo.
-- ---------------------------------------------------------------------------
create or replace function ebim.delivery_rate_for(
  p_method_id    uuid,
  p_zone_id      uuid,
  p_currency     char(3),
  p_subtotal     numeric,
  p_item_count   integer,
  p_weight       numeric,
  p_weight_known boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_rate   public.delivery_rates%rowtype;
  v_amount numeric(14,2);
  v_free   boolean := false;
begin
  select r.* into v_rate
  from public.delivery_rates r
  where r.delivery_method_id = p_method_id
    and r.is_active
    and r.currency = p_currency
    and (r.zone_id is null or r.zone_id = p_zone_id)
    and (r.min_subtotal is null or p_subtotal >= r.min_subtotal)
    and (r.max_subtotal is null or p_subtotal <= r.max_subtotal)
    -- Un tramo por peso sobre un carrito de peso desconocido NO aplica. Es la
    -- decision 2 de la cabecera: `null` no es cero.
    and (r.min_weight is null or (p_weight_known and p_weight >= r.min_weight))
    and (r.max_weight is null or (p_weight_known and p_weight <= r.max_weight))
    -- Y una tarifa POR KILO tampoco: cobrar la base sola seria cobrar de menos
    -- sin que nadie se entere.
    and (r.per_weight_amount = 0 or p_weight_known)
  order by
    (r.zone_id is not null) desc,
    r.priority asc,
    r.created_at asc
  limit 1;

  if not found then
    return null;
  end if;

  if v_rate.free_over_subtotal is not null and p_subtotal >= v_rate.free_over_subtotal then
    v_amount := 0;
    v_free   := true;
  else
    v_amount := round(
      v_rate.base_amount
      + v_rate.per_item_amount * greatest(coalesce(p_item_count, 0), 0)
      + v_rate.per_weight_amount * case when p_weight_known then coalesce(p_weight, 0) else 0 end,
      2);
  end if;

  return jsonb_build_object(
    'rate_id',     v_rate.id,
    'amount',      v_amount::text,
    'free',        v_free,
    'zone_scoped', v_rate.zone_id is not null);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4 · ebim.delivery_windows_for — las franjas concretas de los proximos dias.
--
-- La franja guardada es SEMANAL; esto la proyecta sobre fechas reales desde el
-- primer dia prometido. Dos filtros que no son cosmeticos:
--
--  · **corte**: una franja que empieza dentro de menos de `cutoff_minutes` ya
--    no se puede pedir, porque nadie llega a prepararla;
--  · **aforo**: si `capacity` esta declarado y ya hay esas entregas planificadas
--    para esa fecha y franja, no se ofrece. Ofrecer una franja llena es
--    prometer una hora que no se va a cumplir.
-- ---------------------------------------------------------------------------
create or replace function ebim.delivery_windows_for(
  p_method_id uuid,
  p_point_id  uuid,
  p_from      date,
  p_days      integer default 14,
  p_limit     integer default 20
)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(slot order by slot_date, starts_at), '[]'::jsonb)
  from (
    select
      d.day::date as slot_date,
      w.starts_at,
      jsonb_build_object(
        'window_id', w.id,
        'date',      d.day::date,
        'starts_at', w.starts_at,
        'ends_at',   w.ends_at,
        'capacity',  w.capacity) as slot
    from generate_series(p_from, p_from + (greatest(p_days, 1) - 1), interval '1 day') as d(day)
    join public.delivery_windows w
      on w.delivery_method_id = p_method_id
     and w.is_active
     and w.weekday = extract(dow from d.day)::smallint
     -- NULL en el punto = la franja vale para todos; con valor, solo para ese.
     and (w.pickup_point_id is null or w.pickup_point_id is not distinct from p_point_id)
    where (d.day + w.starts_at) >= now() + make_interval(mins => w.cutoff_minutes)
      and (
        w.capacity is null
        or (
          select count(*)
          from public.fulfillments f
          where f.delivery_method_id = w.delivery_method_id
            and f.window_date      = d.day::date
            and f.window_starts_at = w.starts_at
            and f.state <> 'cancelled'
        ) < w.capacity
      )
    order by d.day, w.starts_at
    limit greatest(p_limit, 1)
  ) slots;
$fn$;

-- ---------------------------------------------------------------------------
-- 5 · ebim.delivery_options — LA autoridad de cotizacion de entrega.
--
-- Una sola funcion para la vitrina, el checkout y el backoffice, por la misma
-- razon que `ebim.resolve_prices` es una sola para las tres pantallas de
-- precio: dos implementaciones del mismo calculo se separan el dia que una se
-- corrige.
--
-- Devuelve TODAS las opciones activas, incluidas las NO disponibles y con su
-- motivo. Filtrar aqui las que no se pueden ofrecer dejaria a la vitrina sin
-- forma de decir «a tu distrito no llegamos con express, pero si con estandar»,
-- que es la mitad de la informacion util.
-- ---------------------------------------------------------------------------
create or replace function ebim.delivery_options(
  p_store_id uuid,
  p_address  jsonb,
  p_lines    jsonb,
  p_subtotal numeric
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_store    public.stores%rowtype;
  v_zone     public.delivery_zones%rowtype;
  v_method   public.delivery_methods%rowtype;
  v_weight   jsonb;
  v_known    boolean;
  v_kg       numeric(14,3);
  v_items    integer;
  v_rate     jsonb;
  v_options  jsonb := '[]'::jsonb;
  v_points   jsonb;
  v_from     date;
  v_to       date;
  v_available boolean;
  v_reason   text;
  v_amount   text;
  v_free     boolean;
begin
  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: no hay tienda con ese identificador'
      using errcode = '22023';
  end if;

  v_zone   := ebim.delivery_zone_for(
                p_store_id,
                p_address ->> 'country',
                p_address ->> 'region',
                p_address ->> 'postal_code');
  v_weight := ebim.basket_weight(p_store_id, p_lines);
  v_known  := coalesce((v_weight ->> 'known')::boolean, false);
  v_kg     := coalesce((v_weight ->> 'weight')::numeric, 0);

  select coalesce(sum(greatest(coalesce((l ->> 'quantity')::numeric, 0), 0)), 0)::integer
    into v_items
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as l;

  for v_method in
    select m.*
    from public.delivery_methods m
    where m.store_id = p_store_id and m.is_active
    order by m.position, m.code
  loop
    v_available := true;
    v_reason    := null;
    v_amount    := '0.00';
    v_free      := false;
    v_points    := '[]'::jsonb;

    -- Plazo prometido, ya resuelto a fechas. Dias naturales: los habiles
    -- dependen del calendario de feriados de cada pais y ese calendario no
    -- existe todavia en este producto. Prometer de mas es peor que prometer
    -- de menos, asi que la aproximacion cae del lado seguro.
    v_from := (now() at time zone 'utc')::date + v_method.lead_time_min_days;
    v_to   := (now() at time zone 'utc')::date + v_method.lead_time_max_days;

    if v_method.strategy = 'digital' then
      -- No se mueve nada: ni zona, ni tarifa, ni direccion. Cobrar transporte
      -- por una descarga seria cobrar por un camion que no sale.
      v_from := (now() at time zone 'utc')::date;
      v_to   := v_from;

    elsif v_method.strategy = 'pickup' then
      -- El recojo no necesita cobertura de la direccion del comprador: la
      -- direccion que importa es la del PUNTO. Lo que si necesita es que haya
      -- al menos un punto activo, o es una opcion que no se puede elegir.
      select coalesce(jsonb_agg(jsonb_build_object(
               'pickup_point_id', pp.id,
               'code',            pp.code,
               'name',            pp.name,
               'address',         pp.address,
               'contact_phone',   pp.contact_phone,
               'opening_hours',   pp.opening_hours
             ) order by pp.position, pp.code), '[]'::jsonb)
        into v_points
      from public.pickup_points pp
      where pp.store_id = p_store_id and pp.is_active
        and (v_zone.id is null or pp.zone_id is null or pp.zone_id = v_zone.id);

      if jsonb_array_length(v_points) = 0 then
        v_available := false;
        v_reason    := 'SIN_PUNTOS_DE_RECOJO';
      end if;

      v_rate := ebim.delivery_rate_for(
                  v_method.id, v_zone.id, v_store.currency,
                  coalesce(p_subtotal, 0), v_items, v_kg, v_known);
      -- Un recojo sin renglon de tarifa es GRATIS y no «no disponible»: no hay
      -- transporte que cobrar. Es la unica estrategia donde la ausencia de
      -- tarifa tiene una lectura evidente.
      if v_rate is not null then
        v_amount := v_rate ->> 'amount';
        v_free   := coalesce((v_rate ->> 'free')::boolean, false);
      end if;

    else
      -- `ship` y `local_delivery`: hace falta cobertura y hace falta tarifa.
      if v_zone.id is null then
        v_available := false;
        v_reason    := 'FUERA_DE_COBERTURA';
      else
        v_rate := ebim.delivery_rate_for(
                    v_method.id, v_zone.id, v_store.currency,
                    coalesce(p_subtotal, 0), v_items, v_kg, v_known);
        if v_rate is null then
          v_available := false;
          -- Se distingue el motivo porque las acciones son distintas: sin peso
          -- lo arregla el catalogo, sin tarifa lo arregla la configuracion.
          v_reason := case when not v_known then 'PESO_NO_DECLARADO' else 'SIN_TARIFA' end;
        else
          v_amount := v_rate ->> 'amount';
          v_free   := coalesce((v_rate ->> 'free')::boolean, false);
        end if;
      end if;
    end if;

    v_options := v_options || jsonb_build_array(jsonb_build_object(
      'delivery_method_id', v_method.id,
      'code',               v_method.code,
      'name',               v_method.display_name,
      'description',        v_method.description,
      'instructions',       v_method.instructions,
      'strategy',           v_method.strategy,
      'available',          v_available,
      'reason',             v_reason,
      'currency',           v_store.currency,
      'amount',             case when v_available then v_amount else null end,
      'free',               v_free,
      'zone_code',          v_zone.code,
      'promised_from',      v_from,
      'promised_to',        v_to,
      'requires_window',    v_method.requires_window,
      'pickup_points',      v_points,
      'windows',
        case
          when v_available and v_method.strategy <> 'digital'
            then ebim.delivery_windows_for(v_method.id, null, v_from)
          else '[]'::jsonb
        end));
  end loop;

  return jsonb_build_object(
    'currency',   v_store.currency,
    'zone',       case when v_zone.id is null then null
                       else jsonb_build_object('code', v_zone.code, 'name', v_zone.name) end,
    'weight',     v_weight,
    'item_count', v_items,
    'options',    v_options);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6 · ebim.quote_delivery_choice — la cotizacion de UNA opcion ya elegida.
--
-- Es la que llama `create_order` (migracion 150600) y la que llama la etapa 7
-- del pipeline. Recibe el CODIGO que eligio el comprador y devuelve el importe
-- que se le va a cobrar, recalculado con la fila delante.
--
-- Existe separada de `delivery_options` por una razon de correccion y no de
-- comodidad: el checkout no puede confiar en el importe que la vitrina enseño
-- hace diez minutos —el carrito pudo cambiar, el umbral de gratis pudo
-- cruzarse— y tampoco puede recorrer todos los metodos para encontrar el suyo.
-- ---------------------------------------------------------------------------
create or replace function ebim.quote_delivery_choice(
  p_store_id    uuid,
  p_method_code text,
  p_address     jsonb,
  p_lines       jsonb,
  p_subtotal    numeric,
  p_point_id    uuid default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_all    jsonb;
  v_option jsonb;
  v_code   text := lower(btrim(coalesce(p_method_code, '')));
  v_point  public.pickup_points%rowtype;
begin
  if v_code = '' then
    raise exception 'ENTREGA_NO_INDICADA: falta el metodo de entrega'
      using errcode = '22023';
  end if;

  v_all := ebim.delivery_options(p_store_id, p_address, p_lines, p_subtotal);

  select o into v_option
  from jsonb_array_elements(v_all -> 'options') as o
  where o ->> 'code' = v_code
  limit 1;

  if v_option is null then
    raise exception 'ENTREGA_NO_DISPONIBLE: "%" no es un metodo de entrega activo de esta tienda', v_code
      using errcode = '22023';
  end if;

  if not coalesce((v_option ->> 'available')::boolean, false) then
    raise exception 'DIRECCION_NO_ENTREGABLE: %',
      coalesce(v_option ->> 'reason', 'FUERA_DE_COBERTURA')
      using errcode = '22023';
  end if;

  -- El punto de recojo se comprueba contra la FILA, no contra la lista que
  -- viajo al navegador: entre que se pinto y que se compra, el comercio pudo
  -- desactivarlo.
  if (v_option ->> 'strategy') = 'pickup' then
    if p_point_id is null then
      raise exception 'PUNTO_DE_RECOJO_REQUERIDO: este metodo exige elegir donde recoger'
        using errcode = '22023';
    end if;
    select * into v_point
    from public.pickup_points pp
    where pp.id = p_point_id and pp.store_id = p_store_id and pp.is_active;
    if not found then
      raise exception 'PUNTO_DE_RECOJO_NO_VALIDO: ese punto no existe o no esta activo'
        using errcode = '22023';
    end if;
  elsif p_point_id is not null then
    raise exception 'PUNTO_DE_RECOJO_NO_APLICA: este metodo no es de recojo'
      using errcode = '22023';
  end if;

  return v_option || jsonb_build_object(
    'zone',       v_all -> 'zone',
    'weight',     v_all -> 'weight',
    'item_count', v_all -> 'item_count');
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7 · ebim.select_warehouse — de donde sale la mercancia (regla 4).
--
-- Dos entradas y una precedencia clara:
--
--  1. **El punto de recojo manda.** Si cuelga de un almacen, sale de ahi. Que
--     una regla de abastecimiento decidiera otro almacen produciria el caso
--     peor del comercio fisico: el comprador va a la tienda y la mercancia se
--     descontó del deposito.
--  2. Si no, la ESTRATEGIA del metodo, que es configuracion y no constante:
--     `store_priority` toma el primero del orden declarado en P06 y
--     `single_warehouse_atp` el primero que puede servir el pedido ENTERO.
--
-- Devuelve NULL cuando la tienda no tiene almacenes servidores. NULL es la
-- respuesta honesta: un tenant sin el modulo de multialmacen lleva la
-- existencia en `products.stock` (P02) y no hay almacen que apuntar.
-- ---------------------------------------------------------------------------
create or replace function ebim.select_warehouse(
  p_store_id uuid,
  p_sourcing public.sourcing_strategy,
  p_point_id uuid,
  p_lines    jsonb
)
returns uuid
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_point     public.pickup_points%rowtype;
  v_first     uuid;
  v_warehouse record;
  v_line      jsonb;
  v_part      record;
  v_ok        boolean;
  v_have      numeric;
begin
  if p_point_id is not null then
    select * into v_point from public.pickup_points pp where pp.id = p_point_id;
    if found and v_point.warehouse_id is not null then
      return v_point.warehouse_id;
    end if;
  end if;

  for v_warehouse in select * from ebim.serving_warehouses(p_store_id) loop
    if v_first is null then
      v_first := v_warehouse.warehouse_id;
    end if;

    exit when p_sourcing <> 'single_warehouse_atp';

    v_ok := true;
    for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
      for v_part in
        select l.product_id, l.variant_id, l.quantity
        from ebim.expand_stock_lines(
               p_store_id,
               (v_line ->> 'product_id')::uuid,
               ebim.safe_uuid(v_line ->> 'variant_id'),
               coalesce((v_line ->> 'quantity')::numeric, 0)) l
      loop
        select coalesce(sum(greatest(il.available_qty - il.safety_stock, 0)), 0)
          into v_have
        from public.inventory_levels il
        where il.warehouse_id = v_warehouse.warehouse_id
          and il.product_id   = v_part.product_id
          and il.variant_id is not distinct from v_part.variant_id;

        if v_have < v_part.quantity then
          v_ok := false;
          exit;
        end if;
      end loop;
      exit when not v_ok;
    end loop;

    if v_ok then
      return v_warehouse.warehouse_id;
    end if;
  end loop;

  -- Ninguno lo tiene todo: se cae al primero del orden declarado. Partir el
  -- pedido entre almacenes es una decision de operacion —cuesta dos envios— y
  -- la toma una persona desde la cola de preparacion, no esta funcion.
  return v_first;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8 · Las dos puertas publicas. Dos funciones y no una con bandera, por la
-- misma razon que en precios y en inventario: cada una tiene su propia
-- autorizacion DENTRO, y una bandera es un parametro que se puede pasar mal.
-- ---------------------------------------------------------------------------

-- La del comprador ANONIMO. El navegador dice a donde y que quiere comprar;
-- todo lo demas lo pone el servidor: la tienda (activa), el canal (el publico
-- por defecto), el subtotal (motor de precios) y la tarifa.
create or replace function public.delivery_options_for_slug(
  p_store_slug text,
  p_address    jsonb,
  p_items      jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store   public.stores%rowtype;
  v_channel public.channels%rowtype;
  v_quote   jsonb;
  v_slug    text := lower(btrim(coalesce(p_store_slug, '')));
begin
  select * into v_store
  from public.stores s
  where lower(s.slug) = v_slug and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  select * into v_channel
  from public.channels c
  where c.store_id = v_store.id and c.is_default and c.is_active;

  if not found then
    raise exception 'CANAL_NO_DISPONIBLE: la tienda % no tiene canal por defecto activo', v_store.slug
      using errcode = '22023';
  end if;

  if v_channel.requires_auth then
    raise exception 'CANAL_NO_PUBLICO: el canal por defecto de % exige sesion', v_store.slug
      using errcode = '22023';
  end if;

  -- EL SUBTOTAL NO VIENE DEL NAVEGADOR. Se recalcula con el mismo motor que
  -- cotiza el carrito, porque de el depende el umbral de envio gratis: si
  -- llegara en la peticion, el envio gratis lo decidiria el comprador.
  v_quote := ebim.build_quote(v_store.id, v_channel.id, p_items, null, null, now(), true);

  return ebim.delivery_options(
    v_store.id,
    coalesce(p_address, '{}'::jsonb),
    coalesce(v_quote -> 'lines', '[]'::jsonb),
    (v_quote ->> 'subtotal')::numeric);
end;
$fn$;

-- La del BACKOFFICE, sobre un pedido que ya existe. Sirve para replanificar una
-- entrega —el comprador cambio de direccion, el primer intento fallo— y por eso
-- toma el subtotal y las lineas del PEDIDO y no de un payload: replanificar no
-- es una excusa para recotizar la compra.
create or replace function public.delivery_options_for_order(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
  v_lines jsonb;
begin
  select * into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con ese identificador'
      using errcode = '22023';
  end if;

  if not ebim.can_access(v_order.organization_id, v_order.company_id) then
    raise exception 'SIN_PERMISO: ese pedido no es de una sociedad a la que tengas acceso'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', oi.product_id,
           'variant_id', oi.variant_id,
           'quantity',   oi.quantity)), '[]'::jsonb)
    into v_lines
  from public.order_items oi
  where oi.order_id = v_order.id;

  return ebim.delivery_options(
    v_order.store_id, v_order.shipping_address, v_lines, v_order.subtotal);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9 · Permisos. Lo interno se queda dentro; lo publico tiene su autorizacion.
-- ---------------------------------------------------------------------------
revoke execute on function
  ebim.delivery_zone_for(uuid, text, text, text),
  ebim.basket_weight(uuid, jsonb),
  ebim.delivery_rate_for(uuid, uuid, char, numeric, integer, numeric, boolean),
  ebim.delivery_windows_for(uuid, uuid, date, integer, integer),
  ebim.delivery_options(uuid, jsonb, jsonb, numeric),
  ebim.quote_delivery_choice(uuid, text, jsonb, jsonb, numeric, uuid),
  ebim.select_warehouse(uuid, public.sourcing_strategy, uuid, jsonb)
from public, anon, authenticated;

grant execute on function
  ebim.delivery_zone_for(uuid, text, text, text),
  ebim.basket_weight(uuid, jsonb),
  ebim.delivery_rate_for(uuid, uuid, char, numeric, integer, numeric, boolean),
  ebim.delivery_windows_for(uuid, uuid, date, integer, integer),
  ebim.delivery_options(uuid, jsonb, jsonb, numeric),
  ebim.quote_delivery_choice(uuid, text, jsonb, jsonb, numeric, uuid),
  ebim.select_warehouse(uuid, public.sourcing_strategy, uuid, jsonb)
to service_role;

revoke execute on function
  public.delivery_options_for_slug(text, jsonb, jsonb),
  public.delivery_options_for_order(uuid)
from public;

grant execute on function public.delivery_options_for_slug(text, jsonb, jsonb)
  to anon, authenticated, service_role;
grant execute on function public.delivery_options_for_order(uuid)
  to authenticated, service_role;

comment on function ebim.delivery_options(uuid, jsonb, jsonb, numeric) is
  'LA autoridad de cotizacion de entrega: cobertura, tarifa, plazo y franjas. Una sola para vitrina, checkout y backoffice.';
comment on function public.delivery_options_for_slug(text, jsonb, jsonb) is
  'Opciones de entrega del comprador anonimo. El subtotal se recalcula aqui dentro: el umbral de envio gratis no lo declara el navegador.';
comment on function ebim.select_warehouse(uuid, public.sourcing_strategy, uuid, jsonb) is
  'De que almacen sale. El punto de recojo manda sobre la estrategia; NULL = la tienda no tiene almacenes servidores.';
