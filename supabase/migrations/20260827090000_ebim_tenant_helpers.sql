-- =============================================================================
-- P02 · Fundación multitenant de eCommerce by EBIM
-- 01/08 — Esquema `ebim`: derivación de tenant desde el JWT del hub.
--
-- Contrato EBIM §2.2 (claims) y §3 (jerarquía organization → company → datos).
-- El tenant SIEMPRE sale del JWT. Ninguna función de este archivo acepta un
-- identificador de tenant declarado por el cliente.
--
-- Nota de nomenclatura: lo que otras apps llaman "tenant_id" aquí es
-- `organization_id` (uuid del hub), nombre exacto exigido por el contrato §3
-- («nombres exactos, sin variantes»). `tenants` es la tabla espejo local del
-- tenant, patrón admitido por el contrato §3.2 para apps con tabla propia.
-- =============================================================================

create schema if not exists ebim;
revoke all on schema ebim from public;
grant usage on schema ebim to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cast defensivo: un claim manipulado no puede tumbar una policy con un error
-- de cast. Texto que no es uuid → NULL → la policy deniega.
-- ---------------------------------------------------------------------------
create or replace function ebim.safe_uuid(p_value text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then p_value::uuid
  end;
$$;

create or replace function ebim.claims()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt(), '{}'::jsonb);
$$;

/** `sub` del JWT: id global del usuario EBIM. */
create or replace function ebim.user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select ebim.safe_uuid(ebim.claims() ->> 'sub');
$$;

create or replace function ebim.email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(nullif(ebim.claims() ->> 'email', ''));
$$;

/** `org_id` del JWT = cuenta/tenant. Nunca del body, header, query ni URL. */
create or replace function ebim.org_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select ebim.safe_uuid(ebim.claims() ->> 'org_id');
$$;

/**
 * `companies[]` del JWT. Acepta la forma del contrato (`[{id, role}]`) y la
 * forma degradada (`["uuid"]`) sin romperse ante claims inesperados.
 */
create or replace function ebim.companies()
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(
    array(
      select ebim.safe_uuid(coalesce(item ->> 'id', item #>> '{}'))
      from jsonb_array_elements(
        case when jsonb_typeof(ebim.claims() -> 'companies') = 'array'
             then ebim.claims() -> 'companies'
             else '[]'::jsonb end
      ) as item
      where ebim.safe_uuid(coalesce(item ->> 'id', item #>> '{}')) is not null
    ),
    '{}'::uuid[]
  );
$$;

create or replace function ebim.active_company()
returns uuid
language sql
stable
set search_path = ''
as $$
  select ebim.safe_uuid(ebim.claims() ->> 'active_company');
$$;

/** Super Admin ÚNICO de suite (contrato §13). No es actor de negocio del tenant. */
create or replace function ebim.is_suite_super_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select ebim.email() = 'dcalagua@ebim.pe';
$$;

-- ---------------------------------------------------------------------------
-- Trigger genérico de updated_at
-- ---------------------------------------------------------------------------
create or replace function ebim.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function
  ebim.safe_uuid(text), ebim.claims(), ebim.user_id(), ebim.email(),
  ebim.org_id(), ebim.companies(), ebim.active_company(),
  ebim.is_suite_super_admin(), ebim.set_updated_at()
from public;

-- `safe_uuid` entra en la lista: las demas la llaman y NO son SECURITY DEFINER,
-- asi que el permiso lo necesita el llamador. Sin esto, toda policy que derive
-- el tenant del JWT falla con "permission denied for function safe_uuid".
grant execute on function
  ebim.safe_uuid(text), ebim.claims(), ebim.user_id(), ebim.email(),
  ebim.org_id(), ebim.companies(), ebim.active_company(),
  ebim.is_suite_super_admin()
to anon, authenticated, service_role;
