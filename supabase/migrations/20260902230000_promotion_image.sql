-- =============================================================================
-- La campana puede tener FOTO.
--
-- Una oferta sin imagen es un cartel de texto: se lee, no se mira. En la
-- portada compite con tarjetas de producto que si tienen foto, y pierde — que
-- es lo contrario de lo que una promocion viene a hacer.
--
-- ## Por que aqui y no en el CMS
--
-- El bloque `campaign` del CMS ya admite `media_url`, pero eso obliga a que
-- alguien escriba un bloque por cada campana. Desde que la portada lee las
-- promociones vigentes SOLA, la imagen tiene que viajar con la campana: se
-- crea una oferta, se le pone su foto, y aparece. Sin segundo sitio donde
-- acordarse.
--
-- ## La misma regla que el logo y el banner
--
-- `ebim.is_store_asset_ref` decide que vale: una ruta del bucket de la PROPIA
-- tienda, o una URL externa `https://` sin espacios. Ni `http://` —el navegador
-- lo bloquea por contenido mixto y la vitrina se ve rota—, ni la ruta del
-- bucket de otro tenant, que es el ataque que esa funcion existe para impedir.
-- =============================================================================

alter table public.promotions
  add column if not exists image_url text;

alter table public.promotions
  drop constraint if exists promotions_image_len,
  drop constraint if exists promotions_image_ref;

alter table public.promotions
  add constraint promotions_image_len
    check (image_url is null or char_length(image_url) between 4 and 1024),
  add constraint promotions_image_ref
    check (ebim.is_store_asset_ref(image_url, organization_id, store_id));

comment on column public.promotions.image_url is
  'Foto de la campana: ruta del bucket de la propia tienda o URL https externa. Misma regla que el logo (ebim.is_store_asset_ref).';

-- ---------------------------------------------------------------------------
-- Y la puerta publica la devuelve: sin esto la foto existiria y no se veria.
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
  'Campanas VIGENTES y sin cupon de una tienda activa, con la forma de su descuento, su foto y a donde lleva. Nunca codigos de cupon ni cupos de uso.';
