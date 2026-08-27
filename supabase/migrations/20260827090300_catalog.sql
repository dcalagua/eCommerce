-- =============================================================================
-- P02 · 04/08 — Catálogo: `categories`, `products`, `product_images`.
-- Dinero SIEMPRE `numeric`: nunca float/real/double (redondeo binario = céntimos
-- que no cuadran en una factura).
-- =============================================================================

create type public.product_status as enum ('draft', 'published', 'archived');

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
create table public.categories (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  parent_id       uuid,
  slug            text        not null,
  name            text        not null,
  position        integer     not null default 0,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint categories_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,80}$'),
  constraint categories_name_len    check (char_length(btrim(name)) between 1 and 160),
  constraint categories_not_self    check (parent_id is null or parent_id <> id),
  constraint categories_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint categories_store_key unique (id, store_id),
  constraint categories_tenant_key unique (id, organization_id, company_id),
  -- El padre tiene que ser de la MISMA tienda: no hay árboles cruzando tenants.
  constraint categories_parent_fk foreign key (parent_id, store_id)
    references public.categories (id, store_id) on delete set null
);
create unique index categories_slug_key  on public.categories (store_id, lower(slug));
create index categories_tenant_idx       on public.categories (organization_id, company_id);
create index categories_store_idx        on public.categories (store_id, position);
create index categories_parent_idx       on public.categories (parent_id) where parent_id is not null;

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table public.products (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null,
  company_id       uuid        not null,
  store_id         uuid        not null,
  category_id      uuid,
  sku              text        not null,
  slug             text        not null,
  name             text        not null,
  description      text,
  price            numeric(14,2) not null,
  compare_at_price numeric(14,2),
  currency         char(3)     not null default 'PEN',
  stock            integer     not null default 0,
  status           public.product_status not null default 'draft',
  published_at     timestamptz,
  custom_fields    jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint products_price_positive    check (price >= 0),
  constraint products_compare_positive  check (compare_at_price is null or compare_at_price >= 0),
  constraint products_stock_positive    check (stock >= 0),
  constraint products_currency_fmt      check (currency ~ '^[A-Z]{3}$'),
  constraint products_slug_format       check (slug ~ '^[a-z0-9][a-z0-9-]{0,120}$'),
  constraint products_sku_len           check (char_length(btrim(sku)) between 1 and 64),
  constraint products_name_len          check (char_length(btrim(name)) between 1 and 240),
  -- Publicado sin fecha de publicación es un estado a medias que rompe el
  -- filtro del storefront: se impide en la base, no en la pantalla.
  constraint products_published_needs_date
    check (status <> 'published' or published_at is not null),
  constraint products_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint products_category_fk foreign key (category_id, store_id)
    references public.categories (id, store_id) on delete set null,
  constraint products_store_key  unique (id, store_id),
  constraint products_tenant_key unique (id, organization_id, company_id)
);
create unique index products_sku_key   on public.products (store_id, lower(sku));
create unique index products_slug_key  on public.products (store_id, lower(slug));
create index products_tenant_idx       on public.products (organization_id, company_id);
create index products_store_status_idx on public.products (store_id, status);
create index products_category_idx     on public.products (category_id) where category_id is not null;
create index products_published_idx    on public.products (store_id, published_at desc)
  where status = 'published';

create trigger products_set_updated_at
  before update on public.products
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- product_images — el objeto vive en Storage; aquí solo la ruta.
-- El CHECK obliga al layout `{organization_id}/{store_id}/...`: una ruta que
-- apunte al tenant de al lado no llega ni a insertarse.
-- ---------------------------------------------------------------------------
create table public.product_images (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  product_id      uuid        not null,
  storage_path    text        not null,
  alt             text,
  position        integer     not null default 0,
  is_primary      boolean     not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint product_images_path_tenant
    check (storage_path like (organization_id::text || '/' || store_id::text || '/%')),
  constraint product_images_path_len check (char_length(storage_path) between 10 and 1024),
  constraint product_images_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint product_images_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint product_images_path_unique unique (storage_path)
);
create index product_images_product_idx on public.product_images (product_id, position);
create index product_images_tenant_idx  on public.product_images (organization_id, company_id);
create unique index product_images_primary_key on public.product_images (product_id)
  where is_primary;

create trigger product_images_set_updated_at
  before update on public.product_images
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS · catálogo. Escritura: owner/admin/catalog. `orders`/`viewer` solo leen.
-- ---------------------------------------------------------------------------
alter table public.categories     enable row level security;
alter table public.categories     force  row level security;
alter table public.products       enable row level security;
alter table public.products       force  row level security;
alter table public.product_images enable row level security;
alter table public.product_images force  row level security;

revoke all on public.categories     from public, anon, authenticated;
revoke all on public.products       from public, anon, authenticated;
revoke all on public.product_images from public, anon, authenticated;

grant select, insert, update, delete on public.categories     to authenticated;
grant select, insert, update, delete on public.products       to authenticated;
grant select, insert, update, delete on public.product_images to authenticated;

-- El comprador anónimo no ve el tenant, ni el SKU, ni el stock exacto.
grant select (id, store_id, parent_id, slug, name, position, is_active)
  on public.categories to anon;
grant select (id, store_id, category_id, slug, name, description, price,
              compare_at_price, currency, status, published_at, custom_fields)
  on public.products to anon;
grant select (id, product_id, store_id, storage_path, alt, position, is_primary, created_at)
  on public.product_images to anon;

grant all on public.categories, public.products, public.product_images to service_role;

create policy categories_select_member on public.categories
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy categories_insert_catalog on public.categories
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy categories_update_catalog on public.categories
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy categories_delete_catalog on public.categories
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy categories_select_public on public.categories
  for select to anon
  using (
    is_active
    and exists (select 1 from public.stores s where s.id = categories.store_id and s.status = 'active')
  );

create policy products_select_member on public.products
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy products_insert_catalog on public.products
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy products_update_catalog on public.products
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy products_delete_catalog on public.products
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy products_select_public on public.products
  for select to anon
  using (
    status = 'published'
    and published_at is not null
    and published_at <= now()
    and exists (select 1 from public.stores s where s.id = products.store_id and s.status = 'active')
  );

create policy product_images_select_member on public.product_images
  for select to authenticated using (ebim.can_access(organization_id, company_id));
create policy product_images_insert_catalog on public.product_images
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_images_update_catalog on public.product_images
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_images_delete_catalog on public.product_images
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','catalog']::public.app_role[]));
create policy product_images_select_public on public.product_images
  for select to anon
  using (
    exists (
      select 1
      from public.products p
      join public.stores  s on s.id = p.store_id
      where p.id = product_images.product_id
        and p.status = 'published'
        and p.published_at is not null
        and p.published_at <= now()
        and s.status = 'active'
    )
  );

comment on column public.products.price is
  'numeric(14,2). Dinero nunca en float: el redondeo binario descuadra los centimos.';
comment on constraint product_images_path_tenant on public.product_images is
  'La ruta de Storage debe empezar por {organization_id}/{store_id}/ — aislamiento por path.';
