-- =============================================================================
-- P09 · Monedas e impuestos configurables
-- 16/16 — Saca de codigo dos decisiones que hoy estan cableadas:
--         `stores.currency default 'PEN'` y `store_settings.tax_rate default 0.18`
--         (IGV peruano). Un tenant boliviano necesita BOB e IVA 13%; uno chileno,
--         CLP e IVA 19%. Ninguno de esos numeros puede vivir en el esquema ni en
--         un enum de React (hoy: CURRENCIES en OnboardingPage.tsx, sin BOB).
--
-- Principio 2 del contrato: personalizacion = configuracion + datos. Nunca un
-- fork de schema ni una rama por pais.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- currencies — catalogo GLOBAL del producto, no dato de tenant.
-- ISO 4217 es un hecho, no una preferencia: no lleva organization_id y no se
-- edita desde el backoffice. Los tenants habilitan un subconjunto (ver
-- `tenant_currencies`), no inventan monedas.
-- ---------------------------------------------------------------------------
create table public.currencies (
  code       char(3)     primary key,
  name       text        not null,
  symbol     text        not null,
  -- Digitos de la subunidad (ISO 4217). Importa para redondear y para formatear:
  -- CLP y JPY no tienen decimales; la mayoria tiene 2. Cablear 2 es un bug de
  -- dinero, no de presentacion.
  minor_unit smallint    not null default 2,
  is_active  boolean     not null default true,
  created_at timestamptz not null default now(),
  constraint currencies_code_fmt   check (code ~ '^[A-Z]{3}$'),
  constraint currencies_name_len   check (char_length(btrim(name)) between 1 and 80),
  constraint currencies_symbol_len check (char_length(btrim(symbol)) between 1 and 8),
  constraint currencies_minor_unit check (minor_unit between 0 and 4)
);

insert into public.currencies (code, name, symbol, minor_unit) values
  ('BOB', 'Boliviano',       'Bs',  2),
  ('PEN', 'Sol',             'S/',  2),
  ('USD', 'Dolar americano', '$',   2),
  ('EUR', 'Euro',            'EUR', 2),
  ('CLP', 'Peso chileno',    '$',   0),
  ('COP', 'Peso colombiano', '$',   2),
  ('MXN', 'Peso mexicano',   '$',   2),
  ('ARS', 'Peso argentino',  '$',   2),
  ('BRL', 'Real',            'R$',  2);

-- ---------------------------------------------------------------------------
-- tenant_currencies — que monedas habilita cada tenant y cual es la base.
-- ---------------------------------------------------------------------------
create table public.tenant_currencies (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  currency        char(3)     not null references public.currencies (code) on delete restrict,
  -- Moneda de referencia de la sociedad: la de sus reportes y su contabilidad.
  is_base         boolean     not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint tenant_currencies_unique unique (organization_id, company_id, currency)
);

-- Una sola moneda base por sociedad. Indice parcial en vez de validacion de
-- pantalla: la segunda base falla en la base de datos.
create unique index tenant_currencies_one_base
  on public.tenant_currencies (organization_id, company_id)
  where is_base;

-- ---------------------------------------------------------------------------
-- tax_categories — el impuesto es una CATEGORIA, no un numero suelto.
-- Alicorp vende alimentos: parte del catalogo puede ir exento o a tasa cero
-- mientras el resto va a IVA general. Una tasa unica por tienda no lo soporta.
-- ---------------------------------------------------------------------------
create table public.tax_categories (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  code            text        not null,
  name            text        not null,
  is_default      boolean     not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint tax_categories_code_fmt   check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint tax_categories_name_len   check (char_length(btrim(name)) between 1 and 120),
  constraint tax_categories_unique     unique (organization_id, company_id, code),
  constraint tax_categories_tenant_key unique (id, organization_id, company_id)
);

create unique index tax_categories_one_default
  on public.tax_categories (organization_id, company_id)
  where is_default;

-- ---------------------------------------------------------------------------
-- tax_rates — la tasa con VIGENCIA. Las tasas las cambia una ley, y un pedido
-- de hace seis meses tiene que poder recalcularse con la tasa que estaba
-- vigente ese dia. Por eso versiona en vez de sobrescribir.
-- ---------------------------------------------------------------------------
create table public.tax_rates (
  id              uuid         primary key default gen_random_uuid(),
  organization_id uuid         not null,
  company_id      uuid         not null,
  tax_category_id uuid         not null,
  rate            numeric(6,4) not null,
  valid_from      timestamptz  not null default now(),
  valid_to        timestamptz,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now(),
  constraint tax_rates_rate_range check (rate >= 0 and rate <= 1),
  constraint tax_rates_period     check (valid_to is null or valid_to > valid_from),
  constraint tax_rates_category_fk foreign key (tax_category_id, organization_id, company_id)
    references public.tax_categories (id, organization_id, company_id) on delete cascade
);

-- Como mucho UNA tasa abierta por categoria. Cerrar la anterior es obligatorio
-- antes de abrir la siguiente, asi que "que tasa aplica hoy" nunca es ambiguo.
create unique index tax_rates_one_open
  on public.tax_rates (tax_category_id)
  where valid_to is null;

create index tax_rates_lookup
  on public.tax_rates (tax_category_id, valid_from desc);

-- Toda policy RLS de esta tabla filtra por (organization_id, company_id):
-- sin este indice cada lectura es un scan. Invariante del repo, ademas.
create index tax_rates_tenant
  on public.tax_rates (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- Enganche con lo que ya existe
-- ---------------------------------------------------------------------------

-- `default 'PEN'` fuera: la moneda se elige al crear la tienda, no se hereda de
-- un pais que nadie eligio. El onboarding ya la manda explicitamente.
alter table public.stores alter column currency drop default;

alter table public.stores
  add constraint stores_currency_fk foreign key (currency)
  references public.currencies (code) on delete restrict;

alter table public.products
  add constraint products_currency_fk foreign key (currency)
  references public.currencies (code) on delete restrict;

-- Categoria fiscal por defecto de la tienda y regla de presentacion del precio.
alter table public.store_settings
  add column tax_category_id uuid,
  add column tax_inclusive   boolean not null default false;

alter table public.store_settings
  add constraint store_settings_tax_category_fk
  foreign key (tax_category_id, organization_id, company_id)
  references public.tax_categories (id, organization_id, company_id)
  on delete set null (tax_category_id);

-- Categoria fiscal por producto: null = la de la tienda.
alter table public.products add column tax_category_id uuid;

alter table public.products
  add constraint products_tax_category_fk
  foreign key (tax_category_id, organization_id, company_id)
  references public.tax_categories (id, organization_id, company_id)
  on delete set null (tax_category_id);

-- ---------------------------------------------------------------------------
-- Resolucion de la tasa efectiva
--
-- SECURITY DEFINER con autorizacion explicita dentro (la tienda tiene que estar
-- `active`). Devuelve un escalar, nunca filas de tenant: la vitrina anonima
-- necesita la tasa para mostrar el precio con IVA incluido —el RFP de Alicorp
-- lo exige en §2.5.3.b— sin darle SELECT sobre `tax_rates`.
--
-- Cascada: categoria del producto -> categoria de la tienda ->
--          `store_settings.tax_rate` (legado) -> 0.
-- ---------------------------------------------------------------------------
create or replace function ebim.effective_tax_rate(
  p_store_id        uuid,
  p_tax_category_id uuid default null,
  p_at              timestamptz default now()
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  with authorized as (
    select s.id, s.organization_id, s.company_id
    from public.stores s
    where s.id = p_store_id
      and s.status = 'active'
  ),
  resolved_category as (
    select coalesce(
      (select tc.id
         from public.tax_categories tc, authorized a
        where tc.id = p_tax_category_id
          and tc.organization_id = a.organization_id
          and tc.company_id = a.company_id),
      (select ss.tax_category_id
         from public.store_settings ss, authorized a
        where ss.store_id = a.id)
    ) as id
  )
  select coalesce(
    (select tr.rate
       from public.tax_rates tr, resolved_category rc
      where tr.tax_category_id = rc.id
        and tr.valid_from <= p_at
        and (tr.valid_to is null or tr.valid_to > p_at)
      order by tr.valid_from desc
      limit 1),
    (select ss.tax_rate
       from public.store_settings ss, authorized a
      where ss.store_id = a.id),
    0
  );
$fn$;

-- ---------------------------------------------------------------------------
-- RLS — default deny en todas las tablas nuevas
-- ---------------------------------------------------------------------------
alter table public.currencies        enable row level security;
alter table public.currencies        force  row level security;
alter table public.tenant_currencies enable row level security;
alter table public.tenant_currencies force  row level security;
alter table public.tax_categories    enable row level security;
alter table public.tax_categories    force  row level security;
alter table public.tax_rates         enable row level security;
alter table public.tax_rates         force  row level security;

revoke all on public.currencies        from public, anon, authenticated;
revoke all on public.tenant_currencies from public, anon, authenticated;
revoke all on public.tax_categories    from public, anon, authenticated;
revoke all on public.tax_rates         from public, anon, authenticated;

-- Catalogo de monedas: lectura para todos (lo necesitan el selector de
-- onboarding y el formateo de la vitrina), escritura solo del servidor.
grant select on public.currencies to anon, authenticated;
grant all    on public.currencies to service_role;

grant select, insert, update, delete on public.tenant_currencies to authenticated;
grant select, insert, update, delete on public.tax_categories    to authenticated;
grant select, insert, update, delete on public.tax_rates         to authenticated;
grant all on public.tenant_currencies, public.tax_categories, public.tax_rates to service_role;

create policy currencies_select_all on public.currencies
  for select to anon, authenticated
  using (is_active);

create policy tenant_currencies_select_member on public.tenant_currencies
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy tenant_currencies_insert_admin on public.tenant_currencies
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tenant_currencies_update_admin on public.tenant_currencies
  for update to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tenant_currencies_delete_admin on public.tenant_currencies
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tax_categories_select_member on public.tax_categories
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy tax_categories_insert_admin on public.tax_categories
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tax_categories_update_admin on public.tax_categories
  for update to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tax_categories_delete_admin on public.tax_categories
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tax_rates_select_member on public.tax_rates
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy tax_rates_insert_admin on public.tax_rates
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tax_rates_update_admin on public.tax_rates
  for update to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tax_rates_delete_admin on public.tax_rates
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

-- La resuelve tambien la vitrina anonima: sin esto el precio con IVA se
-- calcularia en el cliente, que es donde no se calcula dinero.
revoke execute on function ebim.effective_tax_rate(uuid, uuid, timestamptz) from public;
grant  execute on function ebim.effective_tax_rate(uuid, uuid, timestamptz)
  to anon, authenticated, service_role;

create trigger tenant_currencies_updated_at before update on public.tenant_currencies
  for each row execute function ebim.set_updated_at();
create trigger tax_categories_updated_at before update on public.tax_categories
  for each row execute function ebim.set_updated_at();
create trigger tax_rates_updated_at before update on public.tax_rates
  for each row execute function ebim.set_updated_at();

comment on table public.currencies is
  'Catalogo ISO 4217 del producto. Global, no de tenant: cada tenant habilita un subconjunto en tenant_currencies.';
comment on column public.currencies.minor_unit is
  'Digitos de la subunidad. CLP=0, la mayoria=2. Cablear 2 redondea mal el dinero.';
comment on table public.tax_rates is
  'Tasa con vigencia. Se versiona, no se sobrescribe: un pedido antiguo se recalcula con la tasa de su fecha.';
comment on column public.store_settings.tax_rate is
  'LEGADO. Fallback de ebim.effective_tax_rate mientras create-order migra a tax_categories. No usar en codigo nuevo.';
comment on column public.store_settings.tax_inclusive is
  'true = los precios del catalogo ya llevan impuesto (el RFP de Alicorp §2.5.3.b exige mostrar precios con IVA).';
