-- =============================================================================
-- P02 · 03/08 — `stores` y `store_settings`.
-- Una tienda pertenece a una SOCIEDAD (`company_id`) dentro de una cuenta
-- (`organization_id`). El storefront público resuelve la tienda por `slug` o
-- por `domain`, nunca por un identificador que declare el cliente.
-- =============================================================================

create type public.store_status as enum ('draft', 'active', 'suspended');

create table public.stores (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.tenants (organization_id) on delete cascade,
  company_id      uuid        not null,
  slug            text        not null,
  name            text        not null,
  status          public.store_status not null default 'draft',
  currency        char(3)     not null default 'PEN',
  domain          text,
  order_seq       bigint      not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint stores_slug_format  check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$'),
  constraint stores_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint stores_domain_fmt   check (domain is null or domain ~ '^[a-z0-9.-]{4,253}$'),
  constraint stores_name_len     check (char_length(btrim(name)) between 1 and 200),
  -- Claves compuestas: permiten que las tablas hijas amarren su tenant al de la
  -- tienda por FK, en vez de confiar en que alguien copie bien los uuid.
  constraint stores_tenant_key unique (id, organization_id, company_id)
);

-- El slug es la URL pública (`/s/:storeSlug`): único en todo el proyecto.
create unique index stores_slug_key    on public.stores (lower(slug));
create unique index stores_domain_key  on public.stores (lower(domain)) where domain is not null;
create index        stores_tenant_idx  on public.stores (organization_id, company_id);
create index        stores_status_idx  on public.stores (status) where status = 'active';

create trigger stores_set_updated_at
  before update on public.stores
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- store_settings — 1:1 con la tienda. Separa lo publicable (branding) de lo
-- interno (`config`, `tax_rate`): el GRANT por columna es lo que decide qué ve
-- un comprador anónimo, porque RLS filtra filas, no columnas.
-- ---------------------------------------------------------------------------
create table public.store_settings (
  store_id        uuid        primary key references public.stores (id) on delete cascade,
  organization_id uuid        not null,
  company_id      uuid        not null,
  -- Nombres del contrato §4.3 (interfaz homologada de branding de suite):
  -- `accent_color`, `logo_url`, `white_label`. No inventar variantes.
  accent_color    text        not null default '#5AA97F',
  logo_url        text,
  favicon_url     text,
  white_label     boolean     not null default false,
  default_locale  text        not null default 'es',
  support_email   text,
  tax_rate        numeric(6,4) not null default 0.1800,
  config          jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint store_settings_accent  check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint store_settings_locale  check (default_locale in ('es', 'en')),
  constraint store_settings_tax     check (tax_rate >= 0 and tax_rate <= 1),
  constraint store_settings_support check (support_email is null or position('@' in support_email) > 1),
  constraint store_settings_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);
create index store_settings_tenant_idx on public.store_settings (organization_id, company_id);

create trigger store_settings_set_updated_at
  before update on public.store_settings
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.stores         enable row level security;
alter table public.stores         force  row level security;
alter table public.store_settings enable row level security;
alter table public.store_settings force  row level security;

revoke all on public.stores         from public, anon, authenticated;
revoke all on public.store_settings from public, anon, authenticated;

grant select, insert, update, delete on public.stores         to authenticated;
grant select, insert, update, delete on public.store_settings to authenticated;

-- Lectura anónima: SOLO columnas publicables. `order_seq`, `organization_id`
-- y `company_id` no salen al storefront.
grant select (id, slug, name, status, currency, domain)  on public.stores         to anon;
grant select (store_id, accent_color, logo_url, favicon_url, white_label,
              default_locale, support_email)              on public.store_settings to anon;

grant all on public.stores, public.store_settings to service_role;

create policy stores_select_member on public.stores
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy stores_write_admin on public.stores
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy stores_update_admin on public.stores
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy stores_delete_owner on public.stores
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner']::public.app_role[]));

-- Comprador anónimo: solo tiendas activas.
create policy stores_select_public on public.stores
  for select to anon
  using (status = 'active');

create policy store_settings_select_member on public.store_settings
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy store_settings_write_admin on public.store_settings
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy store_settings_update_admin on public.store_settings
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy store_settings_select_public on public.store_settings
  for select to anon
  using (
    exists (
      select 1 from public.stores s
      where s.id = store_settings.store_id
        and s.status = 'active'
    )
  );

comment on column public.stores.order_seq is
  'Contador transaccional de numero de pedido por tienda. Nunca expuesto al storefront.';
comment on column public.store_settings.tax_rate is
  'Tasa aplicada server-side en create-order. No se expone a anon: el total lo calcula el servidor.';
