-- =============================================================================
-- Las promociones vigentes, para el comprador ANONIMO.
--
-- Hasta aqui la vitrina solo sabia de una campana si alguien le habia escrito
-- un bloque de contenido a mano. Con siete campanas activas en el backoffice y
-- un solo bloque publicado, la tienda descontaba en el carrito sin haberlo
-- anunciado en ningun sitio: seis ofertas invisibles y un comprador que nunca
-- supo que existian.
--
-- Esto lo convierte en DATO: la portada lee lo que esta descontando ahora, sin
-- que nadie mantenga una copia a mano que se queda vieja el dia que la campana
-- caduca.
--
-- Una FUNCION y no una vista, a proposito: `promotions` no tiene —ni va a
-- tener— politica de lectura para `anon`, y abrirsela para pintar un carrusel
-- seria pagar con la tabla entera lo que aqui se resuelve con seis columnas.
-- La tienda se resuelve por slug dentro, como en las otras tres puertas
-- publicas (`store_page_for_slug`, `catalog_search_for_slug`,
-- `store_navigation_for_slug`).
--
-- Lo que NO sale, y es la parte que importa:
--
--  · las campanas que EXIGEN cupon. Anunciar «10 % de bienvenida» a quien no
--    tiene el codigo es prometer un descuento que no se aplica solo, y el
--    codigo no puede viajar: enumerar los cupones activos de una tienda a un
--    desconocido es regalar el folleto de las campanas secretas (P10);
--  · los limites de uso ni cuantas veces se ha usado: cuanto le queda de cupo a
--    una promocion es informacion del comercio, no del escaparate;
--  · las campanas en borrador, las caducadas y las que aun no empiezan.
-- =============================================================================

create or replace function public.store_promotions_for_slug(
  p_store_slug text,
  p_limit      integer default 8
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_slug  text := lower(btrim(coalesce(p_store_slug, '')));
  v_at    timestamptz := now();
  v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 24);
begin
  if v_slug = '' then
    raise exception 'TIENDA_NO_DISPONIBLE: falta la tienda' using errcode = '22023';
  end if;

  select * into v_store
  from public.stores s
  where lower(s.slug) = v_slug and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'store_id',    v_store.id,
    'resolved_at', v_at,
    'promotions', coalesce((
      select jsonb_agg(p order by p.priority desc, p.ends_at nulls last, p.name)
      from (
        select
          pr.id,
          pr.name,
          pr.description,
          pr.kind::text                        as kind,
          pr.value_percent                     as percent_off,
          pr.value_amount                      as amount_off,
          pr.buy_quantity,
          pr.free_quantity,
          pr.min_subtotal,
          pr.valid_to                          as ends_at,
          pr.priority,
          -- A donde lleva el boton. Una promocion de categoria o de marca sabe
          -- ensenar SUS productos; una de «todo el pedido» no tiene a donde
          -- llevar mas que al catalogo, y eso lo decide la vitrina.
          (
            select c.slug
            from public.promotion_scopes s
            join public.categories c on c.id = s.category_id
            where s.promotion_id = pr.id
              and s.scope_kind = 'category'
              and not s.is_exclusion
            order by c.name
            limit 1
          ) as category_slug,
          (
            select b.code
            from public.promotion_scopes s
            join public.brands b on b.id = s.brand_id
            where s.promotion_id = pr.id
              and s.scope_kind = 'brand'
              and not s.is_exclusion
            order by b.name
            limit 1
          ) as brand_code
        from public.promotions pr
        where pr.store_id = v_store.id
          and pr.status = 'active'
          and pr.valid_from <= v_at
          and (pr.valid_to is null or pr.valid_to > v_at)
          -- Sin cupon: lo que se anuncia en la portada tiene que aplicarse solo.
          and not pr.requires_coupon
        order by pr.priority desc, pr.valid_to nulls last, pr.name
        limit v_limit
      ) as p
    ), '[]'::jsonb)
  );
end;
$fn$;

revoke execute on function public.store_promotions_for_slug(text, integer) from public;
grant execute on function public.store_promotions_for_slug(text, integer) to anon, authenticated;

comment on function public.store_promotions_for_slug(text, integer) is
  'Campanas VIGENTES y sin cupon de una tienda activa, con la forma de su descuento y a donde lleva. Nunca codigos de cupon ni cupos de uso.';
