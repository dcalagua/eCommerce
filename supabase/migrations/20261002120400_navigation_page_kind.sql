-- =============================================================================
-- store_navigation_for_slug devuelve también el TIPO de página (landing|legal).
--
-- El pie agrupa las páginas como lo hace una tienda real: «Empresa» (landing)
-- y «Legales» (legal). Cambio ADITIVO: quien no lee `kind` sigue igual. El
-- resto de la función es copia fiel de 20260828140100.
-- =============================================================================
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
      jsonb_build_object('slug', p.slug, 'title', p.title, 'kind', p.kind)
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
