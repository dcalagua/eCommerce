-- =============================================================================
-- Resumen v2 · Cada tema PROPONE su tipografia, y la tienda la puede cambiar.
--
-- Decision del operador (2026-09-26):
--
--   · El COLOR es de la tienda, siempre. Un tema solo cambia FORMAS (radios,
--     columnas, aire, cabecera, tarjeta) y propone una tipografia.
--   · La tipografia pasa de marca blanca a TEMATIZACION: cualquier tienda la
--     elige, como elige el acento, el radio o la densidad. Lo que sigue siendo
--     premium es lo que hace que la tienda deje de parecer de la suite: quitar
--     el lockup (`white_label`), la identidad del correo y el dominio propio.
--
-- ## Que cambia
--
--   1. La lista cerrada `store_settings_font` suma tres fuentes auto-alojadas
--      (`@fontsource`, viajan en el chunk de la vitrina; ninguna peticion a un
--      tercero): `archivo` (Retail), `fraunces` (Premium) y `plex` (Catalogo).
--      Sigue siendo una LISTA: nunca una URL ni una `@font-face` del tenant.
--   2. Las dos policies de escritura de `store_settings` dejan `font_family`
--      fuera de lo que exige `content.white_label`. Se reescriben con la forma
--      InitPlan de `20260923100000` (membresia una vez por consulta), que es la
--      que tienen hoy en la base tras aquella reescritura.
--   3. `ebim.reset_premium_branding` deja de poner `font_family` en nulo al
--      retirar el addon: ya no es premium, y borrarla seria castigar una baja
--      comercial con una perdida de configuracion.
--
-- `null` sigue significando «la que propone el tema»: el defecto vive en el
-- codigo de la vitrina (`THEME_FONTS`), no en la fila.
-- =============================================================================

alter table public.store_settings
  drop constraint if exists store_settings_font;

alter table public.store_settings
  add constraint store_settings_font
    check (font_family is null
           or font_family in ('dm-sans', 'plus-jakarta', 'system', 'grotesk', 'serif', 'mono',
                              'archivo', 'fraunces', 'plex'));

comment on constraint store_settings_font on public.store_settings is
  'Tipografia de una lista blanca (fuentes auto-alojadas o pilas del sistema). Nunca una URL: seria un recurso remoto elegido por el tenant en el dominio de la vitrina.';

-- ---------------------------------------------------------------------------
-- Policies de escritura: lo premium ya no incluye la tipografia.
--
-- El `using` del UPDATE sigue SIN pedir la capacidad, como desde P02: un
-- tenant al que se le retira el addon tiene que poder APAGAR lo que tenia.
-- ---------------------------------------------------------------------------
drop policy if exists store_settings_write_admin  on public.store_settings;
drop policy if exists store_settings_update_admin on public.store_settings;

create policy store_settings_write_admin on public.store_settings
  for insert to authenticated
  with check (
    (organization_id = (select ebim.org_id())
      and company_id = any ((select ebim.has_role_companies(array['owner','admin']::public.app_role[]))::uuid[]))
    and (
      not (
        white_label
        or email_from_name is not null
        or email_reply_to is not null
        or custom_domain_status <> 'none'
      )
      or ebim.has_capability(organization_id, company_id, 'content.white_label')
    )
  );

create policy store_settings_update_admin on public.store_settings
  for update to authenticated
  using (
    organization_id = (select ebim.org_id())
    and company_id = any ((select ebim.has_role_companies(array['owner','admin']::public.app_role[]))::uuid[])
  )
  with check (
    (organization_id = (select ebim.org_id())
      and company_id = any ((select ebim.has_role_companies(array['owner','admin']::public.app_role[]))::uuid[]))
    and (
      not (
        white_label
        or email_from_name is not null
        or email_reply_to is not null
        or custom_domain_status <> 'none'
      )
      or ebim.has_capability(organization_id, company_id, 'content.white_label')
    )
  );

-- ---------------------------------------------------------------------------
-- Retirar el addon apaga SOLO lo premium. La tipografia se conserva.
-- ---------------------------------------------------------------------------
create or replace function ebim.reset_premium_branding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org     uuid;
  v_company uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_company := old.company_id;
  else
    v_org := new.organization_id;
    v_company := new.company_id;
  end if;

  if ebim.company_is_entitled(v_org, v_company, 'content.white_label') then
    return null;
  end if;

  update public.store_settings
     set white_label            = false,
         email_from_name        = null,
         email_reply_to         = null,
         custom_domain_status   = 'none',
         custom_domain_verified_at = null,
         custom_domain_token    = null
   where organization_id = v_org
     and company_id      = v_company
     and (
       white_label
       or email_from_name is not null
       or email_reply_to is not null
       or custom_domain_status <> 'none'
     );

  return null;
end;
$fn$;

revoke execute on function ebim.reset_premium_branding() from public, anon, authenticated;

comment on function ebim.reset_premium_branding() is
  'Retirar content.white_label apaga su efecto persistido (marca blanca, correo, dominio). La tipografia es tematizacion desde 20260927100000 y se conserva.';
