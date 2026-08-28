-- =============================================================================
-- P04-SaaS · resolvePrice: la resolucion determinista del precio
--
-- Este archivo es el motor. Una sola definicion de "cuanto cuesta esta linea",
-- escrita una vez y en el servidor, que usan los tres caminos que hoy hablan de
-- dinero: la vitrina publica (lo que se MUESTRA), la cotizacion del carrito (lo
-- que se RECALCULA) y `create_order` (lo que se COBRA). Tres copias de esta
-- regla en tres lenguajes es exactamente como se acaba cobrando algo distinto
-- de lo que decia la pantalla.
--
-- ## El contexto explicito
--
-- `ebim.resolve_prices` recibe TODO lo que puede cambiar un precio y nada mas:
-- tienda, canal, segmento, cliente, producto, variante, presentacion, cantidad,
-- momento y moneda. Nada de eso se adivina y nada de eso llega del navegador:
-- la tienda sale del slug de la URL resuelto en el servidor, el canal sale de
-- la tienda, y el segmento y el cliente solo existen si un llamante de servidor
-- los pone. El comprador anonimo no tiene forma de pedir el precio de otro.
--
-- ## La precedencia, escrita una vez
--
-- Cuando varias listas alcanzan la misma linea, gana la primera de este orden y
-- el orden es TOTAL — no hay empate posible, y por eso el resultado no depende
-- del plan de ejecucion:
--
--   1. **Especificidad del alcance**: cliente (40) > segmento (30) > canal (20)
--      > tienda (10). No es configurable: un precio negociado con un cliente no
--      puede quedar por debajo del precio general por haber tecleado mal una
--      prioridad.
--   2. **`priority` de la lista**, descendente. Es el unico dial del operador.
--   3. **`valid_from` mas reciente.** Entre dos acuerdos iguales manda el
--      ultimo firmado.
--   4. **`id` de la lista.** Desempate final, arbitrario pero ESTABLE. Que
--      exista no es una excusa para llegar hasta aqui: `price_list_conflicts`
--      denuncia como ambiguas las combinaciones que dependen de este paso.
--
-- Ya dentro de la lista ganadora, entre sus renglones:
--
--   5. **Variante concreta** antes que precio para todas las variantes. La
--      variante es identidad; decir "la roja vale X" es mas concreto que decir
--      "la camiseta vale X".
--   6. **Presentacion concreta** antes que precio por unidad base.
--   7. **Escala mayor alcanzada**: de 1, 10 y 100, con 120 unidades gana 100.
--   8. `id` del renglon.
--
-- La lista de mayor precedencia gana AUNQUE su renglon sea menos concreto que
-- el de una lista inferior: primero se elige el acuerdo, despues el renglon
-- dentro del acuerdo. Al reves, un precio de catalogo por variante podria
-- ganarle a un precio negociado por producto, que es justo lo contrario de lo
-- que un comercial espera.
--
-- ## El fallback al precio legado
--
-- Si ninguna lista alcanza —porque no hay, porque no estan vigentes, porque la
-- moneda no coincide o porque la sociedad no tiene el modulo contratado— la
-- respuesta es el precio de CATALOGO exactamente como se calculaba antes de
-- esta fase: `product_uoms.price` si la presentacion tiene el suyo, y si no
-- `coalesce(variante.price, producto.price) * factor`. `source` lo dice, y hay
-- tests que fijan cada uno de esos cuatro casos.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.active_price_lists — que acuerdos estan VIVOS, y para quien.
--
-- Vista sin `security_invoker`, o sea que se ejecuta con los permisos de su
-- dueno. Es deliberado y es lo que permite que la vitrina anonima vea un precio
-- de lista sin tener ni un GRANT sobre `price_lists`. Por eso NO se concede a
-- `anon`: sus dos unicos consumidores son piezas que ya llevan su propia
-- autorizacion dentro (`ebim.public_unit_prices` y `ebim.resolve_prices`).
--
-- El entitlement se comprueba AQUI, con un join y no con `ebim.has_capability`:
-- una funcion invocada dentro de una vista definer corre como el usuario que
-- pregunta, asi que `has_capability` devolveria «no» para el anonimo y ninguna
-- lista se aplicaria jamas en la vitrina. El join, en cambio, si corre con los
-- permisos de la vista. La composicion es la misma que `company_is_entitled`:
-- app activa Y addon activo Y flag tecnico que no lo apague.
-- ---------------------------------------------------------------------------
create view ebim.active_price_lists as
select
  pl.id              as price_list_id,
  pl.store_id,
  pl.organization_id,
  pl.company_id,
  pl.code            as price_list_code,
  pl.name            as price_list_name,
  pl.currency,
  pl.priority,
  pl.valid_from,
  pl.valid_to,
  a.id               as assignment_id,
  a.scope,
  a.channel_id,
  a.segment_id,
  a.customer_id,
  case a.scope
    when 'customer' then 40
    when 'segment'  then 30
    when 'channel'  then 20
    else 10
  end                as scope_rank
from public.price_lists pl
join public.price_list_assignments a
  on a.price_list_id = pl.id
 and a.store_id      = pl.store_id
 and a.is_active
join public.app_capabilities cap
  on cap.code = 'pricing.lists'
join public.tenant_entitlements ent
  on ent.organization_id  = pl.organization_id
 and ent.company_id       = pl.company_id
 and ent.entitlement_code = cap.entitlement_code
 and ent.is_active
left join public.tenant_platform_context ctx
  on ctx.organization_id = pl.organization_id
 and ctx.company_id      = pl.company_id
left join public.tenant_feature_flags flag
  on flag.organization_id = pl.organization_id
 and flag.company_id      = pl.company_id
 and flag.flag_key        = 'pricing.lists'
where pl.is_active
  and coalesce(ctx.app_active, true)
  and coalesce(flag.is_enabled, true);

revoke all on ebim.active_price_lists from public, anon, authenticated;
grant select on ebim.active_price_lists to service_role;

comment on view ebim.active_price_lists is
  'Listas vivas de tenants con el modulo contratado, con su asignacion y su rango de especificidad. Definer: no se concede a anon.';

-- ---------------------------------------------------------------------------
-- El tipo de salida.
--
-- Compuesto y no parametros OUT a proposito: con OUT, cada nombre de columna
-- entra en el ambito de la consulta y `product_id` sin calificar se vuelve
-- ambiguo. Un tipo mantiene la funcion legible y el desglose entero en un solo
-- valor, que es lo que el carrito necesita para explicar el precio.
-- ---------------------------------------------------------------------------
create type ebim.price_resolution as (
  line_key           text,
  product_id         uuid,
  variant_id         uuid,
  uom_id             uuid,
  quantity           numeric,
  uom_factor         numeric,
  quantity_base      numeric,
  unit_price         numeric,
  compare_at_price   numeric,
  source             text,
  price_list_id      uuid,
  price_list_code    text,
  price_list_item_id uuid,
  scope              text,
  min_quantity       numeric,
  currency           char(3)
);

-- ---------------------------------------------------------------------------
-- ebim.resolve_prices — el motor, EN LOTE.
--
-- En lote y no linea a linea porque es la unica forma de que un carrito de 50
-- articulos contra 5 listas siga siendo UNA consulta. Linea a linea seria N
-- veces la misma resolucion —el N+1 clasico— y con miles de SKU y varias listas
-- se nota en la primera campana.
--
-- `SECURITY DEFINER` con la autorizacion DONDE corresponde: esta funcion no la
-- llama nadie directamente (no tiene GRANT para `anon` ni `authenticated`). La
-- llaman `public.price_quote_for_slug`, `public.price_quote` y `create_order`,
-- y cada una comprueba lo suyo antes: tienda activa, canal publico, membresia.
-- Lo que la funcion garantiza por su cuenta es que **solo mira productos de la
-- tienda que se le pasa**: un `product_id` de otra tienda simplemente no
-- devuelve fila.
-- ---------------------------------------------------------------------------
create or replace function ebim.resolve_prices(
  p_store_id    uuid,
  p_channel_id  uuid,
  p_lines       jsonb,
  p_currency    char(3)     default null,
  p_at          timestamptz default now(),
  p_segment_id  uuid        default null,
  p_customer_id uuid        default null
)
returns setof ebim.price_resolution
language sql
stable
security definer
set search_path = ''
as $fn$
  with input as (
    select
      coalesce(nullif(btrim(l.line_key), ''), l.product_id::text) as line_key,
      l.product_id,
      l.variant_id,
      l.uom_id,
      coalesce(l.quantity, 1) as quantity
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as l(line_key text, product_id uuid, variant_id uuid, uom_id uuid, quantity numeric)
    where l.product_id is not null
  ),
  resolved as (
    select
      i.line_key,
      i.product_id,
      i.variant_id,
      i.uom_id,
      i.quantity,
      p.store_id,
      coalesce(p_currency, p.currency)   as currency,
      coalesce(pu.factor, 1)             as uom_factor,
      pu.price                           as uom_price,
      -- Herencia de la variante, la misma de P03-SaaS: sin precio propio, el
      -- del maestro. Escrita aqui una vez para las tres pantallas.
      coalesce(v.price, p.price)         as catalog_base_price,
      case
        when i.variant_id is null then p.compare_at_price
        when v.price is null      then p.compare_at_price
        else v.compare_at_price
      end                                as catalog_base_compare
    from input i
    join public.products p
      on p.id = i.product_id
     and p.store_id = p_store_id
    left join public.product_variants v
      on v.id = i.variant_id
     and v.product_id = p.id
    left join public.product_uoms pu
      on pu.uom_id = i.uom_id
     and pu.product_id = p.id
  ),
  best as (
    select distinct on (r.line_key)
      r.line_key,
      l.price_list_id,
      l.price_list_code,
      l.scope::text        as scope,
      it.id                as item_id,
      it.unit_price,
      it.compare_at_price,
      it.min_quantity,
      it.uom_id            as item_uom_id
    from resolved r
    join ebim.active_price_lists l
      on l.store_id = r.store_id
     and l.currency = r.currency
     and l.valid_from <= p_at
     and (l.valid_to is null or l.valid_to > p_at)
     and (
          l.scope = 'store'
       or (l.scope = 'channel'  and l.channel_id  = p_channel_id)
       or (l.scope = 'segment'  and l.segment_id  = p_segment_id)
       or (l.scope = 'customer' and l.customer_id = p_customer_id)
     )
    join public.price_list_items it
      on it.price_list_id = l.price_list_id
     and it.product_id    = r.product_id
     -- Un renglon sin variante vale para todas; con variante, solo para esa.
     and (it.variant_id is null or it.variant_id = r.variant_id)
     -- Un precio absoluto de OTRA presentacion no dice nada de esta.
     and (it.uom_id is null or it.uom_id = r.uom_id)
     -- La escala se mide en unidades base.
     and it.min_quantity <= r.quantity * r.uom_factor
    order by
      r.line_key,
      l.scope_rank desc, l.priority desc, l.valid_from desc, l.price_list_id,
      (it.variant_id is not null) desc, (it.uom_id is not null) desc,
      it.min_quantity desc, it.id
  )
  select
    r.line_key,
    r.product_id,
    r.variant_id,
    r.uom_id,
    r.quantity,
    r.uom_factor,
    r.quantity * r.uom_factor as quantity_base,
    case
      -- Sin lista: el precio de catalogo, tal cual se calculaba antes de P04.
      when b.item_id is null then
        coalesce(r.uom_price, round(r.catalog_base_price * r.uom_factor, 2))
      -- Renglon de la presentacion pedida: precio ABSOLUTO, no se multiplica.
      when b.item_uom_id is not null then b.unit_price
      -- Renglon por unidad base: se convierte con el factor.
      else round(b.unit_price * r.uom_factor, 2)
    end as unit_price,
    case
      when b.item_id is null then
        -- Con precio propio de presentacion no se arrastra el tachado del
        -- catalogo: anunciaria un descuento que nadie declaro.
        case when r.uom_price is not null then null
             else round(r.catalog_base_compare * r.uom_factor, 2) end
      when b.item_uom_id is not null then b.compare_at_price
      else round(b.compare_at_price * r.uom_factor, 2)
    end as compare_at_price,
    case when b.item_id is null then 'catalog' else 'price_list' end as source,
    b.price_list_id,
    b.price_list_code,
    b.item_id as price_list_item_id,
    b.scope,
    b.min_quantity,
    r.currency
  from resolved r
  left join best b on b.line_key = r.line_key;
$fn$;

revoke execute on function
  ebim.resolve_prices(uuid, uuid, jsonb, char, timestamptz, uuid, uuid)
from public, anon, authenticated;
grant execute on function
  ebim.resolve_prices(uuid, uuid, jsonb, char, timestamptz, uuid, uuid)
to service_role;

comment on function ebim.resolve_prices(uuid, uuid, jsonb, char, timestamptz, uuid, uuid) is
  'resolvePrice en lote: contexto explicito, precedencia total y fallback al precio de catalogo. Unica autoridad de precio base.';

-- ---------------------------------------------------------------------------
-- ebim.resolve_price — una linea, como jsonb. Azucar sobre la de arriba.
-- No duplica ni una regla: `create_order` la usa dentro de su bucle, que ya
-- recorre linea a linea porque tiene que bloquear existencias.
-- ---------------------------------------------------------------------------
create or replace function ebim.resolve_price(
  p_store_id    uuid,
  p_channel_id  uuid,
  p_product_id  uuid,
  p_variant_id  uuid        default null,
  p_uom_id      uuid        default null,
  p_quantity    numeric     default 1,
  p_currency    char(3)     default null,
  p_at          timestamptz default now(),
  p_segment_id  uuid        default null,
  p_customer_id uuid        default null
)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select to_jsonb(r)
  from ebim.resolve_prices(
    p_store_id,
    p_channel_id,
    jsonb_build_array(jsonb_build_object(
      'line_key',   'single',
      'product_id', p_product_id,
      'variant_id', p_variant_id,
      'uom_id',     p_uom_id,
      'quantity',   p_quantity
    )),
    p_currency, p_at, p_segment_id, p_customer_id
  ) as r;
$fn$;

revoke execute on function
  ebim.resolve_price(uuid, uuid, uuid, uuid, uuid, numeric, char, timestamptz, uuid, uuid)
from public, anon, authenticated;
grant execute on function
  ebim.resolve_price(uuid, uuid, uuid, uuid, uuid, numeric, char, timestamptz, uuid, uuid)
to service_role;

-- ---------------------------------------------------------------------------
-- ebim.public_unit_prices — el precio que ve la VITRINA.
--
-- Sin esto, el catalogo publico seguiria pintando `products.price` y el carrito
-- cobraria el de la lista: el comprador veria 10 y pagaria 8 —o 12—. Un
-- escaparate que miente sobre el precio no es un detalle de UX.
--
-- Resuelve de una vez, en conjunto y no por fila, el precio de:
--   · cada producto publicado (con `variant_id` nulo), y
--   · cada variante activa de esos productos,
-- para el canal PUBLICO por defecto de su tienda y para cantidad 1 en unidad
-- base, que es exactamente lo que muestra una tarjeta de catalogo.
--
-- Solo alcances `store` y `channel`: un precio de segmento o de cliente jamas
-- sale por aqui, porque quien mira la vitrina anonima no es ninguno de los dos.
-- Definer, con su autorizacion dentro: tienda activa, producto publicado y
-- canal publico. Lo unico que se puede sacar de esta vista es el precio de algo
-- que el que pregunta ya podia ver.
-- ---------------------------------------------------------------------------
-- Lo que sale de aqui son CINCO columnas y ni una mas: tienda, producto,
-- variante y los dos importes. Ni el id ni el codigo de la lista que gano —el
-- comprador necesita saber cuanto paga, no con que acuerdo se lo calcularon, y
-- que una tienda tenga una lista llamada "mayorista" es informacion comercial
-- de la sociedad. La resolucion completa vive en la subconsulta y se recorta
-- aqui, porque `distinct on` necesita esas columnas para desempatar.
create view ebim.public_unit_prices as
select store_id, product_id, variant_id, unit_price, compare_at_price
from (
select distinct on (t.product_id, t.variant_id)
  t.store_id,
  t.product_id,
  t.variant_id,
  it.unit_price,
  it.compare_at_price,
  l.price_list_id,
  l.price_list_code
from (
  select p.id as product_id, null::uuid as variant_id, p.store_id, p.currency
  from public.products p
  join public.stores s on s.id = p.store_id
  where s.status = 'active'
    and p.status = 'published'
    and p.published_at is not null
    and p.published_at <= now()
  union all
  select v.product_id, v.id as variant_id, v.store_id, p.currency
  from public.product_variants v
  join public.products p on p.id = v.product_id
  join public.stores  s on s.id = p.store_id
  where v.is_active
    and s.status = 'active'
    and p.status = 'published'
    and p.published_at is not null
    and p.published_at <= now()
) t
join ebim.active_price_lists l
  on l.store_id = t.store_id
 and l.currency = t.currency
 and l.valid_from <= now()
 and (l.valid_to is null or l.valid_to > now())
 and (
      l.scope = 'store'
   or (l.scope = 'channel' and exists (
        select 1
        from public.channels c
        where c.id = l.channel_id
          and c.store_id = t.store_id
          and c.is_default
          and c.is_active
          and not c.requires_auth))
 )
join public.price_list_items it
  on it.price_list_id = l.price_list_id
 and it.product_id    = t.product_id
 and (it.variant_id is null or it.variant_id = t.variant_id)
 -- Unidad base y cantidad 1: la tarjeta del catalogo no compra cajas.
 and it.uom_id is null
 and it.min_quantity <= 1
order by
  t.product_id, t.variant_id,
  l.scope_rank desc, l.priority desc, l.valid_from desc, l.price_list_id,
  (it.variant_id is not null) desc, it.min_quantity desc, it.id
) resolved;

revoke all on ebim.public_unit_prices from public;
grant select on ebim.public_unit_prices to anon, authenticated, service_role;

comment on view ebim.public_unit_prices is
  'Precio resuelto para la vitrina publica (alcances tienda y canal publico, cantidad 1, unidad base). Definer, con autorizacion dentro.';

-- ---------------------------------------------------------------------------
-- public_products — misma forma, precio resuelto.
--
-- Se recrea entera porque `price`, `compare_at_price` y `price_from` cambian de
-- ORIGEN, no de significado: siguen siendo "lo que paga el comprador por una
-- unidad", solo que ahora lo decide el motor y no una columna. Sin lista que
-- alcance, `coalesce` devuelve exactamente lo de antes — por eso ningun test de
-- vitrina existente cambia.
--
-- `compare_at_price` NO se hereda del catalogo cuando manda una lista: el
-- tachado del catalogo sobre un precio de lista anuncia un descuento que nadie
-- declaro. Es la misma regla que P03-SaaS aplico a la variante con precio
-- propio.
-- ---------------------------------------------------------------------------
drop view if exists public.public_products;

create view public.public_products
with (security_invoker = on) as
select
  p.id            as product_id,
  p.store_id,
  p.category_id,
  p.slug,
  p.name,
  p.description,
  coalesce(up.unit_price, p.price) as price,
  case when up.unit_price is null then p.compare_at_price else up.compare_at_price end
                  as compare_at_price,
  p.currency,
  p.published_at,
  p.custom_fields,
  p.kind,
  b.name          as brand_name,
  case p.kind
    when 'variant' then coalesce(v.any_available, false)
    when 'bundle'  then ebim.bundle_is_available(p.id)
    else p.in_stock
  end             as in_stock,
  coalesce(v.variant_count, 0) as variant_count,
  -- "desde": con variantes, el precio mas barato que el comprador puede pagar,
  -- ya resuelto contra las listas del canal publico.
  coalesce(v.min_price, up.unit_price, p.price) as price_from,
  c.slug          as category_slug,
  c.name          as category_name,
  img.storage_path as primary_image_path,
  img.alt          as primary_image_alt
from public.products p
left join public.categories c
  on c.id = p.category_id
 and c.store_id = p.store_id
 and c.is_active
left join public.brands b
  on b.id = p.brand_id
left join ebim.public_unit_prices up
  on up.product_id = p.id
 and up.variant_id is null
left join lateral (
  select count(*)::int        as variant_count,
         bool_or(pv.in_stock) as any_available,
         min(coalesce(vup.unit_price, pv.price, p.price)) as min_price
  from public.product_variants pv
  left join ebim.public_unit_prices vup on vup.variant_id = pv.id
  where pv.product_id = p.id
    and pv.is_active
) v on true
left join lateral (
  select i.storage_path, i.alt
  from public.product_images i
  where i.product_id = p.id
  order by i.is_primary desc, i.position asc
  limit 1
) img on true
where p.status = 'published'
  and p.published_at is not null
  and p.published_at <= now();

-- ---------------------------------------------------------------------------
-- public_product_variants — la misma herencia, ahora con lista delante.
-- ---------------------------------------------------------------------------
drop view if exists public.public_product_variants;

create view public.public_product_variants
with (security_invoker = on) as
select
  v.id            as variant_id,
  v.product_id,
  v.store_id,
  v.name,
  v.position,
  v.is_default,
  v.in_stock,
  coalesce(up.unit_price, v.price, p.price) as price,
  case
    when up.unit_price is not null then up.compare_at_price
    when v.price is null           then p.compare_at_price
    else v.compare_at_price
  end             as compare_at_price,
  p.currency
from public.product_variants v
join public.products p
  on p.id = v.product_id
 and p.store_id = v.store_id
left join ebim.public_unit_prices up
  on up.variant_id = v.id
where v.is_active;

revoke all on public.public_products         from public;
revoke all on public.public_product_variants from public;

grant select on public.public_products         to anon, authenticated, service_role;
grant select on public.public_product_variants to anon, authenticated, service_role;

comment on view public.public_products is
  'Producto publicado de tienda activa. `price` es el precio RESUELTO por el motor para el canal publico; sin lista, el de catalogo.';
comment on view public.public_product_variants is
  'Variantes vendibles con el precio ya resuelto. Sin SKU ni existencia exacta: el comprador ve precio y semaforo.';

-- ---------------------------------------------------------------------------
-- ebim.build_quote — la cotizacion completa de un carrito.
--
-- Es el servicio de aplicacion: valida las lineas, llama al motor UNA vez para
-- todas, aplica el impuesto vigente y arma el desglose. Los dos puntos de
-- entrada publicos —el anonimo por slug y el del backoffice— solo autorizan y
-- delegan aqui, para que la vitrina y el simulador no puedan responder cosas
-- distintas.
--
-- `p_public` es lo unico que cambia entre los dos: en publico, un producto no
-- publicado o fuera de canal no se cotiza; en el backoffice si, porque simular
-- el precio de algo antes de publicarlo es exactamente para lo que sirve.
--
-- NO reserva ni descuenta existencia y no lo va a hacer: cotizar no es comprar.
-- ---------------------------------------------------------------------------
create or replace function ebim.build_quote(
  p_store_id    uuid,
  p_channel_id  uuid,
  p_items       jsonb,
  p_segment_id  uuid,
  p_customer_id uuid,
  p_at          timestamptz,
  p_public      boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store      public.stores%rowtype;
  v_channel    public.channels%rowtype;
  v_scoped     boolean := false;
  v_inclusive  boolean := false;
  v_item       jsonb;
  v_product    public.products%rowtype;
  v_variant    public.product_variants%rowtype;
  v_has_var    boolean;
  v_uom_code   text;
  v_uom_id     uuid;
  v_qty        numeric;
  v_prepared   jsonb := '[]'::jsonb;
  v_normalized jsonb;
  v_lines      jsonb := '[]'::jsonb;
  v_subtotal   numeric(14,2) := 0;
  v_tax        numeric(14,2) := 0;
  v_index      integer := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ITEMS_REQUERIDOS: la cotizacion necesita al menos una linea'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > 100 then
    raise exception 'ITEMS_EXCESIVOS: maximo 100 lineas por cotizacion'
      using errcode = '22023';
  end if;

  -- La misma lista negra de `create_order`, y por la misma razon: si el
  -- navegador pudiera declarar precio, canal, segmento o cliente, cotizar seria
  -- una forma de pedirse a uno mismo el precio negociado del vecino.
  if exists (
    select 1
    from jsonb_array_elements(p_items) as item,
         jsonb_object_keys(item) as k
    where k in ('price', 'unit_price', 'line_total', 'subtotal', 'total',
                'currency', 'organization_id', 'company_id', 'store_id',
                'order_id', 'tenant_id', 'tax_rate', 'tax_total',
                'tax_category_id', 'channel_id', 'segment_id', 'customer_id',
                'price_list_id', 'uom_id', 'uom_factor', 'factor',
                'base_quantity', 'sku')
  ) then
    raise exception 'CAMPO_NO_PERMITIDO: el precio, el canal, el segmento y el cliente los decide el servidor'
      using errcode = '22023';
  end if;

  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda % no existe', p_store_id
      using errcode = '22023';
  end if;

  select * into v_channel from public.channels c where c.id = p_channel_id and c.store_id = v_store.id;
  if not found then
    raise exception 'CANAL_NO_DISPONIBLE: el canal no pertenece a esta tienda'
      using errcode = '22023';
  end if;

  select exists (
    select 1 from public.product_channels pc where pc.channel_id = v_channel.id
  ) into v_scoped;

  select coalesce(ss.tax_inclusive, false) into v_inclusive
  from public.store_settings ss where ss.store_id = v_store.id;
  v_inclusive := coalesce(v_inclusive, false);

  -- Agrupacion por producto + variante + presentacion, igual que el pedido.
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
    select (item ->> 'product_id')                                          as product_id,
           nullif(btrim(coalesce(item ->> 'variant_id', '')), '')           as variant_id,
           nullif(upper(btrim(coalesce(item ->> 'uom_code', ''))), '')      as uom_code,
           sum((item ->> 'quantity')::numeric)                              as quantity
    from jsonb_array_elements(p_items) as item
    group by 1, 2, 3
  ) grouped;

  for v_item in select * from jsonb_array_elements(v_normalized)
  loop
    v_index := v_index + 1;
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty <> trunc(v_qty) then
      raise exception 'CANTIDAD_INVALIDA: la cantidad debe ser un entero mayor que cero'
        using errcode = '22023';
    end if;

    select * into v_product
    from public.products p
    where p.id = ebim.safe_uuid(v_item ->> 'product_id')
      and p.store_id = v_store.id
      and (not p_public
           or (p.status = 'published' and p.published_at is not null and p.published_at <= now()));

    if not found then
      raise exception 'PRODUCTO_NO_DISPONIBLE: %', coalesce(v_item ->> 'product_id', 'null')
        using errcode = '22023';
    end if;

    if p_public and v_scoped and not exists (
      select 1 from public.product_channels pc
      where pc.channel_id = v_channel.id and pc.product_id = v_product.id
    ) then
      raise exception 'PRODUCTO_FUERA_DE_CANAL: % no esta a la venta en el canal %',
        v_product.sku, v_channel.code
        using errcode = '22023';
    end if;

    v_has_var := (v_item ->> 'variant_id') is not null;

    if v_product.kind = 'variant' and not v_has_var then
      raise exception 'VARIANTE_REQUERIDA: % se vende por variante y la cotizacion no dice cual', v_product.sku
        using errcode = '22023';
    end if;
    if v_product.kind <> 'variant' and v_has_var then
      raise exception 'VARIANTE_NO_APLICA: % no tiene variantes', v_product.sku
        using errcode = '22023';
    end if;

    if v_has_var then
      select * into v_variant
      from public.product_variants pv
      where pv.id = ebim.safe_uuid(v_item ->> 'variant_id')
        and pv.product_id = v_product.id
        and pv.is_active;
      if not found then
        raise exception 'VARIANTE_NO_DISPONIBLE: %', coalesce(v_item ->> 'variant_id', 'null')
          using errcode = '22023';
      end if;
    else
      v_variant := null;
    end if;

    v_uom_code := v_item ->> 'uom_code';
    if v_uom_code is null then
      v_uom_id := null;
    else
      select pu.uom_id into v_uom_id
      from public.product_uoms pu
      join public.units_of_measure u
        on u.id = pu.uom_id
       and u.organization_id = pu.organization_id
       and u.company_id      = pu.company_id
      where pu.product_id = v_product.id
        and upper(u.code) = v_uom_code
        and pu.is_sellable
        and u.is_active;

      if v_uom_id is null then
        raise exception 'UOM_NO_DISPONIBLE: % no se vende en la unidad %', v_product.sku, v_uom_code
          using errcode = '22023';
      end if;
    end if;

    v_prepared := v_prepared || jsonb_build_object(
      'line_key',   v_index::text,
      'product_id', v_product.id,
      'variant_id', case when v_has_var then v_variant.id else null end,
      'uom_id',     v_uom_id,
      'uom_code',   v_uom_code,
      'quantity',   v_qty,
      'name',       case when v_has_var
                         then v_product.name || ' · ' || v_variant.name
                         else v_product.name end,
      'tax_rate',   coalesce(ebim.effective_tax_rate(v_store.id, v_product.tax_category_id, p_at), 0)::text
    );
  end loop;

  -- UNA llamada al motor para TODAS las lineas. Es el punto de la funcion en
  -- lote: cotizar 50 articulos no puede costar 50 resoluciones.
  select coalesce(jsonb_agg(line order by line_index), '[]'::jsonb)
    into v_lines
  from (
    select
      (m.item ->> 'line_key')::integer as line_index,
      jsonb_build_object(
        'product_id',       r.product_id,
        'variant_id',       r.variant_id,
        'name',             m.item ->> 'name',
        'uom_code',         m.item ->> 'uom_code',
        'quantity',         r.quantity,
        'unit_price',       r.unit_price::text,
        'compare_at_price', case when r.compare_at_price is null then null
                                 else r.compare_at_price::text end,
        'net_amount',       round(r.unit_price * r.quantity, 2)::text,
        'tax_rate',         m.item ->> 'tax_rate',
        'source',           r.source,
        'price_list_id',    r.price_list_id,
        'price_list_code',  r.price_list_code,
        'scope',            r.scope,
        'min_quantity',     case when r.min_quantity is null then null
                                 else r.min_quantity::text end
      ) as line
    from jsonb_array_elements(v_prepared) as m(item)
    join ebim.resolve_prices(
           v_store.id, v_channel.id, v_prepared,
           v_store.currency, p_at, p_segment_id, p_customer_id
         ) r on r.line_key = m.item ->> 'line_key'
  ) ordered;

  -- Redondeo por grupo de tasa, exactamente como `create_order`: por linea o
  -- sobre el total daria un centimo distinto y la cotizacion dejaria de
  -- coincidir con el pedido.
  if v_inclusive then
    select coalesce(sum(g.gross - round(g.gross - g.gross / (1 + g.rate), 2)), 0),
           coalesce(sum(round(g.gross - g.gross / (1 + g.rate), 2)), 0)
      into v_subtotal, v_tax
    from (
      select (line ->> 'tax_rate')::numeric as rate,
             sum((line ->> 'net_amount')::numeric) as gross
      from jsonb_array_elements(v_lines) as line
      group by 1
    ) g;
  else
    select coalesce(sum(g.net), 0),
           coalesce(sum(round(g.net * g.rate, 2)), 0)
      into v_subtotal, v_tax
    from (
      select (line ->> 'tax_rate')::numeric as rate,
             sum((line ->> 'net_amount')::numeric) as net
      from jsonb_array_elements(v_lines) as line
      group by 1
    ) g;
  end if;

  return jsonb_build_object(
    'currency',      v_store.currency,
    'channel',       v_channel.code,
    'tax_inclusive', v_inclusive,
    'quoted_at',     p_at,
    'lines',         v_lines,
    'subtotal',      v_subtotal::text,
    'tax_total',     v_tax::text,
    'grand_total',   (v_subtotal + v_tax)::text
  );
end;
$fn$;

revoke execute on function
  ebim.build_quote(uuid, uuid, jsonb, uuid, uuid, timestamptz, boolean)
from public, anon, authenticated;
grant execute on function
  ebim.build_quote(uuid, uuid, jsonb, uuid, uuid, timestamptz, boolean)
to service_role;

-- ---------------------------------------------------------------------------
-- public.price_quote_for_slug — lo que pide el carrito de la vitrina.
--
-- El comprador anonimo manda el slug de la URL y QUE quiere comprar. Todo lo
-- demas lo pone el servidor: la tienda (activa), el canal (el publico por
-- defecto, nunca uno que exija sesion) y el precio. Sin segmento y sin cliente:
-- un anonimo no es ninguno de los dos y no puede decir que lo es.
--
-- Es de solo lectura y no reserva nada, asi que no pasa por el limite de tasa
-- del checkout: cotizar es lo que hace el carrito cada vez que el comprador
-- cambia una cantidad.
-- ---------------------------------------------------------------------------
create or replace function public.price_quote_for_slug(
  p_store_slug text,
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
  v_slug    text := lower(btrim(coalesce(p_store_slug, '')));
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

  return ebim.build_quote(v_store.id, v_channel.id, p_items, null, null, now(), true);
end;
$fn$;

revoke execute on function public.price_quote_for_slug(text, jsonb) from public;
grant  execute on function public.price_quote_for_slug(text, jsonb)
  to anon, authenticated, service_role;

comment on function public.price_quote_for_slug(text, jsonb) is
  'Cotizacion del carrito publico: tienda por slug, canal publico por defecto, sin segmento ni cliente. El navegador solo dice QUE y CUANTO.';

-- ---------------------------------------------------------------------------
-- public.price_quote — el simulador del backoffice.
--
-- Responde "cuanto le costaria esto a un cliente de este segmento por este
-- canal", que es la unica forma de comprobar una precedencia antes de que la
-- descubra un comprador. `SECURITY DEFINER` con la autorizacion dentro: la
-- membresia se comprueba contra la tienda pedida ANTES de mirar un solo precio,
-- y el segmento tiene que ser de la misma sociedad.
-- ---------------------------------------------------------------------------
create or replace function public.price_quote(
  p_store_id    uuid,
  p_items       jsonb,
  p_channel_id  uuid        default null,
  p_segment_id  uuid        default null,
  p_customer_id uuid        default null,
  p_at          timestamptz default null
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

  return ebim.build_quote(
    v_store.id, v_channel.id, p_items, p_segment_id, p_customer_id,
    coalesce(p_at, now()), false
  );
end;
$fn$;

revoke execute on function
  public.price_quote(uuid, jsonb, uuid, uuid, uuid, timestamptz)
from public, anon;
grant execute on function
  public.price_quote(uuid, jsonb, uuid, uuid, uuid, timestamptz)
to authenticated, service_role;

comment on function public.price_quote(uuid, jsonb, uuid, uuid, uuid, timestamptz) is
  'Simulador de precio del backoffice: mismo motor que la vitrina y que el pedido, con canal, segmento, cliente y fecha explicitos.';

-- ---------------------------------------------------------------------------
-- public.price_list_conflicts — el diagnostico de administracion.
--
-- La precedencia tiene un desempate final por `id` de lista. Que exista evita
-- que el precio dependa del plan de ejecucion, pero un precio que se decide por
-- un uuid es un precio que nadie eligio: esta funcion denuncia esas
-- combinaciones ANTES de que un comprador las encuentre. Denuncia tambien las
-- tres formas de que una lista no sirva para nada y nadie se entere: moneda
-- distinta a la de la tienda, vigencia agotada y lista sin asignar.
--
-- `SECURITY INVOKER`: lee las tablas bajo la RLS de quien pregunta, asi que
-- preguntar por la tienda del vecino no devuelve filas por falta de permiso, no
-- por cortesia.
-- ---------------------------------------------------------------------------
create or replace function public.price_list_conflicts(p_store_id uuid)
returns table (
  kind             text,
  price_list_id    uuid,
  price_list_code  text,
  other_list_id    uuid,
  other_list_code  text,
  scope            text,
  detail           text
)
language sql
stable
set search_path = ''
as $fn$
  -- 1. Dos listas activas con el MISMO alcance, el mismo destino, la misma
  --    prioridad y vigencias que se solapan: el ganador lo decide el uuid.
  select
    'ambiguous_priority'::text,
    a.price_list_id, la.code,
    b.price_list_id, lb.code,
    a.scope::text,
    'Misma prioridad (' || la.priority || ') y vigencias solapadas en el mismo alcance'
  from public.price_list_assignments a
  join public.price_list_assignments b
    on b.store_id = a.store_id
   and b.scope    = a.scope
   and b.price_list_id > a.price_list_id
   and b.channel_id  is not distinct from a.channel_id
   and b.segment_id  is not distinct from a.segment_id
   and b.customer_id is not distinct from a.customer_id
   and b.is_active
  join public.price_lists la on la.id = a.price_list_id
  join public.price_lists lb on lb.id = b.price_list_id
  where a.store_id = p_store_id
    and a.is_active
    and la.is_active and lb.is_active
    and la.priority = lb.priority
    and la.currency = lb.currency
    and la.valid_from < coalesce(lb.valid_to, 'infinity'::timestamptz)
    and lb.valid_from < coalesce(la.valid_to, 'infinity'::timestamptz)

  union all

  -- 2. Lista en una moneda que la tienda no usa: no aplicara nunca.
  select 'currency_mismatch', pl.id, pl.code, null, null, null,
         'La lista esta en ' || pl.currency || ' y la tienda vende en ' || s.currency
  from public.price_lists pl
  join public.stores s on s.id = pl.store_id
  where pl.store_id = p_store_id
    and pl.is_active
    and pl.currency <> s.currency

  union all

  -- 3. Vigencia agotada y la lista sigue marcada activa.
  select 'expired', pl.id, pl.code, null, null, null,
         'Vigencia terminada el ' || to_char(pl.valid_to, 'YYYY-MM-DD')
  from public.price_lists pl
  where pl.store_id = p_store_id
    and pl.is_active
    and pl.valid_to is not null
    and pl.valid_to <= now()

  union all

  -- 4. Lista activa que no se aplica a nadie: precios que nadie vera.
  select 'unassigned', pl.id, pl.code, null, null, null,
         'La lista no esta asignada a ninguna tienda, canal, segmento ni cliente'
  from public.price_lists pl
  where pl.store_id = p_store_id
    and pl.is_active
    and not exists (
      select 1 from public.price_list_assignments a
      where a.price_list_id = pl.id and a.is_active
    )

  union all

  -- 5. Lista asignada y vacia: se aplica y no cambia nada, que es la forma mas
  --    silenciosa de creer que un acuerdo esta puesto cuando no lo esta.
  select 'empty', pl.id, pl.code, null, null, null,
         'La lista esta asignada y no tiene ningun precio cargado'
  from public.price_lists pl
  where pl.store_id = p_store_id
    and pl.is_active
    and exists (
      select 1 from public.price_list_assignments a
      where a.price_list_id = pl.id and a.is_active
    )
    and not exists (
      select 1 from public.price_list_items it where it.price_list_id = pl.id
    );
$fn$;

revoke execute on function public.price_list_conflicts(uuid) from public, anon;
grant  execute on function public.price_list_conflicts(uuid) to authenticated, service_role;

comment on function public.price_list_conflicts(uuid) is
  'Solapamientos ambiguos y listas que no pueden aplicarse. Invoker: la RLS decide que tiendas ve quien pregunta.';
