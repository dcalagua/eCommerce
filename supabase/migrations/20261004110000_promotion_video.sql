-- ===========================================================================
-- Video de fondo en las promociones (2026-10-04)
--
-- Una promoción puede llevar un VIDEO que se reproduce de fondo, mudo y en
-- bucle, detrás de su texto y su botón en la portada. La imagen de siempre
-- sigue siendo necesaria: es lo que se ve si el video no carga, si el
-- comprador pidió menos movimiento, o mientras llega.
--
-- Qué exige la base, aunque alguien se salte la pantalla:
--   · el video es un objeto de LA PROPIA tienda de la promoción:
--     {org}/{tienda}/content/video-<uuid>.mp4|.webm (nunca una URL externa);
--   · con video, hay imagen (el respaldo no es opcional).
-- Formato horizontal, 5 a 30 s y 15 MB los comprueba la pantalla antes de
-- subir: la base ve la ruta, no el archivo.
--
-- `promotions` concede el UPDATE por columna (20260908220000): la nueva entra
-- en la lista o el editor no podría guardarla. El INSERT es de tabla.
-- ===========================================================================

alter table public.promotions
  add column if not exists video_url text;

alter table public.promotions
  drop constraint if exists promotions_video_ref,
  drop constraint if exists promotions_video_needs_image;

alter table public.promotions
  add constraint promotions_video_ref
    check (
      video_url is null
      or video_url ~ (
        '^' || organization_id::text || '/' || store_id::text
        || '/content/video-[0-9a-f-]{36}\.(mp4|webm)$'
      )
    ),
  add constraint promotions_video_needs_image
    check (video_url is null or image_url is not null);

comment on column public.promotions.video_url is
  'Video de fondo de la campana (mudo, en bucle): ruta de la propia tienda en content/video-*.mp4|webm. Exige image_url como respaldo.';

grant update (video_url) on public.promotions to authenticated;

-- ---------------------------------------------------------------------------
-- La puerta pública lo devuelve (copia fiel de 20260902230000 + video_url).
-- ---------------------------------------------------------------------------
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
          pr.image_url,
          -- 2026-10-04 · video de fondo (la imagen queda de respaldo)
          pr.video_url,
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

-- ---------------------------------------------------------------------------
-- La vista del backoffice, con la foto y el video AL FINAL (`create or replace`
-- solo admite añadir columnas detrás y así conserva sus grants). La foto
-- faltaba desde 20260902230000: el editor abría cada campaña sin su imagen.
-- Copia fiel de 20260828130400 + las dos columnas.
-- ---------------------------------------------------------------------------
create or replace view public.promotion_overview
with (security_invoker = on) as
select
  p.id,
  p.organization_id,
  p.company_id,
  p.store_id,
  p.code,
  p.name,
  p.description,
  p.kind,
  p.status,
  case
    when p.status <> 'active'                              then p.status::text
    when p.valid_from > now()                              then 'scheduled'
    when p.valid_to is not null and p.valid_to <= now()    then 'expired'
    when p.usage_limit is not null
         and p.usage_count >= p.usage_limit                then 'exhausted'
    else 'live'
  end                                                      as effective_status,
  p.priority,
  p.stack_group,
  p.is_exclusive,
  p.requires_coupon,
  p.value_percent,
  p.value_amount,
  p.max_discount_amount,
  p.buy_quantity,
  p.free_quantity,
  p.min_subtotal,
  p.min_quantity,
  p.valid_from,
  p.valid_to,
  p.usage_limit,
  p.usage_limit_per_customer,
  p.usage_count,
  p.created_at,
  p.updated_at,
  (select count(*) from public.promotion_scopes s
    where s.promotion_id = p.id and not s.is_exclusion)      as scope_count,
  (select count(*) from public.promotion_scopes s
    where s.promotion_id = p.id and s.is_exclusion)          as exclusion_count,
  (select count(*) from public.promotion_audiences a
    where a.promotion_id = p.id)                             as audience_count,
  (select count(*) from public.promotion_tiers t
    where t.promotion_id = p.id)                             as tier_count,
  (select count(*) from public.coupons c
    where c.promotion_id = p.id)                             as coupon_count,
  (select count(*) from public.promotion_redemptions r
    where r.promotion_id = p.id)                             as redemption_count,
  -- Lo que esta campana le ha costado al comercio. Es la cifra que decide si se
  -- renueva, y sin ella la unica forma de saberlo es exportar los pedidos.
  (select coalesce(sum(r.discount_amount), 0)
     from public.promotion_redemptions r
    where r.promotion_id = p.id)                             as discount_granted,
  -- 2026-10-04 · la foto (faltaba: el editor no veía la que ya tenía) y el video
  p.image_url,
  p.video_url
from public.promotions p;
