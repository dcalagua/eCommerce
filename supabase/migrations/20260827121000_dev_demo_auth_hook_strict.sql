-- =============================================================================
-- P09 · Correccion del Custom Access Token Hook de DEV/QAS.
--
-- La migracion 20260827120000 ya esta APLICADA en el proyecto DEV/QAS, asi que
-- es inmutable: la correccion viaja en una migracion nueva (regla del encargo).
--
-- Que corrige: la puerta del hook comparaba `v_meta ->> 'ebim_demo' = 'true'`.
-- El operador `->>` devuelve TEXTO, y el texto de un JSON string `"true"` es
-- tambien `true`, de modo que un `app_metadata.ebim_demo = "true"` (cadena)
-- abria la puerta igual que el booleano. El contrato de la funcion dice
-- `ebim_demo === true`, y eso es lo que debe cumplirse.
--
-- Impacto real hoy: ninguno conocido — `app_metadata` solo lo escribe el
-- servidor con `service_role` y el aprovisionamiento escribe el booleano. Pero
-- una puerta que acepta dos tipos distintos no es una puerta: se cierra.
--
-- Lo demas queda igual: sin SECURITY DEFINER, `search_path` fijo, y EXECUTE
-- solo para `supabase_auth_admin`.
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

  -- Puerta unica y ESTRICTA: solo el booleano JSON `true`. Una cadena "true",
  -- un 1 o un null salen por aqui con el evento intacto.
  if (v_meta -> 'ebim_demo') is distinct from to_jsonb(true) then
    return event;
  end if;

  v_claims := coalesce(event -> 'claims', '{}'::jsonb);

  v_org := ebim.safe_uuid(v_meta ->> 'org_id');
  if v_org is not null then
    v_claims := jsonb_set(v_claims, '{org_id}', to_jsonb(v_org::text));
  end if;

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
  'DEV/QAS DEMO AUTH (P09). Emite los claims EBIM solo si app_metadata.ebim_demo es el booleano true. Sustituir por la identidad del hub.';

-- `create or replace` conserva los permisos, pero se reafirman para que esta
-- migracion sea legible por si sola y no dependa de leer la anterior.
revoke execute on function ebim.demo_access_token_hook(jsonb)
  from public, anon, authenticated;

grant execute on function ebim.demo_access_token_hook(jsonb)
  to supabase_auth_admin;
