-- =============================================================================
-- La campana publica QUE descuenta, no solo que existe.
--
-- Hasta aqui `resolve_content` resolvia la campana a un booleano y una fecha.
-- Con eso la vitrina podia decir «hay una promocion vigente» pero no «-20 %»,
-- que es justo el dato por el que alguien se para a mirar. Se anade la FORMA
-- del descuento —tipo, porcentaje, importe, el 3x2— y el minimo de compra.
--
-- Lo que SIGUE sin salir es el codigo del cupon. Esa era y es la linea: el
-- descuento de una campana automatica ya se ve en el precio, asi que anunciarlo
-- no regala nada; el codigo de una campana con cupon es el secreto entero.
-- =============================================================================
create or replace function ebim.resolve_content(
  p_page           public.content_pages,
  p_channel_id     uuid,
  p_segment_id     uuid,
  p_at             timestamptz,
  p_include_drafts boolean
)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'page', jsonb_build_object(
      'id',              p_page.id,
      'slug',            p_page.slug,
      'title',           p_page.title,
      'kind',            p_page.kind,
      'status',          p_page.status,
      'seo_title',       p_page.seo_title,
      'seo_description', p_page.seo_description,
      'og_image_url',    p_page.og_image_url,
      'publish_from',    p_page.publish_from,
      'publish_to',      p_page.publish_to
    ),
    'channel_id',  p_channel_id,
    'segment_id',  p_segment_id,
    'resolved_at', p_at,
    'draft',       (p_page.status <> 'published'),
    'blocks', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',         b.id,
          'type',       b.block_type,
          'position',   b.position,
          'title',      b.title,
          'subtitle',   b.subtitle,
          'body',       b.body,
          'media_url',  b.media_url,
          'media_alt',  b.media_alt,
          'cta_label',  b.cta_label,
          'cta_href',   b.cta_href,
          'settings',   b.settings,
          'is_active',  b.is_active,
          'category_id', b.category_id,
          'campaign', case
            when b.promotion_id is null then null
            else (
              select jsonb_build_object(
                'live', (
                  pr.status = 'active'
                  and pr.valid_from <= p_at
                  and (pr.valid_to is null or pr.valid_to > p_at)
                ),
                'ends_at', pr.valid_to,
                'kind', pr.kind::text,
                -- El porcentaje sale sin ceros de relleno: la vitrina pinta
                -- «-15 %», no «-15.0000 %», y redondear en el cliente obliga a
                -- cada consumidor a repetir la misma decision.
                'percent_off', pr.value_percent,
                'amount_off', pr.value_amount,
                'buy_quantity', pr.buy_quantity,
                'free_quantity', pr.free_quantity,
                -- Un «20 soles desde 150» sin el 150 es publicidad enganosa.
                'min_subtotal', pr.min_subtotal,
                -- Que hace falta un codigo SI se dice; cual es, no. Sin esto la
                -- tarjeta prometia un descuento que no se aplica solo.
                'needs_coupon', pr.requires_coupon
              )
              from public.promotions pr
              where pr.id = b.promotion_id
            )
          end,
          'items', ebim.content_block_items_json(b)
        )
        order by b.position, b.created_at, b.id
      )
      from public.content_blocks b
      where b.page_id = p_page.id
        and (p_include_drafts or b.is_active)
        and (
          p_include_drafts
          or (
            b.publish_from <= p_at
            and (b.publish_to is null or b.publish_to > p_at)
          )
        )
        and (b.channel_id is null or b.channel_id = p_channel_id)
        -- Segmentacion: un bloque SIN segmento es para todos; uno CON segmento
        -- solo para ese. El comprador anonimo no tiene segmento, asi que nunca
        -- ve los bloques segmentados — que es la respuesta correcta y no un
        -- efecto secundario.
        and (b.segment_id is null or b.segment_id = p_segment_id)
    ), '[]'::jsonb)
  );
$fn$;


comment on function ebim.resolve_content(public.content_pages, uuid, uuid, timestamptz, boolean) is
  'Pagina + bloques vigentes por canal, segmento e instante. La campana viaja con la FORMA de su descuento (nunca con el codigo del cupon).';
