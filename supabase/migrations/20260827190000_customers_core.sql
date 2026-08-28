-- =============================================================================
-- P05-SaaS · Clientes: la ficha comercial, separada de la autenticacion
--
-- Hasta aqui "el cliente" de eCommerce era tres columnas desnormalizadas dentro
-- del pedido (`orders.customer_email`, `customer_name`, `customer_phone`) y un
-- uuid sin tabla (`price_list_assignments.customer_id`). Eso alcanza para una
-- tienda que vende una vez a un desconocido y no alcanza para nada mas: no hay
-- donde guardar la segunda direccion de entrega, ni el contacto de compras, ni
-- el codigo con el que ese mismo cliente existe en el ERP, ni a que segmento
-- pertenece para que el motor de precios lo encuentre.
--
-- ## La decision de fondo: usuario autenticado != cliente
--
-- Son dos ejes distintos y confundirlos es el error que despues no se puede
-- deshacer:
--
--   · **Usuario** es quien inicia sesion. La identidad la emite el hub
--     (contrato §2) o, para el comprador del storefront, este proyecto. Un
--     usuario puede representar a varios clientes, y un cliente puede no tener
--     ni un usuario — la mayoria de los clientes de una tienda son eso.
--   · **Cliente** es la contraparte comercial: a quien se le factura, a quien
--     se le tarifa y a donde se le entrega.
--
-- Por eso `customers` NO tiene `user_id`. El vinculo entre personas y cuentas
-- vive en `business_account_users` (migracion 190100), que es una relacion y no
-- una columna, porque una columna solo sabe expresar "uno".
--
-- ## El alcance: de la SOCIEDAD, no de la tienda
--
-- `customers` no lleva `store_id`, igual que `customer_segments`, las marcas y
-- las unidades de medida. Un cliente de la sociedad lo es de todas sus tiendas:
-- darle `store_id` obligaria a duplicar la ficha —y con ella el RUC, las
-- direcciones y el codigo del ERP— cada vez que la sociedad abre un canal
-- nuevo, y a partir de ese momento habria dos verdades sobre el mismo cliente.
-- El pedido si es de una tienda; el cliente que lo hace, no.
--
-- Cuatro tablas:
--
--   customers             · la ficha: quien es, de que tipo y en que segmento.
--   customer_addresses    · a donde se entrega y a donde se factura.
--   customer_contacts     · con quien se habla.
--   customer_external_ids · como se llama en los sistemas de al lado.
--
-- Lo que esta migracion NO hace, y no por falta de sitio:
--
--  · **No toca `orders`.** El checkout sigue siendo anonimo y el pedido sigue
--    llevando su contacto desnormalizado, que es la verdad del momento de la
--    compra. Colgarle un `customer_id` hoy seria una columna que solo puede
--    rellenar el navegador —y el navegador no declara identidades (regla 6 del
--    contrato de ejecucion)—. Se cierra cuando el comprador tenga sesion.
--  · **No implementa credito ni condiciones de pago.** Regla 7 de la fase: nada
--    de logica de un ERP concreto. Lo que si nace es el limite de autorizacion,
--    que es del portal y no del ERP (migracion 190100).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- customer_kind — persona o empresa.
--
-- Dos valores y no tres. "Perfil privado" no es un tercer tipo de cliente: es
-- una persona sin cuenta B2B, que es exactamente `kind = 'person'` sin fila en
-- `business_accounts`. Un tercer valor obligaria a decidir que pasa cuando una
-- persona contrata el portal, y la respuesta correcta —nada, sigue siendo una
-- persona— es la que el enum de dos valores ya da.
-- ---------------------------------------------------------------------------
create type public.customer_kind as enum ('person', 'company');

create table public.customers (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  kind            public.customer_kind not null default 'person',
  -- Codigo del cliente DENTRO de la sociedad. Es una clave natural util para
  -- buscar y para conciliar, no el identificador del sistema: la PK es el uuid
  -- y ninguna FK apunta al codigo, asi que renombrarlo no rompe nada.
  code            text        not null,
  name            text        not null,
  -- Razon social, cuando difiere del nombre comercial. Una empresa se llama de
  -- una forma en la factura y de otra en el mostrador, y guardar solo una de
  -- las dos obliga a elegir cual sale mal.
  legal_name      text,
  -- Documento fiscal SIN formato impuesto: un RUC, un NIT, un CIF y un VAT no
  -- comparten longitud ni alfabeto, y validar aqui el de un pais convertiria
  -- este producto en el producto de ese pais.
  tax_id          text,
  email           text,
  phone           text,
  -- El segmento comercial (P04). Es lo que hace que la ficha de cliente sea
  -- consumible por el motor de precios sin que el motor sepa de fichas.
  segment_id      uuid,
  is_active       boolean     not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint customers_code_fmt
    check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$'),
  constraint customers_name_len  check (char_length(btrim(name)) between 1 and 200),
  constraint customers_legal_len check (legal_name is null or char_length(legal_name) <= 200),
  constraint customers_tax_len   check (tax_id is null or char_length(btrim(tax_id)) between 3 and 40),
  constraint customers_email_fmt check (email is null or position('@' in email) > 1),
  constraint customers_phone_len check (phone is null or char_length(btrim(phone)) between 4 and 40),
  constraint customers_notes_len check (notes is null or char_length(notes) <= 2000),
  constraint customers_tenant_key unique (id, organization_id, company_id),
  -- Clave de apoyo para que una cuenta B2B solo pueda colgar de una empresa
  -- (migracion 190100). Misma tecnica que el PIM: la FK compuesta hace
  -- imposible el estado en vez de confiar en que la pantalla no lo escriba.
  constraint customers_kind_key   unique (id, kind),
  constraint customers_segment_fk foreign key (segment_id, organization_id, company_id)
    references public.customer_segments (id, organization_id, company_id)
    -- La lista de columnas es obligatoria: `organization_id` y `company_id`
    -- forman parte de la clave y son NOT NULL, asi que un `set null` a secas
    -- impediria borrar el segmento (misma razon que en `order_items`).
    on delete set null (segment_id)
);

-- Unicidad del codigo SIN distinguir mayusculas: "CL-0001" y "cl-0001" son el
-- mismo cliente para cualquiera que los lea, y admitir los dos es la forma
-- habitual de acabar con la ficha partida en dos.
create unique index customers_code_key
  on public.customers (organization_id, company_id, lower(code));
create index customers_tenant_idx  on public.customers (organization_id, company_id);
create index customers_segment_idx on public.customers (segment_id) where segment_id is not null;
create index customers_email_idx   on public.customers (organization_id, company_id, lower(email))
  where email is not null;
create index customers_active_idx  on public.customers (organization_id, company_id, name) where is_active;

-- ---------------------------------------------------------------------------
-- customer_addresses — a donde se entrega y a donde se factura.
--
-- Tres decisiones que no son obvias:
--
--  1. **El uso son dos banderas, no un enum.** La misma direccion suele servir
--     para entregar y para facturar; con un enum `('shipping','billing')`
--     habria que duplicar la fila, y el dia que cambie la calle habra que
--     acordarse de cambiarla dos veces. El CHECK exige al menos un uso: una
--     direccion que no sirve para nada no es un dato, es basura que alguien
--     tendra que interpretar.
--  2. **El predeterminado es un indice parcial unico**, no una columna en el
--     cliente. Asi no puede haber dos direcciones de envio por defecto ni una
--     por defecto que ya no sea de envio.
--  3. **La verificacion es un estado, no un booleano.** Una integracion que
--     valida direcciones distingue "todavia no se pregunto" de "se pregunto y
--     dijo que no", y con un booleano las dos serian `false` — que es como se
--     reintenta eternamente una direccion que el proveedor ya rechazo. Para
--     los ERP que solo entregan en destinos autorizados, `verified` ES el
--     estado de autorizado.
-- ---------------------------------------------------------------------------
create type public.address_verification as enum
  ('unverified', 'pending', 'verified', 'rejected');

create table public.customer_addresses (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null,
  company_id          uuid        not null,
  customer_id         uuid        not null,
  label               text        not null,
  recipient           text,
  phone               text,
  line1               text        not null,
  line2               text,
  city                text,
  region              text,
  postal_code         text,
  -- ISO 3166-1 alpha-2. Es un hecho del mundo, como la moneda ISO 4217.
  country             char(2)     not null,
  is_shipping         boolean     not null default true,
  is_billing          boolean     not null default false,
  is_default_shipping boolean     not null default false,
  is_default_billing  boolean     not null default false,
  verification        public.address_verification not null default 'unverified',
  verified_at         timestamptz,
  -- QUE sistema la autorizo. Texto y no FK a `integration_providers`: un ERP
  -- sin conector todavia declarado tambien autoriza destinos, y una FK aqui
  -- obligaria a dar de alta el conector antes de poder anotar el hecho.
  verification_source text,
  -- Identificador de esta direccion en ese sistema (el "ship-to" del ERP).
  external_ref        text,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint customer_addresses_label_len check (char_length(btrim(label)) between 1 and 120),
  constraint customer_addresses_line1_len check (char_length(btrim(line1)) between 3 and 240),
  constraint customer_addresses_line2_len check (line2 is null or char_length(line2) <= 240),
  constraint customer_addresses_city_len  check (city is null or char_length(city) <= 120),
  constraint customer_addresses_region_len check (region is null or char_length(region) <= 120),
  constraint customer_addresses_zip_len   check (postal_code is null or char_length(postal_code) <= 20),
  constraint customer_addresses_country_fmt check (country ~ '^[A-Z]{2}$'),
  constraint customer_addresses_recipient_len
    check (recipient is null or char_length(btrim(recipient)) between 1 and 120),
  constraint customer_addresses_phone_len
    check (phone is null or char_length(btrim(phone)) between 4 and 40),
  constraint customer_addresses_source_len
    check (verification_source is null or char_length(verification_source) <= 60),
  constraint customer_addresses_ref_len
    check (external_ref is null or char_length(external_ref) <= 120),
  -- Una direccion sin uso declarado no se puede elegir en ningun formulario.
  constraint customer_addresses_has_use check (is_shipping or is_billing),
  -- El predeterminado tiene que serlo de un uso que la direccion tiene.
  constraint customer_addresses_default_shipping_use
    check (not is_default_shipping or is_shipping),
  constraint customer_addresses_default_billing_use
    check (not is_default_billing or is_billing),
  constraint customer_addresses_customer_fk foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade,
  -- Clave de apoyo: una sucursal (190100) solo puede apuntar a una direccion
  -- DEL MISMO cliente.
  constraint customer_addresses_customer_key unique (id, customer_id)
);

create index customer_addresses_customer_idx on public.customer_addresses (customer_id);
create index customer_addresses_tenant_idx   on public.customer_addresses (organization_id, company_id);
create unique index customer_addresses_one_default_shipping
  on public.customer_addresses (customer_id) where is_default_shipping;
create unique index customer_addresses_one_default_billing
  on public.customer_addresses (customer_id) where is_default_billing;

-- `verified_at` lo pone la base, no la pantalla: una fecha de verificacion que
-- escribe el cliente es una fecha inventada, y sin ella no se puede saber si la
-- autorizacion es de esta semana o de hace tres anos.
create or replace function ebim.stamp_address_verification()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' or new.verification is distinct from old.verification then
    new.verified_at := case when new.verification = 'verified' then now() end;
  end if;
  return new;
end;
$fn$;

create trigger customer_addresses_stamp_verification
  before insert or update on public.customer_addresses
  for each row execute function ebim.stamp_address_verification();

-- ---------------------------------------------------------------------------
-- customer_contacts — las personas del cliente.
--
-- No son usuarios: un contacto es un nombre y una forma de localizarlo, y la
-- inmensa mayoria nunca va a iniciar sesion. Quien SI inicia sesion aparece
-- ademas en `business_account_users` (190100). Mezclar las dos tablas obligaria
-- a inventar un `user_id` para el jefe de almacen al que solo se le llama por
-- telefono.
-- ---------------------------------------------------------------------------
create table public.customer_contacts (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  customer_id     uuid        not null,
  name            text        not null,
  email           text,
  phone           text,
  -- Cargo o area. Texto libre: "compras" no significa lo mismo en dos
  -- empresas y un enum aqui seria el organigrama de una de ellas.
  role_title      text,
  is_primary      boolean     not null default false,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint customer_contacts_name_len  check (char_length(btrim(name)) between 1 and 120),
  constraint customer_contacts_email_fmt check (email is null or position('@' in email) > 1),
  constraint customer_contacts_phone_len check (phone is null or char_length(btrim(phone)) between 4 and 40),
  constraint customer_contacts_role_len  check (role_title is null or char_length(role_title) <= 80),
  -- Un contacto sin correo ni telefono no se puede contactar.
  constraint customer_contacts_reachable check (email is not null or phone is not null),
  constraint customer_contacts_customer_fk foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade
);

create index customer_contacts_customer_idx on public.customer_contacts (customer_id);
create index customer_contacts_tenant_idx   on public.customer_contacts (organization_id, company_id);
create unique index customer_contacts_one_primary
  on public.customer_contacts (customer_id) where is_primary;
create unique index customer_contacts_email_key
  on public.customer_contacts (customer_id, lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- customer_external_ids — como se llama este cliente en el sistema de al lado.
--
-- El requisito de la fase es explicito: identificadores externos por
-- proveedor/ERP **sin convertirlos en PK**. Y hay una razon dura para no
-- hacerlo: el codigo del ERP no es unico entre sistemas, cambia cuando el
-- cliente migra de version y no existe para el cliente que se dio de alta en la
-- tienda ayer. Una PK con esas tres propiedades no es una PK.
--
-- Dos unicidades y las dos hacen falta:
--   · un cliente tiene UN codigo por sistema (si no, la sincronizacion no sabe
--     cual mandar);
--   · un codigo de un sistema apunta a UN cliente (si no, dos fichas se
--     pelearian por el mismo pedido entrante).
-- ---------------------------------------------------------------------------
create table public.customer_external_ids (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  customer_id     uuid        not null,
  -- Codigo del sistema. Cuando exista un conector se usa el `code` de
  -- `integration_providers`; sin FK a proposito, porque un sistema sin conector
  -- todavia declarado tambien tiene codigos de cliente.
  system_code     text        not null,
  external_id     text        not null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint customer_external_ids_system_fmt
    check (system_code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint customer_external_ids_value_len
    check (char_length(btrim(external_id)) between 1 and 120),
  constraint customer_external_ids_notes_len check (notes is null or char_length(notes) <= 240),
  constraint customer_external_ids_one_per_system unique (customer_id, system_code),
  constraint customer_external_ids_customer_fk foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade
);

create index customer_external_ids_customer_idx on public.customer_external_ids (customer_id);
create index customer_external_ids_tenant_idx
  on public.customer_external_ids (organization_id, company_id);
create unique index customer_external_ids_value_key
  on public.customer_external_ids (organization_id, company_id, system_code, lower(external_id));

-- ---------------------------------------------------------------------------
-- La deuda declarada de P04, saldada.
--
-- `price_list_assignments.customer_id` nacio SIN FK porque `customers` no
-- existia, y quedo escrito en la migracion 180000 y en `docs/STATE.md` para que
-- la revision no lo confundiera con un descuido. Ahora la tiene, compuesta con
-- el tenant: una asignacion no puede tarifar a un cliente de otra sociedad
-- aunque alguien copie mal un uuid.
--
-- `on delete cascade`: borrar un cliente borra el acuerdo que se le habia
-- asignado. La alternativa —dejar la asignacion viva apuntando a nadie— es una
-- lista que se aplica a un fantasma.
-- ---------------------------------------------------------------------------
alter table public.price_list_assignments
  add constraint price_list_assignments_customer_fk
  foreign key (customer_id, organization_id, company_id)
  references public.customers (id, organization_id, company_id) on delete cascade;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create trigger customers_set_updated_at before update on public.customers
  for each row execute function ebim.set_updated_at();
create trigger customer_addresses_set_updated_at before update on public.customer_addresses
  for each row execute function ebim.set_updated_at();
create trigger customer_contacts_set_updated_at before update on public.customer_contacts
  for each row execute function ebim.set_updated_at();
create trigger customer_external_ids_set_updated_at before update on public.customer_external_ids
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS · default deny en las cuatro tablas.
--
-- **Sin capacidad.** La ficha de cliente es BASELINE: una tienda que vende una
-- sola vez tambien necesita saber a quien le vendio, y cobrar aparte por poder
-- guardar el correo del comprador no es un modulo, es un peaje. Lo que si se
-- vende es la cuenta B2B —varios usuarios, sucursales, aprobaciones— y eso se
-- gatea en la migracion 190100.
--
-- Escritura: `owner`, `admin` y `orders`. El rol `orders` entra porque quien
-- atiende a un comprador es quien descubre que su direccion cambio, y obligarle
-- a pedirselo a un administrador convierte una correccion de un minuto en un
-- ticket. `catalog` no entra: un cliente no es catalogo.
--
-- `anon` no tiene ni un GRANT. El comprador anonimo del storefront no lee
-- fichas de cliente, ni la suya: sin sesion no hay forma de saber cual es suya,
-- y "la del correo que escriba" seria un buscador de datos personales abierto.
-- ---------------------------------------------------------------------------
alter table public.customers             enable row level security;
alter table public.customers             force  row level security;
alter table public.customer_addresses    enable row level security;
alter table public.customer_addresses    force  row level security;
alter table public.customer_contacts     enable row level security;
alter table public.customer_contacts     force  row level security;
alter table public.customer_external_ids enable row level security;
alter table public.customer_external_ids force  row level security;

revoke all on public.customers             from public, anon, authenticated;
revoke all on public.customer_addresses    from public, anon, authenticated;
revoke all on public.customer_contacts     from public, anon, authenticated;
revoke all on public.customer_external_ids from public, anon, authenticated;

grant select, insert, update, delete on public.customers             to authenticated;
grant select, insert, update, delete on public.customer_addresses    to authenticated;
grant select, insert, update, delete on public.customer_contacts     to authenticated;
grant select, insert, update, delete on public.customer_external_ids to authenticated;

grant all on public.customers, public.customer_addresses,
             public.customer_contacts, public.customer_external_ids
  to service_role;

create policy customers_select_member on public.customers
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy customers_insert_staff on public.customers
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy customers_update_staff on public.customers
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

-- Borrar un cliente arrastra sus direcciones, contactos e identificadores por
-- cascada, y eso es una decision comercial: se reserva a owner/admin.
create policy customers_delete_admin on public.customers
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy customer_addresses_select_member on public.customer_addresses
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy customer_addresses_insert_staff on public.customer_addresses
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy customer_addresses_update_staff on public.customer_addresses
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy customer_addresses_delete_staff on public.customer_addresses
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy customer_contacts_select_member on public.customer_contacts
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy customer_contacts_insert_staff on public.customer_contacts
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy customer_contacts_update_staff on public.customer_contacts
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy customer_contacts_delete_staff on public.customer_contacts
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

-- Los identificadores externos son configuracion de INTEGRACION: cambiar el
-- codigo con el que este cliente existe en el ERP redirige documentos a otra
-- ficha. Se reserva a owner/admin, como el resto de lo que decide a donde va
-- un dato fuera de esta base.
create policy customer_external_ids_select_member on public.customer_external_ids
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy customer_external_ids_insert_admin on public.customer_external_ids
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy customer_external_ids_update_admin on public.customer_external_ids
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy customer_external_ids_delete_admin on public.customer_external_ids
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
comment on table public.customers is
  'Contraparte comercial de la sociedad: persona o empresa. NO es un usuario autenticado y no tiene user_id; el vinculo con personas vive en business_account_users.';
comment on column public.customers.code is
  'Clave natural dentro de la sociedad, unica sin distinguir mayusculas. Ninguna FK apunta a ella: la identidad es el uuid.';
comment on column public.customers.tax_id is
  'Documento fiscal sin formato impuesto: RUC, NIT, CIF y VAT no comparten longitud ni alfabeto.';
comment on column public.customers.segment_id is
  'Segmento comercial (P04). Es lo que hace la ficha consumible por el motor de precios.';
comment on table public.customer_addresses is
  'Direcciones del cliente. El uso son dos banderas porque la misma direccion suele servir para entregar y para facturar.';
comment on column public.customer_addresses.verification is
  'Estado, no booleano: "no se pregunto" y "el proveedor dijo que no" son cosas distintas. Para un ERP con destinos autorizados, verified = autorizado.';
comment on table public.customer_contacts is
  'Personas del cliente. Un contacto no es un usuario: la mayoria nunca inicia sesion.';
comment on table public.customer_external_ids is
  'Como se llama este cliente en cada sistema externo. Atributo, nunca clave primaria: no es unico entre sistemas ni existe para todos los clientes.';
