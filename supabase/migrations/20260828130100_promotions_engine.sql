-- =============================================================================
-- P10-SaaS · 2/5 — El MOTOR: evaluacion determinista y explicable
--
-- Todo el calculo de promociones del producto vive aqui dentro, y solo aqui.
-- Es la misma decision que P04 tomo con el precio ("una sola autoridad") y por
-- la misma razon: en cuanto hay dos sitios donde se decide cuanto se descuenta,
-- el escaparate y la factura acaban discrepando y nadie sabe cual de los dos
-- numeros es el bueno.
--
-- Lo llaman TRES: el carrito de la vitrina, el simulador del backoffice y
-- `create_order`. Los tres pasan por `ebim.evaluate_promotions`.
--
-- ## Las cinco propiedades que este archivo garantiza
--
-- 1. **Determinismo.** El orden de evaluacion es TOTAL y esta escrito:
--    `priority desc, created_at, id`. Ningun paso depende del orden en que
--    Postgres devolvio las filas (regla 4 del encargo).
--
-- 2. **Explicabilidad.** Toda respuesta trae el desglose: que campanas se
--    aplicaron, cuanto puso cada una, en que lineas, y —lo que casi nunca se
--    guarda— cuales NO se aplicaron y por que (regla 3).
--
-- 3. **Servidor.** Ni una entrada del cliente decide nada salvo el codigo de
--    cupon, que es lo unico que el comprador tiene que poder teclear. No existe
--    parametro para "esta promocion ya se aplico" (regla 6).
--
-- 4. **Limites transaccionales.** Con `p_lock`, las campanas y cupones que
--    tienen tope de uso se bloquean (`for update`) ANTES de contarse, en orden
--    de `id` para que dos checkouts simultaneos no se abracen. El ultimo uso lo
--    gasta uno solo (regla 5 y 7).
--
-- 5. **Aritmetica cerrada.** `ebim.promotion_totals` reparte impuesto y
--    descuento de forma que `subtotal + impuesto - descuento = total` sea una
--    identidad y no una casualidad, en las dos modalidades fiscales. Es lo que
--    permite que `orders_total_consistent` no sea nunca un obstaculo.
--
-- ## Lo que NO hace
--
--  · **No toca el precio base.** Recibe lineas ya cotizadas por
--    `ebim.resolve_prices`. Si manana cambia la precedencia de listas, aqui no
--    se toca una linea.
--  · **No escribe.** Ni siquiera con `p_lock`: bloquear no es escribir. Quien
--    apunta el canje y mueve el contador es `ebim.redeem_promotions`, que corre
--    dentro de la transaccion del pedido.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.normalize_promo_code — la MISMA normalizacion que la columna generada
-- de `coupons.code_normalized`. Existe para poder buscar por ella.
--
-- Es IMMUTABLE porque `upper` y `regexp_replace` lo son; si no lo fuera, el
-- indice unico sobre la columna generada no serviria para esta consulta y cada
-- cupon tecleado costaria un recorrido de tabla.
-- ---------------------------------------------------------------------------
create or replace function ebim.normalize_promo_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$fn$;

grant execute on function ebim.normalize_promo_code(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ebim.distribute_amount — repartir un importe entre partes SIN perder ni
-- ganar un centimo.
--
-- Es el metodo del resto mayor, el mismo que P08 usa para repartir el impuesto
-- entre las lineas de un pedido, extraido aqui porque las promociones lo
-- necesitan tres veces: al topar un porcentaje, al repartir un importe fijo y
-- al repartir el descuento de un combo.
--
-- La propiedad: la suma de lo devuelto es EXACTAMENTE
-- `min(p_target, suma de topes)`. Repartir proporcionalmente y redondear cada
-- parte por su cuenta deja un residuo de centimos que, en un descuento, es la
-- diferencia entre que la factura cuadre y que no.
--
-- `p_parts`: [{"key": <entero>, "weight": <numeric>, "cap": <numeric>}]
-- El orden del residuo es `weight desc, key asc` — total y reproducible.
-- ---------------------------------------------------------------------------
create or replace function ebim.distribute_amount(p_target numeric, p_parts jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_weight_total numeric := 0;
  v_cap_total    numeric := 0;
  v_target       numeric;
  v_sorted       jsonb;
  v_amounts      numeric[];
  v_caps         numeric[];
  v_keys         integer[];
  v_n            integer;
  v_i            integer;
  v_sum          numeric := 0;
  v_residual     numeric;
  v_progress     boolean;
  v_result       jsonb := '[]'::jsonb;
begin
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0 then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(e order by greatest((e ->> 'weight')::numeric, 0) desc,
                               (e ->> 'key')::integer), '[]'::jsonb)
    into v_sorted
  from jsonb_array_elements(p_parts) e;

  select coalesce(sum(greatest((e ->> 'weight')::numeric, 0)), 0),
         coalesce(sum(greatest((e ->> 'cap')::numeric, 0)), 0)
    into v_weight_total, v_cap_total
  from jsonb_array_elements(v_sorted) e;

  v_target := least(greatest(coalesce(p_target, 0), 0), greatest(v_cap_total, 0));

  select array_agg((e ->> 'key')::integer order by ord),
         array_agg(greatest((e ->> 'cap')::numeric, 0) order by ord)
    into v_keys, v_caps
  from jsonb_array_elements(v_sorted) with ordinality t(e, ord);

  v_n := coalesce(array_length(v_keys, 1), 0);
  if v_n = 0 then
    return '[]'::jsonb;
  end if;

  v_amounts := array_fill(0::numeric, array[v_n]);

  if v_target > 0 and v_weight_total > 0 then
    -- Reparto proporcional, cada parte topada por su maximo.
    select array_agg(least(round(v_target * greatest((e ->> 'weight')::numeric, 0) / v_weight_total, 2),
                           greatest((e ->> 'cap')::numeric, 0)) order by ord)
      into v_amounts
    from jsonb_array_elements(v_sorted) with ordinality t(e, ord);
  end if;

  select coalesce(sum(x), 0) into v_sum from unnest(v_amounts) as x;
  v_residual := v_target - v_sum;

  -- El residuo se coloca de centimo en centimo, en el orden ya fijado. Como
  -- mucho hay tantos centimos de residuo como partes, asi que este bucle no
  -- puede crecer con el importe: crece con el numero de lineas.
  while abs(v_residual) >= 0.005 loop
    v_progress := false;
    v_i := 1;
    while v_i <= v_n and abs(v_residual) >= 0.005 loop
      if v_residual > 0 and v_amounts[v_i] + 0.01 <= v_caps[v_i] + 0.0000001 then
        v_amounts[v_i] := v_amounts[v_i] + 0.01;
        v_residual := v_residual - 0.01;
        v_progress := true;
      elsif v_residual < 0 and v_amounts[v_i] >= 0.01 then
        v_amounts[v_i] := v_amounts[v_i] - 0.01;
        v_residual := v_residual + 0.01;
        v_progress := true;
      end if;
      v_i := v_i + 1;
    end loop;
    -- Sin sitio donde colocarlo no hay bucle infinito: se para y devuelve lo
    -- repartido, que sigue sumando <= p_target.
    exit when not v_progress;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'amount', a) order by k), '[]'::jsonb)
    into v_result
  from unnest(v_keys, v_amounts) as t(k, a);

  return v_result;
end;
$fn$;

revoke execute on function ebim.distribute_amount(numeric, jsonb) from public, anon, authenticated;

comment on function ebim.distribute_amount(numeric, jsonb) is
  'Reparto por resto mayor: la suma de lo devuelto es EXACTAMENTE min(objetivo, suma de topes). Sin esto, un descuento repartido deja centimos sueltos y la factura no cuadra consigo misma.';

-- ---------------------------------------------------------------------------
-- ebim.promotion_totals — la aritmetica fiscal CON descuento.
--
-- Hasta P10 el impuesto se calculaba sobre el bruto, por grupo de tasa, en dos
-- sitios que decian lo mismo (`ebim.build_quote` y `create_order`). Con
-- descuentos aparece una pregunta nueva —¿sobre que base se calcula el
-- impuesto?— y la respuesta es la unica defendible: **sobre lo que se paga**.
-- Cobrar impuesto sobre un importe que el comprador no paga es cobrar de mas.
--
-- ## La identidad que hace que el pedido cuadre
--
-- `orders_total_consistent` (P02) exige
-- `grand_total = subtotal + tax_total + shipping_total - discount_total`.
-- Esta funcion no la esquiva: la construye. En las dos modalidades fiscales,
-- `subtotal + impuesto - descuento` da EXACTAMENTE lo que el comprador paga.
--
-- **Impuesto excluido** (el precio no lo lleva dentro):
--   subtotal  = bruto             (la base ANTES de descontar)
--   descuento = descuento bruto
--   impuesto  = tasa x (bruto - descuento), por grupo
--   total     = subtotal + impuesto - descuento = pagadero + impuesto  ✔
--
-- **Impuesto incluido** (el precio ya lo lleva):
--   impuesto  = parte fiscal de lo PAGADERO
--   descuento = descuento MENOS su propia parte fiscal (el descuento tambien
--               rebaja el impuesto: rebajar 118 con IVA 18 % son 100 de base y
--               18 de impuesto, no 118 de base)
--   subtotal  = bruto - impuesto - parte fiscal del descuento
--   total     = subtotal + impuesto - descuento = pagadero  ✔
--
-- Con descuento cero las dos ramas dan EXACTAMENTE los mismos numeros que
-- `ebim.build_quote` daba antes de esta fase. Es lo que permite que ningun test
-- de P02 a P09 cambie una linea.
--
-- `p_lines`: [{"line_key": <entero>, "amount": bruto, "discount": bruto
--              descontado, "tax_rate": tasa}]
-- ---------------------------------------------------------------------------
create or replace function ebim.promotion_totals(p_lines jsonb, p_tax_inclusive boolean)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_subtotal  numeric(14,2) := 0;
  v_discount  numeric(14,2) := 0;
  v_tax       numeric(14,2) := 0;
  v_lines     jsonb := '[]'::jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object(
      'subtotal', '0.00', 'discount_total', '0.00',
      'tax_total', '0.00', 'grand_total', '0.00', 'lines', '[]'::jsonb);
  end if;

  with lineas as (
    select (l ->> 'line_key')::integer                        as line_key,
           coalesce((l ->> 'tax_rate')::numeric, 0)           as rate,
           coalesce((l ->> 'amount')::numeric, 0)             as gross,
           coalesce((l ->> 'discount')::numeric, 0)           as discount
    from jsonb_array_elements(p_lines) as l
  ),
  grupos as (
    select rate,
           sum(gross)            as gross,
           sum(discount)         as discount,
           sum(gross - discount) as payable
    from lineas
    group by rate
  ),
  fiscal as (
    select g.*,
           case when p_tax_inclusive
                then round(g.payable * g.rate / (1 + g.rate), 2)
                else round(g.payable * g.rate, 2)
           end as tax,
           -- La parte fiscal del DESCUENTO. Solo existe con impuesto incluido:
           -- con impuesto excluido el descuento ya es base imponible pura.
           case when p_tax_inclusive
                then round(g.discount * g.rate / (1 + g.rate), 2)
                else 0
           end as tax_of_discount
    from grupos g
  )
  select coalesce(sum(case when p_tax_inclusive
                           then f.gross - f.tax - f.tax_of_discount
                           else f.gross end), 0),
         coalesce(sum(f.discount - f.tax_of_discount), 0),
         coalesce(sum(f.tax), 0)
    into v_subtotal, v_discount, v_tax
  from fiscal f;

  -- ---- El impuesto, repartido POR LINEA ---------------------------------
  --
  -- Mismo metodo del resto mayor que P08, con una sola diferencia: se reparte
  -- en proporcion a lo PAGADERO (bruto menos descuento) y no al bruto. Repartir
  -- por el bruto daria mas impuesto a una linea con descuento que a una sin el,
  -- para el mismo importe cobrado.
  with lineas as (
    select (l ->> 'line_key')::integer              as line_key,
           coalesce((l ->> 'tax_rate')::numeric, 0) as rate,
           coalesce((l ->> 'amount')::numeric, 0) - coalesce((l ->> 'discount')::numeric, 0) as payable
    from jsonb_array_elements(p_lines) as l
  ),
  grupos as (
    select rate,
           sum(payable) as payable,
           case when p_tax_inclusive
                then round(sum(payable) * rate / (1 + rate), 2)
                else round(sum(payable) * rate, 2)
           end as tax
    from lineas
    group by rate
  ),
  repartido as (
    select l.line_key,
           l.rate,
           g.tax as group_tax,
           case when g.payable = 0 then 0
                else round(g.tax * l.payable / g.payable, 2)
           end as line_tax,
           row_number() over (partition by l.rate order by l.payable desc, l.line_key) as rn
    from lineas l
    join grupos g on g.rate is not distinct from l.rate
  ),
  ajustado as (
    select r.*, sum(r.line_tax) over (partition by r.rate) as sum_tax
    from repartido r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'line_key', a.line_key,
           'tax_amount',
           (a.line_tax + case when a.rn = 1 then a.group_tax - a.sum_tax else 0 end)::text
         ) order by a.line_key), '[]'::jsonb)
    into v_lines
  from ajustado a;

  return jsonb_build_object(
    'subtotal',       v_subtotal::text,
    'discount_total', v_discount::text,
    'tax_total',      v_tax::text,
    'grand_total',    (v_subtotal + v_tax - v_discount)::text,
    'lines',          v_lines);
end;
$fn$;

revoke execute on function ebim.promotion_totals(jsonb, boolean) from public, anon, authenticated;

comment on function ebim.promotion_totals(jsonb, boolean) is
  'Unica autoridad fiscal con descuento: reparte impuesto sobre lo PAGADERO y construye la identidad subtotal + impuesto - descuento = total en las dos modalidades. Con descuento cero da los mismos numeros que build_quote antes de P10.';

-- ---------------------------------------------------------------------------
-- ebim.evaluate_promotions — EL motor.
--
-- Recibe lineas ya cotizadas y devuelve cuanto se descuenta, de que linea y por
-- que campana. No sabe de tiendas cerradas, de existencia ni de pasarelas: solo
-- de reglas comerciales.
--
-- ## El contrato de entrada
--
-- `p_lines`: [{"line_key": <entero>, "product_id", "variant_id", "quantity",
--              "unit_price", "amount", "tax_rate"}]
-- `amount` es el BRUTO de la linea (precio x cantidad) tal y como lo dejo el
-- motor de precios. Aqui no se recalcula ni un precio.
--
-- ## El contrato de salida
--
-- {
--   "entitled": bool,             -- ¿la sociedad tiene el modulo?
--   "discount_total": "0.00",     -- bruto descontado
--   "lines":  [{line_key, discount, adjustments:[...]}],
--   "applied":[{promotion_id, code, name, kind, priority, amount, coupon_code}],
--   "skipped":[{promotion_id, code, reason}],
--   "coupons":[{code, status, reason, promotion_id}]
-- }
--
-- ## Las reglas de combinacion, explicitas (regla 4 del encargo)
--
-- Se recorren las candidatas por `priority desc, created_at, id` y se decide en
-- este orden, que es el unico que hace falta recordar:
--
--   1. si ya se aplico una EXCLUSIVA -> ninguna mas entra;
--   2. si esta es exclusiva y ya se aplico algo -> no entra;
--   3. si su `stack_group` ya lo gano otra -> no entra;
--   4. si no, se aplica sobre lo que QUEDA de cada linea.
--
-- Que se aplique sobre el remanente es lo que impide que dos campanas del 60 %
-- sumen 120 % y dejen el pedido en negativo. No hace falta un CHECK para eso:
-- el modelo no puede expresarlo.
-- ---------------------------------------------------------------------------
create or replace function ebim.evaluate_promotions(
  p_store_id           uuid,
  p_channel_id         uuid,
  p_lines              jsonb,
  p_coupon_codes       text[]      default null,
  p_customer_id        uuid        default null,
  p_segment_id         uuid        default null,
  p_business_account_id uuid       default null,
  p_customer_email     text        default null,
  p_at                 timestamptz default null,
  -- `true` = esta corriendo dentro de la transaccion que va a cobrar: los topes
  -- de uso se leen con la fila bloqueada. `false` = solo se esta enseñando un
  -- carrito y bloquear seria castigar a quien mira sin comprar.
  p_lock               boolean     default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store     public.stores%rowtype;
  v_at        timestamptz := coalesce(p_at, now());
  v_email     text := lower(btrim(coalesce(p_customer_email, '')));
  v_segment   uuid := p_segment_id;
  v_customer  uuid := p_customer_id;
  v_account   uuid := p_business_account_id;
  v_codes     text[] := '{}';
  v_lines     jsonb := '[]'::jsonb;
  v_gross     numeric(14,2) := 0;
  v_coupons   jsonb := '[]'::jsonb;
  v_applied   jsonb := '[]'::jsonb;
  v_skipped   jsonb := '[]'::jsonb;
  v_promo     record;
  v_coupon    public.coupons%rowtype;
  v_code      text;
  v_used      integer;
  v_matched   integer[];
  v_qty       numeric;
  v_base      numeric(14,2);
  v_target    numeric(14,2);
  v_parts     jsonb;
  v_share     jsonb;
  v_total     numeric(14,2) := 0;
  v_exclusive boolean := false;
  v_any       boolean := false;
  v_groups    text[] := '{}';
  v_coupon_id uuid;
  v_coupon_code text;
  v_sets      numeric;
  v_units     jsonb;
  v_reason    text;
begin
  -- ---- 0 · Contexto -----------------------------------------------------
  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda no existe' using errcode = '22023';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object(
      'entitled', false, 'discount_total', '0.00',
      'lines', '[]'::jsonb, 'applied', '[]'::jsonb,
      'skipped', '[]'::jsonb, 'coupons', '[]'::jsonb);
  end if;

  -- El entitlement se comprueba con `company_is_entitled` y NO con
  -- `has_capability`: esta funcion corre tambien para un comprador anonimo, y
  -- `has_capability` empieza por `can_access`, que para `anon` es siempre
  -- falso. Es exactamente la leccion que P04 dejo escrita en
  -- `ebim.active_price_lists`.
  if not ebim.company_is_entitled(v_store.organization_id, v_store.company_id, 'promotions') then
    return jsonb_build_object(
      'entitled', false, 'discount_total', '0.00',
      'lines', '[]'::jsonb, 'applied', '[]'::jsonb,
      'skipped', '[]'::jsonb, 'coupons', '[]'::jsonb);
  end if;

  -- El segmento se deriva de la ficha cuando no se declara, igual que hace
  -- `public.price_quote` desde P05. Un segmento que el llamante no puso no se
  -- inventa: se busca donde esta escrito.
  if v_segment is null and v_customer is not null then
    select c.segment_id into v_segment
    from public.customers c
    where c.id = v_customer
      and c.organization_id = v_store.organization_id
      and c.company_id      = v_store.company_id;
  end if;

  if v_customer is null and v_account is not null then
    select a.customer_id into v_customer
    from public.business_accounts a
    where a.id = v_account
      and a.organization_id = v_store.organization_id
      and a.company_id      = v_store.company_id;
    if v_segment is null and v_customer is not null then
      select c.segment_id into v_segment from public.customers c where c.id = v_customer;
    end if;
  end if;

  -- ---- 1 · Las lineas, con su categoria y su marca ----------------------
  -- Se resuelven AQUI y no las pide el llamante: la categoria y la marca de un
  -- producto son un hecho del catalogo, y aceptarlas como parametro seria abrir
  -- la puerta a que alguien declarase la categoria que le conviene.
  select coalesce(jsonb_agg(jsonb_build_object(
           'line_key',    (l ->> 'line_key')::integer,
           'product_id',  pr.id,
           'variant_id',  nullif(btrim(coalesce(l ->> 'variant_id', '')), '')::uuid,
           'category_id', pr.category_id,
           'brand_id',    pr.brand_id,
           'quantity',    coalesce((l ->> 'quantity')::numeric, 0),
           'unit_price',  coalesce((l ->> 'unit_price')::numeric, 0),
           'amount',      coalesce((l ->> 'amount')::numeric, 0),
           'remaining',   coalesce((l ->> 'amount')::numeric, 0),
           'discount',    0,
           'adjustments', '[]'::jsonb
         ) order by (l ->> 'line_key')::integer), '[]'::jsonb)
    into v_lines
  from jsonb_array_elements(p_lines) as l
  join public.products pr
    on pr.id = ebim.safe_uuid(l ->> 'product_id')
   and pr.store_id = v_store.id;

  if jsonb_array_length(v_lines) = 0 then
    return jsonb_build_object(
      'entitled', true, 'discount_total', '0.00',
      'lines', '[]'::jsonb, 'applied', '[]'::jsonb,
      'skipped', '[]'::jsonb, 'coupons', '[]'::jsonb);
  end if;

  select coalesce(sum((l ->> 'amount')::numeric), 0) into v_gross
  from jsonb_array_elements(v_lines) as l;

  -- ---- 2 · Los cupones tecleados ----------------------------------------
  -- Como maximo cinco. No es una limitacion tecnica: mas de cinco codigos en un
  -- carrito es un intento de probar codigos, no una compra.
  select coalesce(array_agg(distinct ebim.normalize_promo_code(c)), '{}')
    into v_codes
  from unnest(coalesce(p_coupon_codes, '{}')) as c
  where char_length(ebim.normalize_promo_code(c)) between 3 and 40;

  if array_length(v_codes, 1) > 5 then
    raise exception 'CUPONES_EXCESIVOS: maximo 5 codigos por pedido'
      using errcode = '22023';
  end if;

  -- ---- 3 · Los cerrojos --------------------------------------------------
  -- Solo se bloquea lo que puede AGOTARSE: una campana sin tope de uso no
  -- necesita cerrojo, y bloquearla serializaria todos los checkouts de la
  -- tienda sin proteger nada. El orden de bloqueo es por `id` ascendente en las
  -- dos tablas —campanas primero, cupones despues— para que dos transacciones
  -- simultaneas no se abracen.
  if p_lock then
    perform 1
    from public.promotions p
    where p.store_id = v_store.id
      and p.status = 'active'
      and (p.usage_limit is not null or p.usage_limit_per_customer is not null)
    order by p.id
    for update;

    if array_length(v_codes, 1) > 0 then
      perform 1
      from public.coupons c
      where c.store_id = v_store.id
        and c.code_normalized = any (v_codes)
      order by c.id
      for update;
    end if;
  end if;

  -- ---- 4 · Resolver cada cupon ------------------------------------------
  -- El orden es el que tecleo el comprador (`v_codes` viene ordenado por el
  -- `array_agg(distinct)`, que es estable): con dos cupones de la MISMA campana
  -- gana el primero y el segundo se marca `duplicado`. Sin esa regla, cual de
  -- los dos gana dependeria del plan de ejecucion.
  foreach v_code in array coalesce(v_codes, '{}')
  loop
    select * into v_coupon
    from public.coupons c
    where c.store_id = v_store.id and c.code_normalized = v_code;

    if not found then
      v_coupons := v_coupons || jsonb_build_array(
        jsonb_build_object('code', v_code, 'status', 'no_existe', 'promotion_id', null));
      continue;
    end if;

    if not v_coupon.is_active then
      v_reason := 'inactivo';
    elsif (v_coupon.valid_from is not null and v_coupon.valid_from > v_at)
       or (v_coupon.valid_to   is not null and v_coupon.valid_to  <= v_at) then
      v_reason := 'fuera_de_vigencia';
    elsif v_coupon.usage_limit is not null and v_coupon.usage_count >= v_coupon.usage_limit then
      v_reason := 'agotado';
    else
      v_reason := null;
      if v_coupon.usage_limit_per_customer is not null then
        if v_email = '' then
          -- Un tope por cliente sin forma de saber quien es el cliente no se
          -- puede cumplir. Se niega, no se ignora.
          v_reason := 'sin_identidad';
        else
          select count(*)::integer into v_used
          from public.promotion_redemptions r
          where r.coupon_id = v_coupon.id
            and (lower(r.customer_email) = v_email
                 or (v_customer is not null and r.customer_id = v_customer));
          if v_used >= v_coupon.usage_limit_per_customer then
            v_reason := 'agotado_para_ti';
          end if;
        end if;
      end if;
    end if;

    if v_reason is null and exists (
      select 1 from jsonb_array_elements(v_coupons) as e
      where (e ->> 'promotion_id')::uuid = v_coupon.promotion_id
        and e ->> 'status' = 'aplicable'
    ) then
      v_reason := 'duplicado';
    end if;

    v_coupons := v_coupons || jsonb_build_array(jsonb_build_object(
      'code', v_coupon.code,
      'normalized', v_code,
      'status', coalesce(v_reason, 'aplicable'),
      'coupon_id', v_coupon.id,
      'promotion_id', v_coupon.promotion_id));
  end loop;

  -- ---- 5 · Las candidatas, en orden TOTAL --------------------------------
  for v_promo in
    select p.*
    from public.promotions p
    where p.store_id = v_store.id
      and p.status = 'active'
      and p.valid_from <= v_at
      and (p.valid_to is null or p.valid_to > v_at)
    order by p.priority desc, p.created_at, p.id
  loop
    v_coupon_id := null;
    v_coupon_code := null;

    -- 5.1 · Cupon. Una campana con cupon NO existe sin el, y su ausencia no se
    -- reporta: enumerar los cupones que hay seria regalar el folleto.
    if v_promo.requires_coupon then
      select (e ->> 'coupon_id')::uuid, e ->> 'code'
        into v_coupon_id, v_coupon_code
      from jsonb_array_elements(v_coupons) as e
      where (e ->> 'promotion_id')::uuid = v_promo.id
        and e ->> 'status' = 'aplicable'
      limit 1;

      if v_coupon_id is null then
        continue;
      end if;
    end if;

    -- 5.2 · Audiencia. Sin filas = todo el mundo.
    if exists (select 1 from public.promotion_audiences a where a.promotion_id = v_promo.id)
       and not exists (
         select 1
         from public.promotion_audiences a
         where a.promotion_id = v_promo.id
           and (a.audience_kind = 'all'
             or (a.audience_kind = 'channel'          and a.channel_id          = p_channel_id)
             or (a.audience_kind = 'segment'          and a.segment_id          = v_segment)
             or (a.audience_kind = 'customer'         and a.customer_id         = v_customer)
             or (a.audience_kind = 'business_account' and a.business_account_id = v_account))
       )
    then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'fuera_de_publico'));
      continue;
    end if;

    -- 5.3 · Minimo de compra. Contra el BRUTO del pedido, antes de descuentos.
    if v_promo.min_subtotal is not null and v_gross < v_promo.min_subtotal then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'minimo_no_alcanzado'));
      continue;
    end if;

    -- 5.4 · Topes de uso. Con `p_lock` estas filas ya estan bloqueadas.
    if v_promo.usage_limit is not null and v_promo.usage_count >= v_promo.usage_limit then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'limite_global_agotado'));
      continue;
    end if;

    if v_promo.usage_limit_per_customer is not null then
      if v_email = '' then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'sin_identidad'));
        continue;
      end if;
      select count(*)::integer into v_used
      from public.promotion_redemptions r
      where r.promotion_id = v_promo.id
        and (lower(r.customer_email) = v_email
             or (v_customer is not null and r.customer_id = v_customer));
      if v_used >= v_promo.usage_limit_per_customer then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'limite_por_cliente_agotado'));
        continue;
      end if;
    end if;

    -- 5.5 · Combinacion.
    if v_exclusive then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'exclusiva_previa'));
      continue;
    end if;
    if v_promo.is_exclusive and v_any then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'no_combina'));
      continue;
    end if;
    if v_promo.stack_group is not null and v_promo.stack_group = any (v_groups) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'grupo_excluyente'));
      continue;
    end if;

    -- 5.6 · Que lineas alcanza. La exclusion gana siempre.
    select coalesce(array_agg(ln.line_key order by ln.line_key), '{}')
      into v_matched
    from (
      select (l ->> 'line_key')::integer as line_key,
             ebim.safe_uuid(l ->> 'product_id')  as product_id,
             ebim.safe_uuid(l ->> 'variant_id')  as variant_id,
             ebim.safe_uuid(l ->> 'category_id') as category_id,
             ebim.safe_uuid(l ->> 'brand_id')    as brand_id
      from jsonb_array_elements(v_lines) as l
    ) ln
    where exists (
        select 1 from public.promotion_scopes s
        where s.promotion_id = v_promo.id and not s.is_exclusion
          and (s.scope_kind = 'all'
            or (s.scope_kind = 'product'  and s.product_id  = ln.product_id)
            or (s.scope_kind = 'variant'  and s.variant_id  = ln.variant_id)
            or (s.scope_kind = 'category' and s.category_id = ln.category_id)
            or (s.scope_kind = 'brand'    and s.brand_id    = ln.brand_id)))
      and not exists (
        select 1 from public.promotion_scopes s
        where s.promotion_id = v_promo.id and s.is_exclusion
          and (s.scope_kind = 'all'
            or (s.scope_kind = 'product'  and s.product_id  = ln.product_id)
            or (s.scope_kind = 'variant'  and s.variant_id  = ln.variant_id)
            or (s.scope_kind = 'category' and s.category_id = ln.category_id)
            or (s.scope_kind = 'brand'    and s.brand_id    = ln.brand_id)));

    if coalesce(array_length(v_matched, 1), 0) = 0 then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'sin_alcance'));
      continue;
    end if;

    -- 5.7 · Cantidad minima ALCANZADA.
    if v_promo.min_quantity is not null then
      select coalesce(sum((l ->> 'quantity')::numeric), 0) into v_qty
      from jsonb_array_elements(v_lines) as l
      where (l ->> 'line_key')::integer = any (v_matched);
      if v_qty < v_promo.min_quantity then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'promotion_id', v_promo.id, 'code', v_promo.code,
          'reason', 'cantidad_minima_no_alcanzada'));
        continue;
      end if;
    end if;

    -- 5.8 · Cuanto descuenta, por tipo. Cada rama deja `v_parts` = el reparto
    -- objetivo por linea ({key, weight, cap}) y `v_target` = el importe total.
    v_parts := '[]'::jsonb;
    v_target := 0;

    if v_promo.kind = 'percentage' then
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', (l ->> 'line_key')::integer,
               'weight', round((l ->> 'remaining')::numeric * v_promo.value_percent / 100, 2),
               'cap', least(round((l ->> 'remaining')::numeric * v_promo.value_percent / 100, 2),
                            (l ->> 'remaining')::numeric))), '[]'::jsonb),
             coalesce(sum(least(round((l ->> 'remaining')::numeric * v_promo.value_percent / 100, 2),
                                (l ->> 'remaining')::numeric)), 0)
        into v_parts, v_target
      from jsonb_array_elements(v_lines) as l
      where (l ->> 'line_key')::integer = any (v_matched);

      if v_promo.max_discount_amount is not null then
        v_target := least(v_target, v_promo.max_discount_amount);
      end if;

    elsif v_promo.kind = 'fixed_amount' then
      -- El importe fijo se reparte entre las lineas alcanzadas en proporcion a
      -- lo que queda de cada una. Con alcance `all` esto es exactamente "un
      -- descuento sobre el pedido", y por eso no hace falta un tipo aparte.
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', (l ->> 'line_key')::integer,
               'weight', (l ->> 'remaining')::numeric,
               'cap', (l ->> 'remaining')::numeric)), '[]'::jsonb),
             coalesce(sum((l ->> 'remaining')::numeric), 0)
        into v_parts, v_target
      from jsonb_array_elements(v_lines) as l
      where (l ->> 'line_key')::integer = any (v_matched);

      v_target := least(v_promo.value_amount, v_target);

    elsif v_promo.kind = 'volume_tier' then
      -- Por linea, la escala MAS ALTA que la cantidad de esa linea alcanza.
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', d.line_key, 'weight', d.amount, 'cap', d.amount)), '[]'::jsonb),
             coalesce(sum(d.amount), 0)
        into v_parts, v_target
      from (
        select (l ->> 'line_key')::integer as line_key,
               least(
                 case when t.discount_percent is not null
                      then round((l ->> 'remaining')::numeric * t.discount_percent / 100, 2)
                      else round((l ->> 'quantity')::numeric * t.discount_amount, 2)
                 end,
                 (l ->> 'remaining')::numeric) as amount
        from jsonb_array_elements(v_lines) as l
        cross join lateral (
          select tt.discount_percent, tt.discount_amount
          from public.promotion_tiers tt
          where tt.promotion_id = v_promo.id
            and tt.min_quantity <= (l ->> 'quantity')::numeric
          order by tt.min_quantity desc
          limit 1
        ) t
        where (l ->> 'line_key')::integer = any (v_matched)
      ) d;

      if v_promo.max_discount_amount is not null then
        v_target := least(v_target, v_promo.max_discount_amount);
      end if;

    elsif v_promo.kind = 'x_for_y' then
      -- Por cada bloque completo de `buy_quantity` unidades EN LA MISMA LINEA,
      -- `free_quantity` salen al precio de esa linea. Por linea y no por
      -- carrito: si se mezclaran lineas de precios distintos habria que elegir
      -- cual sale gratis, y esa eleccion no la puede tomar el motor sin que el
      -- comercio la haya escrito.
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', d.line_key, 'weight', d.amount, 'cap', d.amount)), '[]'::jsonb),
             coalesce(sum(d.amount), 0)
        into v_parts, v_target
      from (
        select (l ->> 'line_key')::integer as line_key,
               least(
                 round(floor((l ->> 'quantity')::numeric / v_promo.buy_quantity)
                       * v_promo.free_quantity * (l ->> 'unit_price')::numeric, 2),
                 (l ->> 'remaining')::numeric) as amount
        from jsonb_array_elements(v_lines) as l
        where (l ->> 'line_key')::integer = any (v_matched)
      ) d;

    elsif v_promo.kind = 'bundle' then
      -- Cuantos conjuntos COMPLETOS hay en el carrito: el minimo, entre todos
      -- los componentes declarados, de (unidades presentes / unidades exigidas).
      select min(floor(coalesce(disp.qty, 0) / s.required_quantity))
        into v_sets
      from public.promotion_scopes s
      left join lateral (
        select sum((l ->> 'quantity')::numeric) as qty
        from jsonb_array_elements(v_lines) as l
        where (l ->> 'line_key')::integer = any (v_matched)
          and ebim.safe_uuid(l ->> 'product_id') = s.product_id
          and (s.variant_id is null
               or ebim.safe_uuid(l ->> 'variant_id') = s.variant_id)
      ) disp on true
      where s.promotion_id = v_promo.id and not s.is_exclusion;

      if coalesce(v_sets, 0) < 1 then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'combo_incompleto'));
        continue;
      end if;

      -- Las unidades que ENTRAN en los conjuntos, tomadas de las lineas en
      -- orden de `line_key` (regla determinista: sin ella, con dos lineas del
      -- mismo producto el reparto dependeria del orden de la consulta).
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', u.line_key,
               'weight', u.in_bundle,
               'cap', u.remaining) order by u.line_key), '[]'::jsonb),
             coalesce(sum(u.in_bundle), 0)
        into v_units, v_base
      from (
        select (l ->> 'line_key')::integer as line_key,
               (l ->> 'remaining')::numeric as remaining,
               round(least(
                 (l ->> 'quantity')::numeric,
                 coalesce(s.required_quantity, 0) * v_sets
               ) * (l ->> 'unit_price')::numeric, 2) as in_bundle
        from jsonb_array_elements(v_lines) as l
        join public.promotion_scopes s
          on s.promotion_id = v_promo.id
         and not s.is_exclusion
         and s.product_id = ebim.safe_uuid(l ->> 'product_id')
         and (s.variant_id is null or s.variant_id = ebim.safe_uuid(l ->> 'variant_id'))
        where (l ->> 'line_key')::integer = any (v_matched)
      ) u;

      v_parts := v_units;
      if v_promo.value_percent is not null then
        v_target := round(v_base * v_promo.value_percent / 100, 2);
      else
        v_target := round(v_promo.value_amount * v_sets, 2);
      end if;
      if v_promo.max_discount_amount is not null then
        v_target := least(v_target, v_promo.max_discount_amount);
      end if;
    end if;

    if v_target is null or v_target <= 0 then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'sin_efecto'));
      continue;
    end if;

    -- 5.9 · El reparto por lineas, sin perder ni ganar un centimo.
    v_share := ebim.distribute_amount(v_target, v_parts);

    select coalesce(sum((e ->> 'amount')::numeric), 0) into v_base
    from jsonb_array_elements(v_share) as e;

    if v_base <= 0 then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'promotion_id', v_promo.id, 'code', v_promo.code, 'reason', 'sin_efecto'));
      continue;
    end if;

    -- 5.10 · Anotar en las lineas. El remanente baja: la siguiente campana no
    -- puede descontar lo que esta ya descontó.
    select coalesce(jsonb_agg(
             case when sh.amount is null or sh.amount = 0 then l
                  else l
                       || jsonb_build_object(
                            'remaining', ((l ->> 'remaining')::numeric - sh.amount),
                            'discount',  ((l ->> 'discount')::numeric  + sh.amount))
                       || jsonb_build_object('adjustments',
                            (l -> 'adjustments') || jsonb_build_array(jsonb_build_object(
                              'promotion_id', v_promo.id,
                              'code',   v_promo.code,
                              'label',  v_promo.name,
                              'kind',   v_promo.kind,
                              'amount', sh.amount::text,
                              'coupon_code', v_coupon_code)))
             end order by (l ->> 'line_key')::integer), '[]'::jsonb)
      into v_lines
    from jsonb_array_elements(v_lines) as l
    left join lateral (
      select (e ->> 'amount')::numeric as amount
      from jsonb_array_elements(v_share) as e
      where (e ->> 'key')::integer = (l ->> 'line_key')::integer
      limit 1
    ) sh on true;

    v_total := v_total + v_base;
    v_any := true;
    if v_promo.is_exclusive then v_exclusive := true; end if;
    if v_promo.stack_group is not null then
      v_groups := v_groups || v_promo.stack_group;
    end if;

    v_applied := v_applied || jsonb_build_array(jsonb_build_object(
      'promotion_id', v_promo.id,
      'code',      v_promo.code,
      'label',     v_promo.name,
      'kind',      v_promo.kind,
      'priority',  v_promo.priority,
      'exclusive', v_promo.is_exclusive,
      'stack_group', v_promo.stack_group,
      'amount',    v_base::text,
      'coupon_id',   v_coupon_id,
      'coupon_code', v_coupon_code));
  end loop;

  -- ---- 6 · El estado final de cada cupon --------------------------------
  -- `aplicable` era una respuesta provisional: lo que el comprador necesita
  -- saber es si su codigo hizo ALGO. Un cupon valido cuya campana no alcanzo
  -- ninguna linea no es "aplicado".
  select coalesce(jsonb_agg(
           case when e ->> 'status' <> 'aplicable' then e
                when exists (select 1 from jsonb_array_elements(v_applied) as a
                             where (a ->> 'promotion_id')::uuid = (e ->> 'promotion_id')::uuid)
                then e || jsonb_build_object('status', 'aplicado')
                else e || jsonb_build_object('status', 'no_aplicable')
           end), '[]'::jsonb)
    into v_coupons
  from jsonb_array_elements(v_coupons) as e;

  return jsonb_build_object(
    'entitled',       true,
    'discount_total', v_total::text,
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'line_key',    (l ->> 'line_key')::integer,
               'discount',    (l ->> 'discount'),
               'adjustments', (l -> 'adjustments'))
             order by (l ->> 'line_key')::integer), '[]'::jsonb)
      from jsonb_array_elements(v_lines) as l),
    'applied', v_applied,
    'skipped', v_skipped,
    'coupons', v_coupons);
end;
$fn$;

revoke execute on function ebim.evaluate_promotions(
  uuid, uuid, jsonb, text[], uuid, uuid, uuid, text, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function ebim.evaluate_promotions(
  uuid, uuid, jsonb, text[], uuid, uuid, uuid, text, timestamptz, boolean
) to service_role;

comment on function ebim.evaluate_promotions(
  uuid, uuid, jsonb, text[], uuid, uuid, uuid, text, timestamptz, boolean
) is
  'EL motor de promociones: orden total (priority desc, created_at, id), stacking explicito, desglose de lo aplicado Y de lo descartado, y topes de uso con la fila bloqueada cuando p_lock.';

-- ---------------------------------------------------------------------------
-- ebim.apply_promotions — cotizacion + promociones + impuesto, en una pieza.
--
-- Es el servicio que usan los tres llamantes. Recibe la cotizacion que devolvio
-- `ebim.build_quote` y le anade el descuento y los totales recalculados.
--
-- La cotizacion original NO se altera: las lineas conservan su `unit_price`,
-- su `net_amount` y su `tax_rate`, y ganan `discount` y `adjustments`. Quien
-- lea la respuesta puede reconstruir el camino entero —de que precio se partio,
-- que le quito cada campana y que impuesto quedo—, que es la regla 3.
-- ---------------------------------------------------------------------------
create or replace function ebim.apply_promotions(
  p_store_id            uuid,
  p_channel_id          uuid,
  p_quote               jsonb,
  p_coupon_codes        text[]      default null,
  p_customer_id         uuid        default null,
  p_segment_id          uuid        default null,
  p_business_account_id uuid        default null,
  p_customer_email      text        default null,
  p_at                  timestamptz default null,
  p_lock                boolean     default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_inclusive boolean := coalesce((p_quote ->> 'tax_inclusive')::boolean, false);
  v_input     jsonb;
  v_promo     jsonb;
  v_totals    jsonb;
  v_lines     jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'line_key',   ord,
           'product_id', l ->> 'product_id',
           'variant_id', l ->> 'variant_id',
           'quantity',   l ->> 'quantity',
           'unit_price', l ->> 'unit_price',
           'amount',     l ->> 'net_amount',
           'tax_rate',   l ->> 'tax_rate') order by ord), '[]'::jsonb)
    into v_input
  from jsonb_array_elements(coalesce(p_quote -> 'lines', '[]'::jsonb)) with ordinality t(l, ord);

  v_promo := ebim.evaluate_promotions(
    p_store_id, p_channel_id, v_input, p_coupon_codes,
    p_customer_id, p_segment_id, p_business_account_id, p_customer_email,
    p_at, p_lock);

  -- Las lineas de la cotizacion, con su descuento pegado.
  select coalesce(jsonb_agg(
           l || jsonb_build_object(
             'discount',    coalesce(m.entry ->> 'discount', '0'),
             'adjustments', coalesce(m.entry -> 'adjustments', '[]'::jsonb),
             'line_key',    ord)
           order by ord), '[]'::jsonb)
    into v_lines
  from jsonb_array_elements(coalesce(p_quote -> 'lines', '[]'::jsonb)) with ordinality t(l, ord)
  left join lateral (
    select e as entry
    from jsonb_array_elements(coalesce(v_promo -> 'lines', '[]'::jsonb)) as e
    where (e ->> 'line_key')::integer = ord
    limit 1
  ) m on true;

  select ebim.promotion_totals(
           coalesce(jsonb_agg(jsonb_build_object(
             'line_key', (l ->> 'line_key')::integer,
             'amount',   l ->> 'net_amount',
             'discount', l ->> 'discount',
             'tax_rate', l ->> 'tax_rate')), '[]'::jsonb),
           v_inclusive)
    into v_totals
  from jsonb_array_elements(v_lines) as l;

  -- El impuesto por linea, pegado tambien: la factura tiene que poder
  -- explicarse linea a linea y no solo en el pie.
  select coalesce(jsonb_agg(
           l || jsonb_build_object('tax_amount', coalesce(tt.entry ->> 'tax_amount', '0.00'))
           order by (l ->> 'line_key')::integer), '[]'::jsonb)
    into v_lines
  from jsonb_array_elements(v_lines) as l
  left join lateral (
    select e as entry
    from jsonb_array_elements(coalesce(v_totals -> 'lines', '[]'::jsonb)) as e
    where (e ->> 'line_key')::integer = (l ->> 'line_key')::integer
    limit 1
  ) tt on true;

  return p_quote
    || jsonb_build_object(
         'lines',          v_lines,
         'subtotal',       v_totals ->> 'subtotal',
         'discount_total', v_totals ->> 'discount_total',
         'tax_total',      v_totals ->> 'tax_total',
         'grand_total',    v_totals ->> 'grand_total',
         'promotions', jsonb_build_object(
           'entitled', v_promo -> 'entitled',
           'applied',  coalesce(v_promo -> 'applied', '[]'::jsonb),
           'skipped',  coalesce(v_promo -> 'skipped', '[]'::jsonb),
           'coupons',  coalesce(v_promo -> 'coupons', '[]'::jsonb)));
end;
$fn$;

revoke execute on function ebim.apply_promotions(
  uuid, uuid, jsonb, text[], uuid, uuid, uuid, text, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function ebim.apply_promotions(
  uuid, uuid, jsonb, text[], uuid, uuid, uuid, text, timestamptz, boolean
) to service_role;

-- ---------------------------------------------------------------------------
-- ebim.redeem_promotions — apuntar el canje y mover el contador.
--
-- Corre DENTRO de la transaccion que crea el pedido, y despues de que
-- `evaluate_promotions` haya bloqueado las filas con tope. Ese orden es la
-- garantia: entre contar y gastar no cabe otra transaccion.
--
-- Es `SECURITY DEFINER` y esta revocada a `anon` y `authenticated` porque mueve
-- el contador de una tabla cuyo `usage_count` no tiene GRANT de UPDATE para
-- nadie. La autorizacion va dentro: el tenant sale de la fila del PEDIDO, no de
-- un parametro.
-- ---------------------------------------------------------------------------
create or replace function ebim.redeem_promotions(
  p_order_id uuid,
  p_applied  jsonb,
  p_customer_id uuid default null,
  p_business_account_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
  v_entry jsonb;
  v_count integer := 0;
begin
  if p_applied is null or jsonb_typeof(p_applied) <> 'array'
     or jsonb_array_length(p_applied) = 0 then
    return 0;
  end if;

  select * into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay pedido al que atar el canje'
      using errcode = '22023';
  end if;

  for v_entry in select * from jsonb_array_elements(p_applied)
  loop
    -- El canje es idempotente por (pedido, campana): un reintento del alta no
    -- gasta dos usos del mismo cupon para la misma compra.
    insert into public.promotion_redemptions (
      organization_id, company_id, store_id,
      promotion_id, coupon_id, order_id,
      customer_email, customer_id, business_account_id,
      discount_amount, currency
    )
    select v_order.organization_id, v_order.company_id, v_order.store_id,
           (v_entry ->> 'promotion_id')::uuid,
           ebim.safe_uuid(v_entry ->> 'coupon_id'),
           v_order.id,
           lower(v_order.customer_email), p_customer_id, p_business_account_id,
           coalesce((v_entry ->> 'amount')::numeric, 0), v_order.currency
    on conflict (order_id, promotion_id) do nothing;

    if found then
      update public.promotions
         set usage_count = usage_count + 1
       where id = (v_entry ->> 'promotion_id')::uuid;

      if ebim.safe_uuid(v_entry ->> 'coupon_id') is not null then
        update public.coupons
           set usage_count = usage_count + 1
         where id = ebim.safe_uuid(v_entry ->> 'coupon_id');
      end if;

      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$fn$;

revoke execute on function ebim.redeem_promotions(uuid, jsonb, uuid, uuid)
  from public, anon, authenticated;
grant execute on function ebim.redeem_promotions(uuid, jsonb, uuid, uuid) to service_role;

comment on function ebim.redeem_promotions(uuid, jsonb, uuid, uuid) is
  'Apunta el canje y mueve el contador, dentro de la transaccion del pedido y despues del cerrojo de evaluate_promotions. Idempotente por (pedido, campana).';

-- ---------------------------------------------------------------------------
-- public.promotion_quote_for_slug — lo que pide el carrito de la VITRINA.
--
-- El comprador anonimo manda el slug, que quiere comprar y —si lo tiene— su
-- codigo de cupon. Todo lo demas lo pone el servidor: la tienda (activa), el
-- canal (el publico por defecto), el precio, el descuento y el impuesto.
--
-- No bloquea nada (`p_lock := false`): cotizar no es comprar, y un carrito que
-- se mira no puede bloquear las campanas de los que si estan comprando.
--
-- **Lo que devuelve no es una autorizacion.** Es la misma respuesta que dara el
-- pedido si nada cambia, pero quien decide es `create_order`, que vuelve a
-- evaluar con los cerrojos puestos. El navegador no puede declarar que una
-- promocion se aplico: no hay parametro para eso (regla 6).
-- ---------------------------------------------------------------------------
create or replace function public.promotion_quote_for_slug(
  p_store_slug   text,
  p_items        jsonb,
  p_coupon_codes text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store   public.stores%rowtype;
  v_channel public.channels%rowtype;
  v_slug    text := lower(btrim(coalesce(p_store_slug, '')));
  v_quote   jsonb;
begin
  if v_slug = '' then
    raise exception 'TIENDA_NO_DISPONIBLE: falta la tienda de la cotizacion'
      using errcode = '22023';
  end if;

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

  v_quote := ebim.build_quote(v_store.id, v_channel.id, p_items, null, null, now(), true);

  return ebim.apply_promotions(
    v_store.id, v_channel.id, v_quote, p_coupon_codes,
    null, null, null, null, now(), false);
end;
$fn$;

revoke execute on function public.promotion_quote_for_slug(text, jsonb, text[]) from public;
grant  execute on function public.promotion_quote_for_slug(text, jsonb, text[])
  to anon, authenticated, service_role;

comment on function public.promotion_quote_for_slug(text, jsonb, text[]) is
  'Cotizacion publica CON promociones: tienda por slug, canal publico, cupones tecleados. No bloquea y no autoriza nada: quien decide es create_order.';

-- ---------------------------------------------------------------------------
-- public.promotion_simulate — el simulador del backoffice (regla 9).
--
-- "¿Que le pasaria a este carrito con las campanas de hoy?" es la unica forma
-- de comprobar una prioridad, una exclusion o un solapamiento ANTES de que lo
-- descubra un comprador. Y con `p_at` tambien responde "¿que pasaria el lunes
-- que viene?", que es cuando se programa una campana.
--
-- `SECURITY DEFINER` con la autorizacion DENTRO: la membresia se comprueba
-- contra la tienda pedida antes de mirar una sola campana. No bloquea: simular
-- no es comprar, y una simulacion que bloqueara filas dejaria al backoffice
-- capaz de parar la tienda.
-- ---------------------------------------------------------------------------
create or replace function public.promotion_simulate(
  p_store_id     uuid,
  p_items        jsonb,
  p_coupon_codes text[]      default null,
  p_channel_id   uuid        default null,
  p_segment_id   uuid        default null,
  p_customer_id  uuid        default null,
  p_at           timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store   public.stores%rowtype;
  v_channel public.channels%rowtype;
  v_at      timestamptz := coalesce(p_at, now());
  v_quote   jsonb;
begin
  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    raise exception 'TIENDA_NO_ENCONTRADA: la tienda no existe' using errcode = '22023';
  end if;

  if not ebim.can_access(v_store.organization_id, v_store.company_id) then
    raise exception 'SIN_PERMISO: la tienda no pertenece a este usuario' using errcode = '42501';
  end if;

  if p_channel_id is null then
    select * into v_channel
    from public.channels c
    where c.store_id = v_store.id and c.is_default and c.is_active;
  else
    select * into v_channel
    from public.channels c
    where c.id = p_channel_id and c.store_id = v_store.id and c.is_active;
  end if;

  if not found then
    raise exception 'CANAL_NO_DISPONIBLE: no hay canal activo para simular' using errcode = '22023';
  end if;

  if p_segment_id is not null and not exists (
    select 1 from public.customer_segments cs
    where cs.id = p_segment_id
      and cs.organization_id = v_store.organization_id
      and cs.company_id      = v_store.company_id
  ) then
    raise exception 'SEGMENTO_NO_ENCONTRADO: ese segmento no es de esta sociedad' using errcode = '22023';
  end if;

  if p_customer_id is not null and not exists (
    select 1 from public.customers c
    where c.id = p_customer_id
      and c.organization_id = v_store.organization_id
      and c.company_id      = v_store.company_id
  ) then
    raise exception 'CLIENTE_NO_ENCONTRADO: ese cliente no es de esta sociedad' using errcode = '22023';
  end if;

  -- `p_public := false`: simular el efecto de una campana sobre un producto que
  -- todavia no se publico es exactamente para lo que sirve un simulador.
  v_quote := ebim.build_quote(
    v_store.id, v_channel.id, p_items, p_segment_id, p_customer_id, v_at, false);

  return ebim.apply_promotions(
    v_store.id, v_channel.id, v_quote, p_coupon_codes,
    p_customer_id, p_segment_id, null, null, v_at, false);
end;
$fn$;

revoke execute on function
  public.promotion_simulate(uuid, jsonb, text[], uuid, uuid, uuid, timestamptz)
from public, anon;
grant execute on function
  public.promotion_simulate(uuid, jsonb, text[], uuid, uuid, uuid, timestamptz)
to authenticated, service_role;

comment on function
  public.promotion_simulate(uuid, jsonb, text[], uuid, uuid, uuid, timestamptz) is
  'Simulador de campanas del backoffice: el MISMO motor que la vitrina y que el pedido, con canal, segmento, cliente y fecha explicitos. No bloquea nada.';
