-- =============================================================================
-- P12-SaaS · 7/7 — El pedido aprende a cobrar el TRANSPORTE y a nacer con su
--                  promesa de entrega
--
-- ## Por que se vuelven a escribir enteras
--
-- Postgres no sabe anadir un parametro a una funcion: hay que dejarla caer y
-- volver a crearla. Es lo mismo que hicieron P03, P04, P06, P08 y P10 con estas
-- tres funciones, y el motivo de que la copia la haga un script
-- (`scripts/build-p12-create-order.mjs`) en vez de un par de manos: el script
-- parte de la version vigente y falla si un ancla no aparece exactamente una
-- vez, asi que una diferencia silenciosa entre la version anterior y esta no
-- puede colarse.
--
-- ## Que cambia, exactamente
--
-- 1. `create_order` acepta `p_delivery` — una ELECCION, nunca un importe— y
--    cotiza la entrega con `ebim.quote_delivery_choice`. El resultado va a
--    `orders.shipping_total`, que existia desde P02 y valia siempre cero.
-- 2. El coste entra en `grand_total` ANTES del umbral de aprobacion B2B: lo
--    que la empresa paga incluye el transporte.
-- 3. Nace el fulfillment, en la MISMA transaccion, con todas las lineas.
-- 4. La respuesta lleva `shipping_total` y `delivery`, y el hecho
--    `order.created` del outbox tambien: un ERP necesita el transporte
--    separado porque tributa distinto.
--
-- ## Lo que NO cambia, y es la mitad del valor
--
-- `orders` no gana ni una columna. Ni transportista, ni guia, ni metodo de
-- entrega: eso vive en `fulfillments`, que apunta al pedido. Y sin
-- `p_delivery` el comportamiento es EXACTAMENTE el de P10 —transporte cero,
-- sin fulfillment—, asi que la Edge Function `create-order`, sus tests y
-- cualquier tenant que no configure entregas siguen funcionando sin tocar nada.
-- =============================================================================


-- Se dejan caer las DOS firmas vivas: la de P08 (doce argumentos) por si esta
-- base viene de antes de P10, y la de P10 (trece), que es la que hay hoy. Sin
-- la segunda, `create or replace` no basta: anadir un parametro con valor por
-- defecto crea una sobrecarga y las llamadas quedan ambiguas.
drop function if exists public.create_order(
  uuid, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb);
drop function if exists public.create_order(uuid, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb, text[]);

create function public.create_order(
  p_store_id            uuid,
  p_customer_email      text,
  p_items               jsonb,
  p_customer_name       text default null,
  p_customer_phone      text default null,
  p_shipping_address    jsonb default '{}'::jsonb,
  p_notes               text default null,
  p_reservation_token   text default null,
  -- ---- P08-SaaS. Los cuatro los pone el SERVIDOR, nunca el navegador -------
  -- `p_source_channel`: por que puerta entro el pedido. Lo declara la funcion
  -- de borde que atiende esa puerta, no quien la usa.
  p_source_channel      text  default 'storefront',
  -- `p_business_account_id`: la cuenta B2B que resolvio la SESION del
  -- comprador (`my_business_accounts()`, sin parametros desde P05). Aqui se
  -- vuelve a comprobar que sea del tenant de la tienda.
  p_business_account_id uuid  default null,
  -- `p_billing_address`: direccion fiscal. Sin ella se congela la de envio.
  p_billing_address     jsonb default null,
  -- `p_approval`: lo que el borde averiguo preguntando con el JWT del
  -- comprador. Solo puede AÑADIR una aprobacion, nunca quitarla: el umbral de
  -- la cuenta lo decide esta funcion con la fila delante.
  p_approval            jsonb default null,
  -- ---- P10-SaaS -----------------------------------------------------------
  -- `p_coupon_codes`: lo UNICO que el comprador teclea y lo unico de las
  -- promociones que entra desde fuera. No lleva importe, ni campana, ni
  -- "aplicada": que descuente y cuanto lo decide `ebim.evaluate_promotions`
  -- dentro de esta transaccion (regla 6 del encargo).
  p_coupon_codes        text[] default null,
  -- ---- P12-SaaS -----------------------------------------------------------
  -- `p_delivery`: la ELECCION de entrega del comprador, nunca su precio.
  -- {"method_code": "...", "pickup_point_id": uuid?, "window": {...}?}
  -- Cuanto cuesta lo decide `ebim.quote_delivery_choice` aqui dentro, con el
  -- subtotal recien calculado y la fila de tarifa delante. NULL = la tienda no
  -- cobra transporte, que es lo que pasaba antes de esta fase.
  p_delivery            jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store       public.stores%rowtype;
  v_channel     public.channels%rowtype;
  v_scoped      boolean := false;
  v_inclusive   boolean := false;
  v_order_id    uuid := gen_random_uuid();
  v_seq         bigint;
  v_number      text;
  v_token       text;
  v_subtotal    numeric(14,2) := 0;
  v_tax         numeric(14,2) := 0;
  v_item        jsonb;
  v_product     public.products%rowtype;
  v_variant     public.product_variants%rowtype;
  v_has_variant boolean;
  v_uom_code    text;
  v_uom_id      uuid;
  v_factor      numeric(18,6);
  v_priced      jsonb;
  v_unit_price  numeric(14,2);
  v_base_qty    numeric(18,6);
  v_qty         integer;
  v_rate        numeric(6,4);
  v_amount      numeric(14,2);
  v_reservation public.inventory_reservations%rowtype;
  v_res_id      uuid := null;
  v_res_item    record;
  v_email       text := lower(btrim(coalesce(p_customer_email, '')));
  v_lines       jsonb := '[]'::jsonb;
  v_normalized  jsonb;
  -- ---- P08-SaaS ---------------------------------------------------------
  v_source      public.order_source_channel;
  v_source_txt  text := lower(btrim(coalesce(p_source_channel, 'storefront')));
  v_account     public.business_accounts%rowtype;
  v_customer    public.customers%rowtype;
  v_approval    public.order_approval_status := 'not_required';
  v_appr_reason text;
  v_snapshot    jsonb;
  -- ---- P12-SaaS ---------------------------------------------------------
  v_option      jsonb := null;   -- la opcion de entrega ya cotizada
  v_ship        numeric(14,2) := 0;
  v_ful         uuid := null;
  v_billing     jsonb;
  v_shipping    jsonb;
  v_grand       numeric(14,2);
  v_var_label   text;
  v_var_attrs   jsonb;
  v_tax_code    text;
  v_components  jsonb;
  -- ---- P10-SaaS ---------------------------------------------------------
  v_discount    numeric(14,2) := 0;
  v_promotions  jsonb := '{}'::jsonb;
  v_totals      jsonb;
begin
  if v_email = '' or position('@' in v_email) < 2 then
    raise exception 'EMAIL_REQUERIDO: el pedido necesita un correo de contacto valido'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ITEMS_REQUERIDOS: el pedido necesita al menos una linea'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > 100 then
    raise exception 'ITEMS_EXCESIVOS: maximo 100 lineas por pedido'
      using errcode = '22023';
  end if;

  -- El origen se comprueba contra las etiquetas del enum. Convertir a ciegas
  -- daria un `invalid input value for enum` (22P02) sin codigo de dominio, que
  -- es un 500 disfrazado para la pantalla que lo recibe.
  if not exists (
    select 1 from unnest(enum_range(null::public.order_source_channel)::text[]) as label
    where label = v_source_txt
  ) then
    raise exception 'ORIGEN_NO_VALIDO: "%" no es un origen de pedido', p_source_channel
      using errcode = '22023';
  end if;
  v_source := v_source_txt::public.order_source_channel;

  -- La lista negra crece con las llaves del inventario. Elegir almacen es
  -- elegir de donde sale la mercancia; nombrar una reserva o un nivel es
  -- nombrar filas internas. Las tres las decide el servidor.
  if exists (
    select 1
    from jsonb_array_elements(p_items) as item,
         jsonb_object_keys(item) as k
    where k in ('price', 'unit_price', 'line_total', 'subtotal', 'total',
                'currency', 'organization_id', 'company_id', 'store_id',
                'order_id', 'tenant_id', 'tax_rate', 'tax_total',
                'tax_category_id', 'channel_id',
                'uom_id', 'uom_factor', 'factor', 'base_quantity', 'sku',
                'segment_id', 'customer_id', 'price_list_id', 'price_source',
                'warehouse_id', 'reservation_id', 'level_id', 'stock', 'available',
                'discount', 'discount_amount', 'discount_total', 'discount_snapshot',
                'promotion_id', 'promotion_code', 'coupon_id', 'gift_card_id')
  ) then
    raise exception 'CAMPO_NO_PERMITIDO: el precio, el canal, la lista, el factor, el almacen, el descuento y el tenant los decide el servidor, no el payload'
      using errcode = '22023';
  end if;

  select * into v_store
  from public.stores s
  where s.id = p_store_id and s.status = 'active'
  for update;

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda % no existe o no esta activa', p_store_id
      using errcode = '22023';
  end if;

  perform ebim.assert_checkout_allowed(v_store.id, v_email);

  -- ---- La cuenta corporativa, si el borde resolvio una -------------------
  -- Segunda comprobacion del tenant: el borde ya la saco de la sesion, y aqui
  -- se exige ademas que sea de ESTA sociedad. Un uuid mal copiado no puede
  -- acabar firmando el pedido de otro comercio.
  if p_business_account_id is not null then
    select * into v_account
    from public.business_accounts a
    where a.id              = p_business_account_id
      and a.organization_id = v_store.organization_id
      and a.company_id      = v_store.company_id
      and a.is_active;

    if not found then
      raise exception 'CUENTA_NO_APLICA: esa cuenta corporativa no es de esta tienda'
        using errcode = '22023';
    end if;

    select * into v_customer from public.customers c where c.id = v_account.customer_id;
  end if;

  -- Antes de mirar existencia: soltar lo que caduco. Sin esto, un carrito
  -- abandonado hace media hora seguiria impidiendo vender.
  perform ebim.expire_due_reservations(v_store.id);

  -- ---- La reserva del comprador, si la trae -------------------------------
  if p_reservation_token is not null and btrim(p_reservation_token) <> '' then
    select * into v_reservation
    from public.inventory_reservations r
    where r.store_id = v_store.id and r.token = p_reservation_token
    for update;

    if not found then
      raise exception 'RESERVA_NO_ENCONTRADA: no hay ninguna reserva con esos datos'
        using errcode = '22023';
    end if;

    if v_reservation.status <> 'held' then
      raise exception 'RESERVA_NO_VIGENTE: esa reserva ya se uso o caduco'
        using errcode = '22023';
    end if;

    -- Devolver al fondo comun DENTRO de esta transaccion. Las filas de
    -- existencia quedan bloqueadas hasta el commit, asi que nadie puede colarse
    -- entre la devolucion y el consumo de mas abajo.
    for v_res_item in
      select i.level_id, i.quantity
      from public.inventory_reservation_items i
      where i.reservation_id = v_reservation.id
    loop
      perform ebim.give_back_units(v_res_item.level_id, v_res_item.quantity, 'reserve');
    end loop;

    v_res_id := v_reservation.id;
  end if;

  select * into v_channel
  from public.channels c
  where c.store_id = v_store.id
    and c.is_default
    and c.is_active;

  if not found then
    raise exception 'CANAL_NO_DISPONIBLE: la tienda % no tiene canal por defecto activo', v_store.slug
      using errcode = '22023';
  end if;

  if v_channel.requires_auth then
    raise exception 'CANAL_NO_PUBLICO: el canal por defecto de % exige sesion', v_store.slug
      using errcode = '22023';
  end if;

  select exists (
    select 1 from public.product_channels pc where pc.channel_id = v_channel.id
  ) into v_scoped;

  select coalesce(ss.tax_inclusive, false) into v_inclusive
  from public.store_settings ss where ss.store_id = v_store.id;
  v_inclusive := coalesce(v_inclusive, false);

  select coalesce(
           jsonb_agg(jsonb_build_object(
             'product_id', product_id,
             'variant_id', variant_id,
             'uom_code',   uom_code,
             'quantity',   quantity
           )),
           '[]'::jsonb)
    into v_normalized
  from (
    select (item ->> 'product_id')                    as product_id,
           nullif(btrim(coalesce(item ->> 'variant_id', '')), '') as variant_id,
           nullif(upper(btrim(coalesce(item ->> 'uom_code', ''))), '') as uom_code,
           sum((item ->> 'quantity')::numeric)::integer as quantity
    from jsonb_array_elements(p_items) as item
    group by 1, 2, 3
  ) grouped;

  for v_item in select * from jsonb_array_elements(v_normalized)
  loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'CANTIDAD_INVALIDA: la cantidad debe ser un entero mayor que cero'
        using errcode = '22023';
    end if;

    select * into v_product
    from public.products p
    where p.id = ebim.safe_uuid(v_item ->> 'product_id')
      and p.store_id = v_store.id
      and p.status = 'published'
      and p.published_at is not null
      and p.published_at <= now()
    for update;

    if not found then
      raise exception 'PRODUCTO_NO_DISPONIBLE: %', coalesce(v_item ->> 'product_id', 'null')
        using errcode = '22023';
    end if;

    if v_scoped and not exists (
      select 1 from public.product_channels pc
      where pc.channel_id = v_channel.id and pc.product_id = v_product.id
    ) then
      raise exception 'PRODUCTO_FUERA_DE_CANAL: % no esta a la venta en el canal %',
        v_product.sku, v_channel.code
        using errcode = '22023';
    end if;

    if v_product.currency <> v_store.currency then
      raise exception 'MONEDA_INCONSISTENTE: % esta en % y la tienda en %',
        v_product.sku, v_product.currency, v_store.currency
        using errcode = '22023';
    end if;

    -- ---- Variante ---------------------------------------------------------
    v_has_variant := (v_item ->> 'variant_id') is not null;

    if v_product.kind = 'variant' and not v_has_variant then
      raise exception 'VARIANTE_REQUERIDA: % se vende por variante y el pedido no dice cual', v_product.sku
        using errcode = '22023';
    end if;

    if v_product.kind <> 'variant' and v_has_variant then
      raise exception 'VARIANTE_NO_APLICA: % no tiene variantes', v_product.sku
        using errcode = '22023';
    end if;

    if v_has_variant then
      select * into v_variant
      from public.product_variants pv
      where pv.id = ebim.safe_uuid(v_item ->> 'variant_id')
        and pv.product_id = v_product.id
        and pv.is_active
      for update;

      if not found then
        raise exception 'VARIANTE_NO_DISPONIBLE: %', coalesce(v_item ->> 'variant_id', 'null')
          using errcode = '22023';
      end if;
    else
      v_variant := null;
    end if;

    -- ---- Unidad de venta --------------------------------------------------
    v_uom_code := v_item ->> 'uom_code';

    if v_uom_code is null then
      v_uom_id := null;
      v_factor := 1;
    else
      select pu.uom_id, pu.factor into v_uom_id, v_factor
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

    -- ---- Precio: UNA sola autoridad ---------------------------------------
    v_priced := ebim.resolve_price(
      v_store.id,
      v_channel.id,
      v_product.id,
      case when v_has_variant then v_variant.id else null end,
      v_uom_id,
      v_qty,
      v_store.currency,
      now(),
      null,
      null
    );

    if v_priced is null or v_priced ->> 'unit_price' is null then
      raise exception 'PRECIO_NO_RESUELTO: % no tiene un precio aplicable', v_product.sku
        using errcode = '22023';
    end if;

    v_unit_price := (v_priced ->> 'unit_price')::numeric;

    v_base_qty := v_qty * v_factor;
    if v_base_qty <> trunc(v_base_qty) then
      raise exception 'CANTIDAD_INVALIDA: % x % no da un numero entero de unidades base',
        v_qty, v_factor
        using errcode = '22023';
    end if;

    -- ---- Existencia: una sola llamada, dos caminos por debajo --------------
    -- Con almacenes que sirvan a la tienda, reparte y deja asiento; sin ellos,
    -- descuenta `products.stock` exactamente como antes de esta fase.
    perform ebim.consume_stock(
      v_store.id,
      v_product.id,
      case when v_has_variant then v_variant.id else null end,
      v_base_qty,
      'order',
      v_order_id,
      null
    );

    v_rate := coalesce(
      ebim.effective_tax_rate(v_store.id, v_product.tax_category_id, now()),
      0
    );

    -- ---- Lo que se congela de esta linea ---------------------------------
    -- El CODIGO de la categoria fiscal y no su uuid: es snapshot. Si mañana el
    -- tenant borra la categoria o la reasigna, el pedido tiene que seguir
    -- diciendo bajo que regimen se vendio.
    select tc.code into v_tax_code
    from public.tax_categories tc where tc.id = v_product.tax_category_id;

    if v_has_variant then
      v_var_label := v_variant.name;
      -- La combinacion que ES la variante (talla, color...), por codigo de
      -- atributo. Consultable aunque despues se borre la variante entera.
      select coalesce(jsonb_object_agg(a.code, jsonb_build_object(
               'attribute', a.name,
               'code',      av.code,
               'label',     av.label)), '{}'::jsonb)
        into v_var_attrs
      from public.variant_attribute_values vav
      join public.attributes       a  on a.id  = vav.attribute_id
      join public.attribute_values av on av.id = vav.value_id
      where vav.variant_id = v_variant.id;
    else
      v_var_label := null;
      v_var_attrs := '{}'::jsonb;
    end if;

    if v_product.kind = 'bundle' then
      -- La receta, congelada. Un kit no tiene existencia propia: si la receta
      -- cambia despues de vender, sin esto no queda registro de que salio.
      select coalesce(jsonb_agg(jsonb_build_object(
               'product_id', bi.component_product_id,
               'variant_id', bi.component_variant_id,
               'sku',        coalesce(pv.sku, cp.sku),
               'name',       case when pv.id is null then cp.name
                                  else cp.name || ' · ' || pv.name end,
               'quantity',   bi.quantity::text,
               'uom_code',   u.code
             ) order by bi.position, bi.component_product_id), '[]'::jsonb)
        into v_components
      from public.bundle_items bi
      join public.products cp on cp.id = bi.component_product_id
      left join public.product_variants pv on pv.id = bi.component_variant_id
      left join public.units_of_measure  u on u.id  = bi.uom_id
      where bi.bundle_product_id = v_product.id;
    else
      v_components := '[]'::jsonb;
    end if;

    v_amount := round(v_unit_price * v_qty, 2);

    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product.id,
      'variant_id', case when v_has_variant then v_variant.id else null end,
      'sku',        case when v_has_variant then v_variant.sku else v_product.sku end,
      'name',       case when v_has_variant
                         then v_product.name || ' · ' || v_variant.name
                         else v_product.name end,
      'unit_price', v_unit_price::text,
      'quantity',   v_qty,
      'uom_code',   v_uom_code,
      'uom_factor', v_factor::text,
      'amount',     v_amount::text,
      'tax_rate',   v_rate::text,
      'price_source',  v_priced ->> 'source',
      'price_list_id', v_priced ->> 'price_list_id',
      'price_list_code', v_priced ->> 'price_list_code',
      'variant_label',      v_var_label,
      'variant_attributes', v_var_attrs,
      'tax_category_code',  v_tax_code,
      'components',         v_components
    );
  end loop;

  -- ---- Las lineas, NUMERADAS ----------------------------------------------
  -- El motor de promociones necesita poder devolver "esta linea" y no "este
  -- producto": dos lineas del mismo producto en distinta presentacion son dos
  -- lineas, y un descuento que no supiera distinguirlas se aplicaria dos veces
  -- o ninguna.
  select coalesce(jsonb_agg(line || jsonb_build_object('line_key', ord) order by ord), '[]'::jsonb)
    into v_lines
  from jsonb_array_elements(v_lines) with ordinality as t(line, ord);

  -- ---- P10 - Promociones, y aqui SI con los cerrojos puestos --------------
  --
  -- Es la SEGUNDA evaluacion de esta compra: la primera fue la del carrito, que
  -- solo ensenaba. Esta es la que decide, y por eso pasa `p_lock := true`: las
  -- campanas y los cupones con tope de uso se bloquean antes de contarse, asi
  -- que dos compras simultaneas no gastan el mismo ultimo uso.
  --
  -- El navegador NO puede declarar que una promocion se aplico. Lo unico que
  -- llega de fuera son los CODIGOS de cupon, que es lo unico que el comprador
  -- tiene que poder teclear; todo lo demas -campanas vigentes, alcance,
  -- audiencia, prioridad, combinacion y limites- sale de la base.
  v_promotions := ebim.evaluate_promotions(
    v_store.id,
    v_channel.id,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'line_key',   (line ->> 'line_key')::integer,
              'product_id', line ->> 'product_id',
              'variant_id', line ->> 'variant_id',
              'quantity',   line ->> 'quantity',
              'unit_price', line ->> 'unit_price',
              'amount',     line ->> 'amount',
              'tax_rate',   line ->> 'tax_rate')), '[]'::jsonb)
     from jsonb_array_elements(v_lines) as line),
    p_coupon_codes,
    v_customer.id,
    null,
    v_account.id,
    v_email,
    now(),
    true);

  -- El descuento se pega a la linea junto con su POR QUE. Sin
  -- `discount_snapshot`, dentro de un ano nadie puede explicar por que ese
  -- pedido costo eso: la campana puede haberse borrado.
  select coalesce(jsonb_agg(
           line || jsonb_build_object(
             'discount',          coalesce(d.entry ->> 'discount', '0'),
             'discount_snapshot', coalesce(d.entry -> 'adjustments', '[]'::jsonb))
           order by (line ->> 'line_key')::integer), '[]'::jsonb)
    into v_lines
  from jsonb_array_elements(v_lines) as line
  left join lateral (
    select e as entry
    from jsonb_array_elements(coalesce(v_promotions -> 'lines', '[]'::jsonb)) as e
    where (e ->> 'line_key')::integer = (line ->> 'line_key')::integer
    limit 1
  ) d on true;

  -- ---- Los totales, con UNA sola autoridad fiscal -------------------------
  --
  -- Hasta P09 el reparto del impuesto por grupo de tasa y su distribucion por
  -- linea vivian AQUI, escritos dos veces (aqui y en `ebim.build_quote`). Con
  -- descuentos hay una tercera pregunta -sobre que base se calcula el
  -- impuesto- y mantener dos copias de la respuesta seria garantizar que un dia
  -- discrepen. `ebim.promotion_totals` es esa unica copia, y con descuento cero
  -- devuelve EXACTAMENTE los mismos numeros que este bloque devolvia: por eso
  -- ningun pedido de P02 a P09 cambia ni un centimo.
  v_totals := ebim.promotion_totals(
    (select coalesce(jsonb_agg(jsonb_build_object(
              'line_key', (line ->> 'line_key')::integer,
              'amount',   line ->> 'amount',
              'discount', line ->> 'discount',
              'tax_rate', line ->> 'tax_rate')), '[]'::jsonb)
     from jsonb_array_elements(v_lines) as line),
    v_inclusive);

  v_subtotal := (v_totals ->> 'subtotal')::numeric;
  v_discount := (v_totals ->> 'discount_total')::numeric;
  v_tax      := (v_totals ->> 'tax_total')::numeric;
  v_grand    := (v_totals ->> 'grand_total')::numeric;

  -- ---- P12 · La ENTREGA, resuelta en el SERVIDOR --------------------------
  --
  -- `p_delivery` trae una eleccion y jamas un importe. El coste sale de
  -- `ebim.quote_delivery_choice`, que vuelve a comprobar cobertura, tarifa,
  -- tramo y umbral de gratuidad con el subtotal que el motor acaba de calcular
  -- —no con el que viera la vitrina hace diez minutos, que pudo cambiar—.
  --
  -- Se suma ANTES del umbral de aprobacion B2B a proposito: lo que la empresa
  -- paga incluye el transporte, y dejarlo fuera haria que un pedido cruzara el
  -- limite sin pedir firma.
  --
  -- Sin `p_delivery`, transporte CERO y ningun fulfillment: un tenant que no
  -- ha configurado entregas vende exactamente como antes de P12.
  if p_delivery is not null
     and nullif(btrim(coalesce(p_delivery ->> 'method_code', '')), '') is not null then
    v_option := ebim.quote_delivery_choice(
      v_store.id,
      p_delivery ->> 'method_code',
      coalesce(p_shipping_address, '{}'::jsonb),
      v_lines,
      v_subtotal,
      ebim.safe_uuid(p_delivery ->> 'pickup_point_id'));
    v_ship  := coalesce((v_option ->> 'amount')::numeric, 0);
    v_grand := v_grand + v_ship;
  end if;

  select coalesce(jsonb_agg(
           line || jsonb_build_object('tax_amount', coalesce(f.entry ->> 'tax_amount', '0.00'))
           order by (line ->> 'line_key')::integer), '[]'::jsonb)
    into v_lines
  from jsonb_array_elements(v_lines) as line
  left join lateral (
    select e as entry
    from jsonb_array_elements(coalesce(v_totals -> 'lines', '[]'::jsonb)) as e
    where (e ->> 'line_key')::integer = (line ->> 'line_key')::integer
    limit 1
  ) f on true;
  -- ---- ¿Hace falta que alguien autorice esta compra? ----------------------
  --
  -- Dos fuentes, y la de la base manda:
  --
  --  · **el umbral de la CUENTA** lo decide esta funcion, con la fila delante.
  --    No depende de que ningun llamante se acuerde de preguntarlo.
  --  · **el limite de la PERSONA** solo se puede saber donde hay sesion, y aqui
  --    no la hay: esta funcion corre con `service_role` y `ebim.user_id()` es
  --    NULL. Lo resuelve el borde llamando a `public.purchase_approval` con el
  --    JWT del comprador, y llega en `p_approval`.
  --
  -- `p_approval` solo puede AÑADIR una aprobacion; no existe forma de que
  -- quite la que el umbral de la cuenta impone. Un payload manipulado no
  -- convierte una compra que necesita firma en una que no.
  if v_account.id is not null then
    if v_account.requires_approval
       and (v_account.approval_threshold is null or v_grand >= v_account.approval_threshold)
    then
      v_approval    := 'pending';
      v_appr_reason := 'account_threshold';
    elsif lower(btrim(coalesce(p_approval ->> 'required', ''))) in ('true', 't', '1') then
      v_approval    := 'pending';
      v_appr_reason := nullif(left(btrim(coalesce(p_approval ->> 'reason', '')), 1000), '');
    end if;
  end if;

  -- ---- Los snapshots del pedido -------------------------------------------
  v_shipping := coalesce(p_shipping_address, '{}'::jsonb);
  if jsonb_typeof(v_shipping) <> 'object' then
    raise exception 'DIRECCION_NO_VALIDA: la direccion de envio tiene que ser un objeto'
      using errcode = '22023';
  end if;

  -- Sin direccion fiscal declarada se factura donde se entrega, que es lo que
  -- pasa en el 99% de las compras B2C. Copiar es mejor que dejarla vacia: una
  -- factura sin direccion no se puede emitir.
  v_billing := coalesce(p_billing_address, v_shipping);
  if jsonb_typeof(v_billing) <> 'object' then
    raise exception 'DIRECCION_NO_VALIDA: la direccion de facturacion tiene que ser un objeto'
      using errcode = '22023';
  end if;

  -- El cliente, tal y como se identifico. Sale del correo y el nombre que
  -- escribio el comprador y, si hay cuenta corporativa, de la ficha que el
  -- SERVIDOR resolvio a partir de ella. `orders` sigue SIN `customer_id`
  -- (decision de P05, intacta): esa columna solo la podria rellenar el
  -- navegador en una compra anonima. Aqui es un SNAPSHOT, no una referencia
  -- viva, y por eso puede llevar los datos sin abrir esa puerta.
  v_snapshot := jsonb_strip_nulls(jsonb_build_object(
    'email',        v_email,
    'name',         nullif(btrim(coalesce(p_customer_name, '')), ''),
    'phone',        nullif(btrim(coalesce(p_customer_phone, '')), ''),
    'customer_id',   v_customer.id,
    'customer_code', v_customer.code,
    'customer_name', v_customer.name,
    'legal_name',    v_customer.legal_name,
    'tax_id',        v_customer.tax_id,
    'account_id',    v_account.id,
    'account_code',  v_account.code,
    'account_name',  v_account.name));

  update public.stores
     set order_seq = order_seq + 1
   where id = v_store.id
  returning order_seq into v_seq;

  v_number := 'EC-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(v_seq::text, 5, '0');

  insert into public.orders (
    id, organization_id, company_id, store_id, channel_id, order_number, status,
    customer_email, customer_name, customer_phone, currency,
    subtotal, tax_total, shipping_total, discount_total, grand_total,
    shipping_address, notes,
    source_channel, business_account_id, approval_status, approval_reason,
    tax_inclusive, billing_address, shipping_address_snapshot, customer_snapshot
  ) values (
    v_order_id, v_store.organization_id, v_store.company_id, v_store.id, v_channel.id,
    v_number, 'pending',
    v_email, nullif(btrim(coalesce(p_customer_name, '')), ''),
    nullif(btrim(coalesce(p_customer_phone, '')), ''), v_store.currency,
    v_subtotal, v_tax, v_ship, v_discount, v_grand,
    v_shipping, nullif(btrim(coalesce(p_notes, '')), ''),
    v_source, v_account.id, v_approval, v_appr_reason,
    v_inclusive, v_billing, v_shipping, v_snapshot
  );

  insert into public.order_tokens (order_id, organization_id, company_id)
  values (v_order_id, v_store.organization_id, v_store.company_id)
  returning token into v_token;

  insert into public.order_items (
    organization_id, company_id, store_id, order_id,
    product_id, variant_id, sku, name, unit_price, quantity, uom_code, uom_factor,
    price_source, price_list_id,
    variant_label, variant_attributes, tax_rate, tax_amount, tax_inclusive,
    tax_category_code, price_list_code, components_snapshot,
    discount_amount, discount_snapshot
  )
  select
    v_store.organization_id, v_store.company_id, v_store.id, v_order_id,
    (line ->> 'product_id')::uuid,
    ebim.safe_uuid(line ->> 'variant_id'),
    line ->> 'sku', line ->> 'name',
    (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
    line ->> 'uom_code', (line ->> 'uom_factor')::numeric,
    coalesce(line ->> 'price_source', 'catalog'),
    ebim.safe_uuid(line ->> 'price_list_id'),
    line ->> 'variant_label',
    coalesce(line -> 'variant_attributes', '{}'::jsonb),
    (line ->> 'tax_rate')::numeric,
    (line ->> 'tax_amount')::numeric,
    v_inclusive,
    line ->> 'tax_category_code',
    line ->> 'price_list_code',
    coalesce(line -> 'components', '[]'::jsonb),
    coalesce((line ->> 'discount')::numeric, 0),
    coalesce(line -> 'discount_snapshot', '[]'::jsonb)
  from jsonb_array_elements(v_lines) as line;

  -- ---- P10 - El canje, en ESTA transaccion --------------------------------
  --
  -- Apuntar quien uso que campana y mover el contador de usos pasa DESPUES de
  -- que el pedido exista y ANTES del commit. Los cerrojos que tomo
  -- `evaluate_promotions` siguen puestos, asi que entre contar y gastar no cabe
  -- otra transaccion: es lo que hace que "maximo 100 usos" sean 100 y no 101.
  perform ebim.redeem_promotions(
    v_order_id,
    coalesce(v_promotions -> 'applied', '[]'::jsonb),
    v_customer.id,
    v_account.id);

  -- La reserva acabo en este pedido. Sus unidades ya salieron por los asientos
  -- de arriba; lo que queda es dejar dicho donde acabo.
  if v_res_id is not null then
    update public.inventory_reservations
       set status = 'committed', committed_at = now(), order_id = v_order_id
     where id = v_res_id;
  end if;

  -- ---- P12 · La promesa de entrega, en ESTA transaccion -------------------
  --
  -- El fulfillment nace CON el pedido y no despues, por la misma razon que el
  -- canje de promociones: entre dos transacciones cabe un proceso muerto, y el
  -- estado que deja —«pedido cobrado del que nadie sabe como sale»— es
  -- precisamente el que este proyecto no puede tener.
  --
  -- Lleva TODAS las lineas. Partirlo en dos entregas es una decision de
  -- operacion que se toma despues, con `fulfillment_create`, y que no cobra
  -- transporte de mas porque el reparto de `shipping_total` es estructural.
  if v_option is not null then
    v_ful := ebim.plan_fulfillment(v_order_id, v_option, coalesce(p_delivery, '{}'::jsonb));
  end if;

  return jsonb_build_object(
    'order_id',       v_order_id,
    'order_number',   v_number,
    'access_token',   v_token,
    'status',         'pending',
    'currency',       v_store.currency,
    'channel',        v_channel.code,
    'subtotal',       v_subtotal::text,
    'tax_total',      v_tax::text,
    'discount_total', v_discount::text,
    'shipping_total', v_ship::text,
    'grand_total',    v_grand::text,
    -- P12: el comprador tiene derecho a ver COMO le llega y CUANDO, en la misma
    -- respuesta en la que se le dice cuanto pago. Sin entrega configurada es
    -- `null`, que es distinto de un objeto vacio: no se eligio nada.
    'delivery', case when v_option is null then null else jsonb_strip_nulls(jsonb_build_object(
      'fulfillment_id', v_ful,
      'method_code',    v_option ->> 'code',
      'method_name',    v_option ->> 'name',
      'strategy',       v_option ->> 'strategy',
      'amount',         v_option ->> 'amount',
      'currency',       v_option ->> 'currency',
      'promised_from',  v_option ->> 'promised_from',
      'promised_to',    v_option ->> 'promised_to')) end,
    'tax_inclusive',  v_inclusive,
    'items',          v_lines,
    -- P08: el comprador tiene que enterarse EN LA RESPUESTA de que su compra
    -- espera una firma. Descubrirlo dias despues, cuando no llega nada, es la
    -- version cara del mismo dato.
    'source_channel',  v_source,
    'approval_status', v_approval,
    'approval_reason', v_appr_reason,
    -- P10: el desglose viaja con el pedido. El comprador tiene derecho a saber
    -- que campana le rebajo cuanto y, lo que casi nunca se devuelve, por que su
    -- cupon no hizo nada.
    'promotions', jsonb_build_object(
      'applied', coalesce(v_promotions -> 'applied', '[]'::jsonb),
      'skipped', coalesce(v_promotions -> 'skipped', '[]'::jsonb),
      'coupons', coalesce(v_promotions -> 'coupons', '[]'::jsonb))
  );
end;
$fn$;
revoke execute on function
  public.create_order(uuid, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb, text[], jsonb)
from public, anon, authenticated;

grant execute on function
  public.create_order(uuid, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb, text[], jsonb)
to service_role;

comment on function
  public.create_order(uuid, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb, text[], jsonb) is
  'Crea el pedido, aplica promociones, cotiza la ENTREGA en el servidor y planifica su fulfillment, todo en una transaccion. Del payload no se acepta precio, canal, lista, factor, almacen, tenant, origen, descuento ni COSTE DE ENVIO: solo codigos y elecciones.';

-- ===========================================================================
-- create_order_for_slug — arrastra la eleccion de entrega, sin interpretarla
-- ===========================================================================

drop function if exists public.create_order_for_slug(
  text, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb);
drop function if exists public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb, text[]);

create function public.create_order_for_slug(
  p_store_slug          text,
  p_customer_email      text,
  p_items               jsonb,
  p_customer_name       text default null,
  p_customer_phone      text default null,
  p_shipping_address    jsonb default '{}'::jsonb,
  p_notes               text default null,
  p_reservation_token   text default null,
  p_source_channel      text  default 'storefront',
  p_business_account_id uuid  default null,
  p_billing_address     jsonb default null,
  p_approval            jsonb default null,
  p_coupon_codes        text[] default null,
  -- P12: se ARRASTRA sin interpretarla, igual que los cupones. Esta funcion no
  -- sabe que es una entrega; solo sabe resolver la tienda por slug.
  p_delivery            jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store_id uuid;
  v_slug     text := lower(btrim(coalesce(p_store_slug, '')));
begin
  if v_slug = '' then
    raise exception 'TIENDA_NO_DISPONIBLE: falta la tienda del pedido'
      using errcode = '22023';
  end if;

  select s.id into v_store_id
  from public.stores s
  where lower(s.slug) = v_slug
    and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  return public.create_order(
    v_store_id,
    p_customer_email,
    p_items,
    p_customer_name,
    p_customer_phone,
    p_shipping_address,
    p_notes,
    p_reservation_token,
    p_source_channel,
    p_business_account_id,
    p_billing_address,
    p_approval,
    p_coupon_codes,
    p_delivery
  );
end;
$fn$;
revoke execute on function
  public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb, text[], jsonb)
from public, anon, authenticated;

grant execute on function
  public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb, text[], jsonb)
to service_role;

comment on function
  public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb, text[], jsonb) is
  'Checkout publico: resuelve la tienda por slug (solo activa) y delega en create_order, arrastrando reserva, origen, cuenta B2B, direccion fiscal, cupones y la eleccion de entrega. Solo service_role.';

-- ===========================================================================
-- checkout_place_order — la quinta cosa que pasa junta: el fulfillment
-- ===========================================================================

drop function if exists public.checkout_place_order(
  uuid, text, jsonb, text, text, jsonb, text, text, jsonb, uuid, jsonb, jsonb);

drop function if exists public.checkout_place_order(uuid, text, jsonb, text, text, jsonb, text, text, jsonb, uuid, jsonb, jsonb, text[]);

create function public.checkout_place_order(
  p_intent_id           uuid,
  p_customer_email      text,
  p_items               jsonb,
  p_customer_name       text default null,
  p_customer_phone      text default null,
  p_shipping_address    jsonb default '{}'::jsonb,
  p_notes               text default null,
  p_reservation_token   text default null,
  p_payment             jsonb default null,
  p_business_account_id uuid  default null,
  p_billing_address     jsonb default null,
  p_approval            jsonb default null,
  -- P10: los codigos que el comprador tecleo en el carrito. Viajan como TEXTO
  -- y sin importe: cuanto descuentan lo decide `create_order`.
  p_coupon_codes        text[] default null,
  -- P12: la eleccion de entrega que resolvio la etapa 7 del pipeline. Viaja sin
  -- importe: el coste lo recalcula `create_order` dentro de la transaccion.
  p_delivery            jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_intent   public.checkout_intents%rowtype;
  v_store    public.stores%rowtype;
  v_order    jsonb;
  v_order_id uuid;
  v_cart     public.carts%rowtype;
  v_payment  jsonb;
begin
  select * into v_intent
  from public.checkout_intents i
  where i.id = p_intent_id
  for update;

  if not found then
    raise exception 'INTENTO_NO_ENCONTRADO: no hay ningun intento de compra con esos datos'
      using errcode = '22023';
  end if;

  if v_intent.status = 'succeeded' then
    return v_intent.result || jsonb_build_object('replay', true, 'intent_id', v_intent.id);
  end if;

  if v_intent.status <> 'running' then
    raise exception 'INTENTO_NO_VIGENTE: ese intento de compra ya se cerro'
      using errcode = '22023';
  end if;

  select * into v_store from public.stores s where s.id = v_intent.store_id;

  v_order := public.create_order(
    v_store.id,
    p_customer_email,
    p_items,
    p_customer_name,
    p_customer_phone,
    p_shipping_address,
    p_notes,
    p_reservation_token,
    -- El origen de este camino es la vitrina, y no se acepta de nadie: esta
    -- funcion la llama exclusivamente la Edge Function del checkout publico.
    'storefront',
    p_business_account_id,
    p_billing_address,
    p_approval,
    p_coupon_codes,
    p_delivery
  );

  v_order_id := (v_order ->> 'order_id')::uuid;

  if v_intent.cart_id is not null then
    select * into v_cart from public.carts c where c.id = v_intent.cart_id for update;
    if found and v_cart.status = 'active' then
      update public.carts
         set status = 'converted', order_id = v_order_id, last_activity_at = now()
       where id = v_cart.id;
    end if;
  end if;

  v_payment := case
    when p_payment is null then null
    else jsonb_build_object(
      'status',             p_payment ->> 'status',
      'provider_reference', p_payment ->> 'provider_reference',
      'provider_code',      p_payment ->> 'provider_code')
  end;

  perform ebim.publish_event(
    v_store.organization_id, v_store.company_id, v_store.id,
    'order.created', 'order', v_order_id,
    jsonb_build_object(
      'order_id',        v_order_id,
      'order_number',    v_order ->> 'order_number',
      'status',          v_order ->> 'status',
      'channel',         v_order ->> 'channel',
      'source_channel',  v_order ->> 'source_channel',
      'approval_status', v_order ->> 'approval_status',
      'currency',        v_order ->> 'currency',
      'subtotal',        v_order ->> 'subtotal',
      'tax_total',       v_order ->> 'tax_total',
      'discount_total',  v_order ->> 'discount_total',
      -- P12: un consumidor que factura o sincroniza con un ERP necesita el
      -- transporte por separado —tributa distinto— y no puede deducirlo del
      -- total sin volver a leer el pedido.
      'shipping_total',  v_order ->> 'shipping_total',
      'delivery',        v_order -> 'delivery',
      'grand_total',     v_order ->> 'grand_total',
      'customer_email',  lower(btrim(coalesce(p_customer_email, ''))),
      'item_count',      jsonb_array_length(coalesce(v_order -> 'items', '[]'::jsonb)),
      'payment',         v_payment),
    'order.created:' || v_intent.idempotency_key);

  -- Un pedido que espera firma NO es un pedido confirmado, y avisar de lo
  -- contrario es peor que no avisar: el comprador cree que ya esta comprado.
  if (v_order ->> 'approval_status') = 'pending' then
    perform ebim.publish_event(
      v_store.organization_id, v_store.company_id, v_store.id,
      'order.approval_requested', 'order', v_order_id,
      jsonb_strip_nulls(jsonb_build_object(
        'order_id',            v_order_id,
        'order_number',        v_order ->> 'order_number',
        'business_account_id', p_business_account_id,
        'reason',              v_order ->> 'approval_reason',
        'grand_total',         v_order ->> 'grand_total',
        'currency',            v_order ->> 'currency',
        'customer_email',      lower(btrim(coalesce(p_customer_email, ''))))),
      'order.approval_requested:' || v_intent.idempotency_key);
  else
    perform ebim.publish_event(
      v_store.organization_id, v_store.company_id, v_store.id,
      'notification.order_confirmation', 'order', v_order_id,
      jsonb_build_object(
        'order_id',       v_order_id,
        'order_number',   v_order ->> 'order_number',
        'customer_email', lower(btrim(coalesce(p_customer_email, ''))),
        'customer_name',  nullif(btrim(coalesce(p_customer_name, '')), ''),
        'grand_total',    v_order ->> 'grand_total',
        'currency',       v_order ->> 'currency'),
      'notification.order_confirmation:' || v_intent.idempotency_key);
  end if;

  update public.checkout_intents
     set status = 'succeeded',
         stage = 'publish_events',
         order_id = v_order_id,
         result = v_order,
         reservation_token = null,
         completed_at = now()
   where id = v_intent.id;

  return v_order || jsonb_build_object('replay', false, 'intent_id', v_intent.id);
end;
$fn$;
revoke execute on function
  public.checkout_place_order(uuid, text, jsonb, text, text, jsonb, text, text, jsonb, uuid, jsonb, jsonb, text[], jsonb)
from public, anon, authenticated;

grant execute on function
  public.checkout_place_order(uuid, text, jsonb, text, text, jsonb, text, text, jsonb, uuid, jsonb, jsonb, text[], jsonb)
to service_role;

comment on function
  public.checkout_place_order(uuid, text, jsonb, text, text, jsonb, text, text, jsonb, uuid, jsonb, jsonb, text[], jsonb) is
  'La transaccion que cierra el checkout: pedido + intento + carrito + fulfillment + hechos, o ninguna de las cinco. Sin una sola llamada externa dentro. Arrastra cupones (P10) y la eleccion de entrega (P12).';
