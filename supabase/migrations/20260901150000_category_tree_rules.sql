-- =============================================================================
-- P18 · Categorias en ARBOL (fase 3: las reglas de negocio heredan, si lo dicen).
--
-- La fase 2 hizo que abrir una categoria en la vitrina enseñe lo que cuelga de
-- ella. Aqui la pregunta es otra y la respuesta NO puede ser la misma:
--
--   «-20 % en Cuidado de la piel», ¿cubre lo que alguien cuelgue debajo manana?
--
-- Cambiar esa semantica por debajo alteraria campañas YA GUARDADAS y aprobadas:
-- el descuento de una rama pasaria a aplicarse a productos que nadie reviso
-- cuando se autorizo. Un motor de precios no puede ampliarse solo.
--
-- Asi que la herencia es una DECISION por alcance, no un cambio global:
-- `include_descendants`, apagada por defecto. Lo que hay guardado sigue
-- significando exactamente lo que significaba el dia que se guardo.
--
-- Lo mismo para los bloques de contenido: una coleccion de productos por
-- categoria gana la clave `descendants` en su vocabulario cerrado de ajustes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 · El alcance de una promocion puede incluir la descendencia.
-- ---------------------------------------------------------------------------
alter table public.promotion_scopes
  add column if not exists include_descendants boolean not null default false;

comment on column public.promotion_scopes.include_descendants is
  'Solo para scope_kind = category: la campana cubre tambien las subcategorias. Apagada por defecto: una campana no se amplia sola.';

-- Una casilla que solo significa algo en un alcance de categoria. En los demas
-- seria un dato que miente: alguien la veria encendida en un alcance de marca y
-- creeria que hace algo.
alter table public.promotion_scopes
  drop constraint if exists promotion_scopes_descendants_only_category;
alter table public.promotion_scopes
  add constraint promotion_scopes_descendants_only_category
    check (not include_descendants or scope_kind = 'category');

-- ---------------------------------------------------------------------------
-- 2 · El motor: la categoria exacta, o toda su rama si el alcance lo pide.
--
-- `ebim.category_subtree` (fase 1) resuelve la rama. La condicion se escribe
-- dos veces —inclusion y exclusion— porque son dos listas distintas y una
-- exclusion que no heredara mientras la inclusion si lo hace dejaria un agujero
-- silencioso: «toda la rama menos esta subcategoria» tiene que poder decirse.
-- ---------------------------------------------------------------------------
create or replace function ebim.promotion_scope_matches(
  p_scope public.promotion_scopes,
  p_product_id uuid,
  p_variant_id uuid,
  p_category_id uuid,
  p_brand_id uuid
)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select case p_scope.scope_kind
    when 'all'      then true
    when 'product'  then p_scope.product_id = p_product_id
    when 'variant'  then p_scope.variant_id = p_variant_id
    when 'brand'    then p_scope.brand_id   = p_brand_id
    when 'category' then
      case
        when p_scope.include_descendants then
          p_category_id in (select category_id from ebim.category_subtree(p_scope.category_id))
        else p_scope.category_id = p_category_id
      end
    else false
  end;
$fn$;

revoke execute on function ebim.promotion_scope_matches(public.promotion_scopes, uuid, uuid, uuid, uuid)
  from public;
grant execute on function ebim.promotion_scope_matches(public.promotion_scopes, uuid, uuid, uuid, uuid)
  to anon, authenticated, service_role;

comment on function ebim.promotion_scope_matches(public.promotion_scopes, uuid, uuid, uuid, uuid) is
  'Un alcance de campana contra una linea. La categoria compara exacta salvo que el alcance pida su descendencia.';

-- ---------------------------------------------------------------------------
-- 3 · Los bloques de contenido: `descendants` entra en el vocabulario cerrado.
--
-- `settings` es una lista blanca de claves a proposito (ver
-- `20260828140000_cms_core.sql`): en el momento en que admita claves libres,
-- sera el sitio donde alguien meta una URL de script «porque es configuracion».
-- Anadir una clave es anadirla aqui y en `src/domain/content.ts`, que son las
-- dos mitades de la misma regla.
-- ---------------------------------------------------------------------------
create or replace function ebim.content_settings_are_safe(p_settings jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    jsonb_typeof(p_settings) = 'object'
    and (select count(*) from jsonb_object_keys(p_settings)) <= 12
    and not exists (
      select 1
      from jsonb_each(p_settings) as e(key, value)
      where e.key not in (
              'layout', 'columns', 'autoplay', 'interval_ms', 'align', 'tone',
              'show_price', 'show_cta', 'aspect', 'background', 'compact', 'reverse',
              -- P18 · `descendants`: una coleccion por categoria incluye las
              -- subcategorias. Apagada por defecto, como en las campañas.
              'descendants'
            )
         or jsonb_typeof(e.value) not in ('string', 'number', 'boolean')
         or (jsonb_typeof(e.value) = 'string' and char_length(e.value #>> '{}') > 60)
    ),
    false
  );
$fn$;

comment on function ebim.content_settings_are_safe(jsonb) is
  'Mandos de presentacion de un bloque: vocabulario CERRADO de claves y valores escalares. `descendants` (P18) incluye las subcategorias en una coleccion.';

-- ---------------------------------------------------------------------------
-- 4 · El motor de campañas mira la rama cuando el alcance lo pide.
--
-- `ebim.evaluate_promotions` se reescribe ENTERA porque Postgres no sabe
-- sustituir una condicion dentro de un cuerpo. Solo cambian DOS lineas, las dos
-- marcadas con `P18`: el match de categoria en la lista de inclusion y el mismo
-- en la de exclusion.
--
-- Que la exclusion herede tambien no es simetria por simetria: sin ella no se
-- podria decir «toda la rama MENOS esta subcategoria», que es justo la forma en
-- la que un comercio acota una campaña grande.
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
            or (s.scope_kind = 'category' and (
                 -- P18 · Exacta, o toda la rama si el alcance lo pide. La
                 -- casilla esta apagada por defecto: una campana guardada no
                 -- puede ampliarse sola a lo que alguien cuelgue manana.
                 case when s.include_descendants
                   then ln.category_id in (
                     select category_id from ebim.category_subtree(s.category_id))
                   else s.category_id = ln.category_id
                 end))
            or (s.scope_kind = 'brand'    and s.brand_id    = ln.brand_id)))
      and not exists (
        select 1 from public.promotion_scopes s
        where s.promotion_id = v_promo.id and s.is_exclusion
          and (s.scope_kind = 'all'
            or (s.scope_kind = 'product'  and s.product_id  = ln.product_id)
            or (s.scope_kind = 'variant'  and s.variant_id  = ln.variant_id)
            or (s.scope_kind = 'category' and (
                 -- P18 · Exacta, o toda la rama si el alcance lo pide. La
                 -- casilla esta apagada por defecto: una campana guardada no
                 -- puede ampliarse sola a lo que alguien cuelgue manana.
                 case when s.include_descendants
                   then ln.category_id in (
                     select category_id from ebim.category_subtree(s.category_id))
                   else s.category_id = ln.category_id
                 end))
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

-- ---------------------------------------------------------------------------
-- 5 · Las colecciones de producto del CMS, con la misma casilla.
--
-- `ebim.content_block_items_json` se reescribe entera por lo mismo que las dos
-- anteriores. Cambia UNA condicion, marcada con `P18`.
--
-- El bloque `category_collection` no se toca: ese ya enseñaba las HIJAS de la
-- categoria desde P11, que es lo que un menu de secciones tiene que hacer.
-- ---------------------------------------------------------------------------
create or replace function ebim.content_block_items_json(
  p_block public.content_blocks
)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  with manual as (
    select i.item_kind, i.product_id, i.variant_id, i.category_id, i.position
    from public.content_block_items i
    where i.block_id = p_block.id
    order by i.position, i.id
    limit p_block.item_limit
  ),
  has_manual as (select exists (select 1 from manual) as yes),
  -- Automatica por categoria, solo si no hay curacion manual.
  auto_products as (
    select 'product'::public.content_item_kind as item_kind,
           pp.product_id, null::uuid as variant_id, null::uuid as category_id,
           row_number() over (order by pp.published_at desc, pp.product_id)::int as position
    from public.public_products pp
    where p_block.category_id is not null
      and p_block.block_type in ('product_collection', 'carousel')
      and not (select yes from has_manual)
      and pp.store_id = p_block.store_id
      -- P18 · Con `descendants` encendido, la coleccion incluye lo que cuelga
      -- de la categoria. Apagado por defecto: un bloque publicado no cambia de
      -- contenido porque alguien anada una subcategoria manana.
      and (
        case when coalesce((p_block.settings ->> 'descendants')::boolean, false)
          then pp.category_id in (
            select category_id from ebim.category_subtree(p_block.category_id))
          else pp.category_id = p_block.category_id
        end
      )
    order by pp.published_at desc, pp.product_id
    limit p_block.item_limit
  ),
  auto_categories as (
    select 'category'::public.content_item_kind as item_kind,
           null::uuid as product_id, null::uuid as variant_id, pc.category_id,
           row_number() over (order by pc.position, pc.name)::int as position
    from public.public_categories pc
    where p_block.category_id is not null
      and p_block.block_type = 'category_collection'
      and not (select yes from has_manual)
      and pc.store_id = p_block.store_id
      and pc.parent_id = p_block.category_id
    order by pc.position, pc.name
    limit p_block.item_limit
  ),
  chosen as (
    select * from manual
    union all select * from auto_products
    union all select * from auto_categories
  )
  select coalesce(
    jsonb_agg(resolved.item order by resolved.position) filter (where resolved.item is not null),
    '[]'::jsonb
  )
  from (
    select c.position, case c.item_kind
      when 'product' then (
        select jsonb_build_object(
          'kind',       'product',
          'product_id', pp.product_id,
          'slug',       pp.slug,
          'name',       pp.name,
          'brand_name', pp.brand_name,
          -- El importe sale como TEXTO: el centimo no pasa por el float del
          -- navegador (regla de dinero del repositorio desde P02).
          'price',      pp.price::text,
          'compare_at_price', pp.compare_at_price::text,
          'price_from', pp.price_from::text,
          'currency',   pp.currency,
          'in_stock',   pp.in_stock,
          'image_path', pp.primary_image_path,
          'image_alt',  pp.primary_image_alt
        )
        from public.public_products pp
        where pp.product_id = c.product_id and pp.store_id = p_block.store_id
      )
      when 'variant' then (
        select jsonb_build_object(
          'kind',       'variant',
          'product_id', pv.product_id,
          'variant_id', pv.variant_id,
          'slug',       pp.slug,
          'name',       pp.name,
          'variant_label', pv.name,
          'price',      pv.price::text,
          'compare_at_price', pv.compare_at_price::text,
          'currency',   pv.currency,
          'in_stock',   pv.in_stock,
          'image_path', pp.primary_image_path,
          'image_alt',  pp.primary_image_alt
        )
        from public.public_product_variants pv
        join public.public_products pp
          on pp.product_id = pv.product_id and pp.store_id = p_block.store_id
        where pv.variant_id = c.variant_id
      )
      else (
        select jsonb_build_object(
          'kind',     'category',
          'category_id', pc.category_id,
          'slug',     pc.slug,
          'name',     pc.name
        )
        from public.public_categories pc
        where pc.category_id = c.category_id and pc.store_id = p_block.store_id
      )
    end as item
    from chosen c
  ) resolved;
$fn$;
