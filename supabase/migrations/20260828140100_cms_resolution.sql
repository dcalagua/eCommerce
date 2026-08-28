-- =============================================================================
-- P11-SaaS · 2/5 — Resolucion de contenido: que ve QUIEN, POR DONDE y CUANDO.
--
-- Una tienda puede tener tres portadas a la vez —la de siempre, la de rebajas
-- que arranca el viernes y la del canal mayorista— y solo una es la buena para
-- este visitante en este instante. Aqui vive esa decision, y vive en la BASE por
-- dos motivos que no son de comodidad:
--
--  1. **El borrador no puede salir de aqui.** Si la vitrina leyera las tablas y
--     filtrara en el navegador, el borrador de la campana de Navidad viajaria
--     por la red en noviembre. Con la funcion definer, lo que no esta publicado
--     y vigente no se serializa.
--  2. **La misma respuesta para la vitrina y para la vista previa.** El editor
--     pregunta a `content_preview` con `p_at` y `p_channel_id` explicitos y la
--     vitrina a `store_page_for_slug`; las dos llaman a la MISMA
--     `ebim.resolve_content`. Una vista previa que se calcula aparte es una
--     vista previa que miente el dia que las dos se separan.
--
-- ## Orden TOTAL de resolucion (la misma tecnica que la precedencia de P04)
--
--   canal especifico > canal nulo  →  priority desc  →  publish_from desc  →  id
--
-- El ultimo desempate no es decorativo: sin el, dos paginas empatadas darian una
-- portada distinta segun el plan de ejecucion, y el comercio no tendria forma de
-- explicar por que su tienda cambia sola.
--
-- ## Degradacion, no fallo
--
-- Sin la capacidad `content.cms` la respuesta trae `cms: false` y CERO bloques;
-- no lanza. La vitrina cae a lo que pintaba antes de esta fase (hero de
-- `store_settings` + catalogo), que es exactamente lo que P04 hizo con el motor
-- de precios y P06 con el inventario: sin el addon el tenant vende igual que
-- ayer, no peor.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.content_pick_page — la pagina que gana.
--
-- `p_slug` manda: si viene, se busca esa pagina por slug. Si no viene, se busca
-- la MEJOR del tipo pedido (la portada). Son dos preguntas distintas y por eso
-- el `case` no esta dentro de un `coalesce`: pedir `/p/rebajas` cuando esa
-- pagina esta despublicada tiene que dar «no existe», no la portada.
-- ---------------------------------------------------------------------------
create or replace function ebim.content_pick_page(
  p_store_id       uuid,
  p_slug           text,
  p_kind           public.content_page_kind,
  p_channel_id     uuid,
  p_at             timestamptz,
  p_include_drafts boolean
)
returns public.content_pages
language sql
stable
set search_path = ''
as $fn$
  select p.*
  from public.content_pages p
  where p.store_id = p_store_id
    and (
      (p_slug is not null and p.slug = p_slug)
      or (p_slug is null and p.kind = p_kind)
    )
    and (
      p_include_drafts
      or (
        p.status = 'published'
        and p.publish_from <= p_at
        and (p.publish_to is null or p.publish_to > p_at)
      )
    )
    -- Una pagina sin canal vale para todos; una CON canal solo para el suyo.
    and (p.channel_id is null or p.channel_id = p_channel_id)
  order by (p.channel_id is not null) desc,
           p.priority desc,
           p.publish_from desc,
           p.id
  limit 1;
$fn$;

revoke execute on function ebim.content_pick_page(uuid, text, public.content_page_kind, uuid, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function ebim.content_pick_page(uuid, text, public.content_page_kind, uuid, timestamptz, boolean)
  to service_role;

comment on function ebim.content_pick_page(uuid, text, public.content_page_kind, uuid, timestamptz, boolean) is
  'La pagina que gana para (tienda, canal, instante) con orden TOTAL: canal especifico, priority, publish_from, id.';

-- ---------------------------------------------------------------------------
-- ebim.content_block_items_json — lo que la coleccion ENSENA, ya resuelto.
--
-- Dos origenes y una regla de precedencia entre ellos: si el bloque tiene items
-- escritos a mano, mandan (eso ES el merchandising: el comercio decide el orden
-- y el orden es la decision). Si no tiene ninguno pero declara categoria, la
-- coleccion se llena SOLA con lo publicado de esa categoria — que es lo que
-- hace que una tienda con mil SKUs no tenga que curar una lista a mano para
-- estrenar la portada.
--
-- En los dos casos se lee de `public_products` / `public_product_variants` /
-- `public_categories`, que son las vistas que ya filtran publicado + activo +
-- tienda activa. Ni una condicion de publicacion se reescribe aqui: una segunda
-- copia de «que es publico» se desincroniza el dia que cambie la primera.
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
      and pp.category_id = p_block.category_id
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

revoke execute on function ebim.content_block_items_json(public.content_blocks)
  from public, anon, authenticated;
grant execute on function ebim.content_block_items_json(public.content_blocks) to service_role;

-- ---------------------------------------------------------------------------
-- ebim.resolve_content — pagina + bloques vigentes, listos para pintar.
--
-- La campana del bloque `campaign` se resuelve a un BOOLEANO y una fecha, nunca
-- al cupon: enumerar los codigos activos de una tienda a un comprador anonimo
-- seria regalar el folleto de las campanas secretas — la misma decision que P10
-- tomo al no reportar las campanas que exigen cupon y no lo traen.
-- ---------------------------------------------------------------------------
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
                'ends_at', pr.valid_to
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

revoke execute on function ebim.resolve_content(public.content_pages, uuid, uuid, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function ebim.resolve_content(public.content_pages, uuid, uuid, timestamptz, boolean)
  to service_role;

comment on function ebim.resolve_content(public.content_pages, uuid, uuid, timestamptz, boolean) is
  'Pagina + bloques vigentes por canal, segmento e instante. Unica autoridad: la vitrina y la vista previa llaman a esta misma.';

-- =============================================================================
-- Las tres puertas. Cada una con su llamante y su autorizacion.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- public.store_page_for_slug — el comprador ANONIMO.
--
-- Tienda por slug (solo activa), canal publico (nunca uno que exija sesion), y
-- lo que devuelve ya esta filtrado por publicacion y vigencia. `p_page_slug`
-- nulo = la portada.
--
-- Sin la capacidad `content.cms`: `cms: false` y cero bloques. No lanza.
-- ---------------------------------------------------------------------------
create or replace function public.store_page_for_slug(
  p_store_slug   text,
  p_page_slug    text default null,
  p_channel_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store    public.stores%rowtype;
  v_channel  public.channels%rowtype;
  v_page     public.content_pages%rowtype;
  v_slug     text := lower(btrim(coalesce(p_store_slug, '')));
  v_page_sl  text := nullif(lower(btrim(coalesce(p_page_slug, ''))), '');
  v_at       timestamptz := now();
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

  -- El canal se pide por CODIGO, nunca por uuid: un uuid en la barra de
  -- direcciones tendria que validarse contra la tienda igualmente, y el codigo
  -- ademas es legible. Solo canales publicos: uno que exige sesion no se
  -- resuelve para `anon` ni aunque el codigo sea correcto.
  if p_channel_code is not null then
    select * into v_channel
    from public.channels c
    where c.store_id = v_store.id
      and c.code = lower(btrim(p_channel_code))
      and c.is_active
      and not c.requires_auth;
  else
    select * into v_channel
    from public.channels c
    where c.store_id = v_store.id and c.is_default and c.is_active and not c.requires_auth;
  end if;

  if not ebim.company_is_entitled(v_store.organization_id, v_store.company_id, 'content.cms') then
    return jsonb_build_object(
      'cms', false, 'store_id', v_store.id, 'channel_id', v_channel.id,
      'page', null, 'blocks', '[]'::jsonb, 'resolved_at', v_at
    );
  end if;

  v_page := ebim.content_pick_page(v_store.id, v_page_sl, 'home', v_channel.id, v_at, false);

  if v_page.id is null then
    return jsonb_build_object(
      'cms', true, 'store_id', v_store.id, 'channel_id', v_channel.id,
      'page', null, 'blocks', '[]'::jsonb, 'resolved_at', v_at
    );
  end if;

  return ebim.resolve_content(v_page, v_channel.id, null, v_at, false)
       || jsonb_build_object('cms', true, 'store_id', v_store.id);
end;
$fn$;

revoke execute on function public.store_page_for_slug(text, text, text) from public;
grant  execute on function public.store_page_for_slug(text, text, text)
  to anon, authenticated, service_role;

comment on function public.store_page_for_slug(text, text, text) is
  'Contenido publico de una tienda por slug. Solo publicado y vigente, solo canal publico. Sin content.cms devuelve cms:false y cero bloques.';

-- ---------------------------------------------------------------------------
-- public.store_navigation_for_slug — las paginas que se enlazan solas.
--
-- Existe porque una pagina que solo se alcanza escribiendo su URL es media
-- funcionalidad: el tenant la crea y nadie llega. `show_in_nav` es la decision
-- del comercio y esta es su unica consecuencia.
-- ---------------------------------------------------------------------------
create or replace function public.store_navigation_for_slug(
  p_store_slug   text,
  p_channel_code text default null
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
  v_at      timestamptz := now();
begin
  select * into v_store
  from public.stores s
  where lower(s.slug) = v_slug and s.status = 'active';

  if not found then
    return '[]'::jsonb;
  end if;

  if not ebim.company_is_entitled(v_store.organization_id, v_store.company_id, 'content.cms') then
    return '[]'::jsonb;
  end if;

  if p_channel_code is not null then
    select * into v_channel
    from public.channels c
    where c.store_id = v_store.id and c.code = lower(btrim(p_channel_code))
      and c.is_active and not c.requires_auth;
  else
    select * into v_channel
    from public.channels c
    where c.store_id = v_store.id and c.is_default and c.is_active and not c.requires_auth;
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object('slug', p.slug, 'title', p.title)
      order by p.nav_position, p.title
    )
    from public.content_pages p
    where p.store_id = v_store.id
      and p.show_in_nav
      and p.kind <> 'home'
      and p.status = 'published'
      and p.publish_from <= v_at
      and (p.publish_to is null or p.publish_to > v_at)
      and (p.channel_id is null or p.channel_id = v_channel.id)
  ), '[]'::jsonb);
end;
$fn$;

revoke execute on function public.store_navigation_for_slug(text, text) from public;
grant  execute on function public.store_navigation_for_slug(text, text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.content_preview — la vista previa del editor.
--
-- Llamante: el BACKOFFICE con sesion. Autorizacion DENTRO: `can_access` contra
-- el tenant de la propia fila de la pagina, que sale de la base y no del
-- navegador. Es la unica forma de ver un borrador, y por eso `anon` no puede
-- ejecutarla ni conociendo el uuid.
--
-- `p_at` explicito es lo que hace util la vista previa: «como se vera el 24 de
-- diciembre» se responde moviendo el reloj de la consulta, no publicando y
-- mirando.
-- ---------------------------------------------------------------------------
create or replace function public.content_preview(
  p_page_id        uuid,
  p_at             timestamptz default null,
  p_channel_id     uuid default null,
  p_segment_id     uuid default null,
  p_include_drafts boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_page    public.content_pages%rowtype;
  v_channel public.channels%rowtype;
  v_at      timestamptz := coalesce(p_at, now());
begin
  select * into v_page from public.content_pages p where p.id = p_page_id;

  if not found then
    raise exception 'CONTENIDO_NO_ENCONTRADO: la pagina no existe' using errcode = '22023';
  end if;

  if not ebim.can_access(v_page.organization_id, v_page.company_id) then
    raise exception 'SIN_PERMISO: la pagina no pertenece a esta sociedad' using errcode = '42501';
  end if;

  -- El canal declarado se valida contra la tienda de la pagina. Un canal de
  -- otra tienda no da error: se ignora y se cae al canal por defecto, porque la
  -- vista previa no es una superficie de escritura y fallar aqui solo dejaria
  -- al editor sin poder mirar.
  if p_channel_id is not null then
    select * into v_channel
    from public.channels c
    where c.id = p_channel_id and c.store_id = v_page.store_id and c.is_active;
  end if;

  if v_channel.id is null then
    select * into v_channel
    from public.channels c
    where c.store_id = v_page.store_id and c.is_default and c.is_active;
  end if;

  if p_segment_id is not null and not exists (
    select 1 from public.customer_segments s
    where s.id = p_segment_id
      and s.organization_id = v_page.organization_id
      and s.company_id = v_page.company_id
  ) then
    raise exception 'SEGMENTO_NO_ENCONTRADO: ese segmento no es de esta sociedad'
      using errcode = '22023';
  end if;

  return ebim.resolve_content(v_page, v_channel.id, p_segment_id, v_at, coalesce(p_include_drafts, true))
       || jsonb_build_object('cms', true, 'store_id', v_page.store_id, 'preview', true);
end;
$fn$;

revoke execute on function public.content_preview(uuid, timestamptz, uuid, uuid, boolean)
  from public, anon;
grant  execute on function public.content_preview(uuid, timestamptz, uuid, uuid, boolean)
  to authenticated, service_role;

comment on function public.content_preview(uuid, timestamptz, uuid, uuid, boolean) is
  'Vista previa del editor: misma resolucion que la vitrina pero con borradores, reloj y canal explicitos. Autoriza por can_access contra el tenant de la fila.';
