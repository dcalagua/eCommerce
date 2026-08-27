-- =============================================================================
-- P02 · 02/08 — `tenants` (espejo local del hub) y `tenant_members`.
-- Toda tabla nace con RLS + policies en la MISMA migración (regla del repo).
-- =============================================================================

create type public.tenant_status  as enum ('active', 'suspended', 'closed');
create type public.member_status  as enum ('active', 'invited', 'revoked');

-- Roles de aplicación de eCommerce. Dimensión propia de la app (patrón §2.5:
-- el `role` del hub gobierna la identidad; el rol funcional es de cada app).
create type public.app_role as enum ('owner', 'admin', 'catalog', 'orders', 'viewer');

-- ---------------------------------------------------------------------------
-- tenants — la PK es el `organization_id` del hub: no se inventa un id local.
-- ---------------------------------------------------------------------------
create table public.tenants (
  organization_id uuid        primary key,
  slug            text        not null,
  name            text        not null,
  admin_email     text        not null,          -- contrato §3.2: obligatorio
  status          public.tenant_status not null default 'active',
  settings        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint tenants_slug_format  check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$'),
  constraint tenants_admin_email  check (position('@' in admin_email) > 1),
  constraint tenants_name_len     check (char_length(btrim(name)) between 1 and 200)
);
create unique index tenants_slug_key on public.tenants (lower(slug));
create index tenants_status_idx on public.tenants (status);

create trigger tenants_set_updated_at
  before update on public.tenants
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_members — membresía usuario ↔ (organización, sociedad) + rol de app.
-- ---------------------------------------------------------------------------
create table public.tenant_members (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.tenants (organization_id) on delete cascade,
  company_id      uuid        not null,
  user_id         uuid        not null,          -- `sub` del JWT del hub
  email           text        not null,
  role            public.app_role      not null default 'viewer',
  status          public.member_status not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint tenant_members_email  check (position('@' in email) > 1),
  constraint tenant_members_unique unique (organization_id, company_id, user_id)
);
create index tenant_members_user_idx   on public.tenant_members (user_id, status);
create index tenant_members_tenant_idx on public.tenant_members (organization_id, company_id);
create index tenant_members_email_idx  on public.tenant_members (lower(email));

create trigger tenant_members_set_updated_at
  before update on public.tenant_members
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- Núcleo de autorización. SECURITY DEFINER por dos motivos:
--   1. evita la recursión RLS (las policies de negocio leen tenant_members);
--   2. la autorización es explícita DENTRO de la función: solo responde sobre
--      `ebim.user_id()` — el llamador no puede preguntar por otro usuario.
-- REVOKE a public/anon: solo `authenticated` y el servidor las ejecutan
-- (lección esupplier-030).
-- ---------------------------------------------------------------------------
create or replace function ebim.member_role(p_organization_id uuid, p_company_id uuid)
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $fn$
  select m.role
  from public.tenant_members m
  join public.tenants t on t.organization_id = m.organization_id
  where m.organization_id = p_organization_id
    and m.company_id      = p_company_id
    and m.user_id         = ebim.user_id()
    and m.status          = 'active'
    and t.status          = 'active'
  limit 1;
$fn$;

-- Predicado único de aislamiento. Exige LAS DOS cosas:
--   - claims del JWT (org_id + companies[]) — contrato §3;
--   - membresía activa en este proyecto — requisito del operador (P02).
-- Un JWT con `org_id` de otro tenant y sin membresía no ve absolutamente nada.
create or replace function ebim.can_access(p_organization_id uuid, p_company_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select p_organization_id is not null
     and p_company_id      is not null
     and ebim.user_id()    is not null
     and p_organization_id = ebim.org_id()
     and p_company_id      = any (ebim.companies())
     and ebim.member_role(p_organization_id, p_company_id) is not null;
$fn$;

-- ¿El rol de la membresía está en la lista que pide la policy?
create or replace function ebim.has_role(
  p_organization_id uuid,
  p_company_id uuid,
  p_roles public.app_role[]
)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select ebim.can_access(p_organization_id, p_company_id)
     and ebim.member_role(p_organization_id, p_company_id) = any (p_roles);
$fn$;

revoke execute on function
  ebim.member_role(uuid, uuid),
  ebim.can_access(uuid, uuid),
  ebim.has_role(uuid, uuid, public.app_role[])
from public, anon;

grant execute on function
  ebim.member_role(uuid, uuid),
  ebim.can_access(uuid, uuid),
  ebim.has_role(uuid, uuid, public.app_role[])
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS · default deny. Sin policy no hay acceso; `force` alcanza también al owner.
-- ---------------------------------------------------------------------------
alter table public.tenants        enable row level security;
alter table public.tenants        force  row level security;
alter table public.tenant_members enable row level security;
alter table public.tenant_members force  row level security;

revoke all on public.tenants        from public, anon, authenticated;
revoke all on public.tenant_members from public, anon, authenticated;

-- `tenants` es dato interno: el storefront público NO lo consulta.
-- El GRANT por columna impide que un PATCH directo toque `status`/`slug`/
-- `admin_email` aunque la fila sea legítimamente suya (aviso lateral de §3.2:
-- RLS decide qué filas, nunca qué columnas).
grant select                         on public.tenants        to authenticated;
grant update (name, settings)        on public.tenants        to authenticated;
grant select, insert, update, delete on public.tenant_members to authenticated;

-- El servidor (Edge Functions) necesita el GRANT explicito: el `revoke ... from
-- public` de arriba tambien le quita el privilegio implicito, y `bypassrls` salta
-- la RLS pero no los permisos de tabla.
grant all on public.tenants, public.tenant_members to service_role;

-- El alta de tenant es transaccional y vive en una función del servidor
-- (ver 20260827090700). Por eso no hay policy de INSERT/DELETE sobre `tenants`.
create policy tenants_select_member on public.tenants
  for select to authenticated
  using (
    tenants.organization_id = ebim.org_id()
    and exists (
      select 1 from public.tenant_members m
      where m.organization_id = tenants.organization_id
        and m.user_id    = ebim.user_id()
        and m.status     = 'active'
        and m.company_id = any (ebim.companies())
    )
  );

create policy tenants_update_admin on public.tenants
  for update to authenticated
  using (
    ebim.has_role(tenants.organization_id, ebim.active_company(),
                  array['owner','admin']::public.app_role[])
  )
  with check (tenants.organization_id = ebim.org_id());

create policy tenant_members_select on public.tenant_members
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- `owner` no se otorga ni se revoca desde la app: nace con el tenant
-- (contrato §3.2) y cambiarlo es una operación de servidor.
create policy tenant_members_insert_admin on public.tenant_members
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and role <> 'owner'
  );

create policy tenant_members_update_admin on public.tenant_members
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and role <> 'owner'
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and role <> 'owner'
  );

create policy tenant_members_delete_admin on public.tenant_members
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and role    <> 'owner'
    and user_id <> ebim.user_id()
  );

comment on table  public.tenants is
  'Espejo local del tenant del hub. La PK es el organization_id del hub (contrato §3).';
comment on column public.tenants.admin_email is
  'Administrador de la empresa. Obligatorio por contrato §3.2: sin correo no hay alta.';
comment on table  public.tenant_members is
  'Membresia + rol funcional de eCommerce. La identidad la emite el hub; el rol es de la app.';
