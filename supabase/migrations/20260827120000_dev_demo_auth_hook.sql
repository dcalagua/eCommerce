-- =============================================================================
-- P09 · DEV/QAS DEMO AUTH — Custom Access Token Hook de Supabase.
--
-- NO ES ARQUITECTURA DEFINITIVA. La identidad de eCommerce la emite el hub EBIM
-- (Third-Party Auth contra su JWKS, contrato §2.2). Mientras el hub no este
-- disponible, este hook permite que un usuario de DEMO de Supabase Auth lleve en
-- su access token los MISMOS claims que emitiria el hub, para poder ejercitar la
-- RLS real sin debilitarla.
--
-- Lo que este archivo NO hace, a proposito:
--   · no toca `ebim.org_id()`, `ebim.companies()`, `ebim.can_access()` ni
--     ninguna policy: el contrato de autorizacion queda intacto;
--   · no da acceso a nada por si mismo — sin membresia activa en
--     `tenant_members`, `ebim.can_access` sigue devolviendo false;
--   · no es SECURITY DEFINER: lee `app_metadata` del propio evento que le pasa
--     el servidor de auth, no consulta ninguna tabla;
--   · no altera el evento de NINGUN usuario que no lleve `ebim_demo = true`.
--
-- `app_metadata` solo lo escribe el servidor (Admin API con service_role): un
-- usuario NO puede darselo a si mismo desde el navegador.
--
-- Retirada: cuando entre la identidad del hub, `drop function` + desactivar el
-- hook en la configuracion de auth.
-- =============================================================================

create or replace function ebim.demo_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $hook$
declare
  v_meta      jsonb;
  v_claims    jsonb;
  v_org       uuid;
  v_companies jsonb;
  v_active    uuid;
  v_apps      jsonb;
begin
  v_meta := coalesce(event -> 'claims' -> 'app_metadata', '{}'::jsonb);

  -- Puerta unica: cualquier otro usuario sale por aqui con el evento intacto.
  if coalesce(v_meta ->> 'ebim_demo', 'false') <> 'true' then
    return event;
  end if;

  v_claims := coalesce(event -> 'claims', '{}'::jsonb);

  -- org_id: solo si es un uuid de verdad. Un valor basura no se propaga.
  v_org := ebim.safe_uuid(v_meta ->> 'org_id');
  if v_org is not null then
    v_claims := jsonb_set(v_claims, '{org_id}', to_jsonb(v_org::text));
  end if;

  -- companies[]: se copia solo si es un array. `ebim.companies()` ya admite
  -- tanto [{id, role}] como ["uuid"], asi que no se reescribe la forma aqui.
  v_companies := v_meta -> 'companies';
  if jsonb_typeof(v_companies) = 'array' then
    v_claims := jsonb_set(v_claims, '{companies}', v_companies);
  end if;

  v_active := ebim.safe_uuid(v_meta ->> 'active_company');
  if v_active is not null then
    v_claims := jsonb_set(v_claims, '{active_company}', to_jsonb(v_active::text));
  end if;

  v_apps := v_meta -> 'apps';
  if jsonb_typeof(v_apps) = 'array' then
    v_claims := jsonb_set(v_claims, '{apps}', v_apps);
  end if;

  return jsonb_set(event, '{claims}', v_claims);
end;
$hook$;

comment on function ebim.demo_access_token_hook(jsonb) is
  'DEV/QAS DEMO AUTH (P09). Emite los claims EBIM para usuarios con app_metadata.ebim_demo = true. Sustituir por la identidad del hub.';

-- ---------------------------------------------------------------------------
-- Permisos: SOLO el servidor de auth lo ejecuta.
-- Que `authenticated` pudiera llamarlo no daria acceso a datos, pero tampoco
-- tiene ningun motivo para hacerlo: default deny tambien aqui.
-- ---------------------------------------------------------------------------
grant usage on schema ebim to supabase_auth_admin;

revoke execute on function ebim.demo_access_token_hook(jsonb)
  from public, anon, authenticated;

grant execute on function ebim.demo_access_token_hook(jsonb)
  to supabase_auth_admin;

-- El hook llama a `ebim.safe_uuid` y no es SECURITY DEFINER: el permiso lo
-- necesita el llamador real, que es `supabase_auth_admin`.
grant execute on function ebim.safe_uuid(text) to supabase_auth_admin;
