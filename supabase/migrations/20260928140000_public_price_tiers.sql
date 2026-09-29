-- ---------------------------------------------------------------------------
-- Vitrina · Precio por volumen en la ficha (lámina 31)
--
-- La ficha no podía enseñar las escalas por cantidad: `public_products` da el
-- precio de UNA unidad y las escalas solo se resolvían en el carrito, cuando ya
-- se sabe cuántas unidades van. Quien compra para un hotel quiere saber ANTES
-- de añadir que a partir de 10 unidades paga menos.
--
-- Esta función devuelve las escalas PÚBLICAS de un producto con la MISMA regla
-- que usa el carrito para un comprador anónimo (ver
-- 20260917160000_product_master_pricing_promotions.sql, CTE `best`):
--
--   · listas activas de la tienda con alcance `store` o del canal por defecto
--     público (sin autenticación) — las de segmento y cliente NO, porque son
--     precios privados de un comprador concreto;
--   · para cada cantidad, la lista de más rango y prioridad que tenga algún
--     renglón aplicable, y dentro de ella el renglón de mayor `min_quantity`
--     que no supere la cantidad;
--   · sin renglón aplicable, el precio de catálogo de la publicación.
--
-- Solo renglones sin variante y sin presentación: la ficha anuncia escalas del
-- producto en unidades base. Con variantes la ficha no las pinta.
--
-- Devuelve únicamente las escalas que BAJAN el precio respecto de la anterior:
-- una escala que repite el precio no es una escala, es ruido.
-- ---------------------------------------------------------------------------

create or replace function ebim.public_price_tiers(p_store_id uuid, p_product_id uuid)
returns table (min_quantity numeric, unit_price numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with pub as (
    -- La publicación: si no está publicada en una tienda activa, no hay nada.
    select sp.store_id, sp.product_id, sp.currency, sp.price
    from public.store_products sp
    join public.stores s
      on s.id = sp.store_id
     and s.status = 'active'
    where sp.store_id = p_store_id
      and sp.product_id = p_product_id
      and sp.status = 'published'
      and sp.published_at is not null
      and sp.published_at <= now()
  ),
  cand as (
    select
      it.id,
      it.min_quantity,
      it.unit_price,
      l.scope_rank,
      l.priority,
      l.valid_from,
      l.price_list_id
    from pub
    join ebim.active_price_lists l
      on l.store_id = pub.store_id
     and l.currency = pub.currency
     and l.valid_from <= now()
     and (l.valid_to is null or l.valid_to > now())
     and (
          l.scope = 'store'
       or (l.scope = 'channel' and exists (
            select 1
            from public.channels c
            where c.id = l.channel_id
              and c.store_id = pub.store_id
              and c.is_default
              and c.is_active
              and not c.requires_auth))
     )
    join public.price_list_items it
      on it.price_list_id = l.price_list_id
     and it.product_id    = pub.product_id
     and it.variant_id is null
     and it.uom_id is null
  ),
  umbrales as (
    select 1::numeric as q
    union
    select c.min_quantity from cand c where c.min_quantity > 1
  ),
  resueltos as (
    select
      u.q,
      coalesce(
        (
          select c.unit_price
          from cand c
          where c.min_quantity <= u.q
          order by c.scope_rank desc, c.priority desc, c.valid_from desc, c.price_list_id,
                   c.min_quantity desc, c.id
          limit 1
        ),
        (select pub.price from pub)
      ) as precio
    from umbrales u
    where exists (select 1 from pub)
  ),
  con_anterior as (
    select r.q, r.precio, lag(r.precio) over (order by r.q) as anterior
    from resueltos r
  )
  select ca.q as min_quantity, ca.precio as unit_price
  from con_anterior ca
  where ca.anterior is null or ca.precio < ca.anterior
  order by ca.q
$$;

revoke all on function ebim.public_price_tiers(uuid, uuid) from public;
grant execute on function ebim.public_price_tiers(uuid, uuid) to anon, authenticated, service_role;

-- La puerta pública, por slug, como el resto de la vitrina: el tenant sale de
-- la tienda ACTIVA con ese slug, nunca de un id que mande el cliente.
create or replace function public.product_price_tiers_for_slug(p_store_slug text, p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_store public.stores%rowtype;
  v_slug  text := lower(btrim(coalesce(p_store_slug, '')));
  v_tiers jsonb;
begin
  select * into v_store
  from public.stores s
  where lower(s.slug) = v_slug and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'min_quantity', t.min_quantity::text,
               'unit_price',   t.unit_price::text
             ) order by t.min_quantity
           ),
           '[]'::jsonb
         )
    into v_tiers
  from ebim.public_price_tiers(v_store.id, p_product_id) t;

  -- Los importes viajan como TEXTO: un número de JSON es un double y un double
  -- no es un importe (regla del repositorio desde P02).
  return jsonb_build_object('currency', v_store.currency, 'tiers', v_tiers);
end;
$$;

revoke execute on function public.product_price_tiers_for_slug(text, uuid) from public;
grant  execute on function public.product_price_tiers_for_slug(text, uuid) to anon, authenticated, service_role;
