-- =============================================================================
-- P05-SaaS · Cuentas B2B: varios usuarios, sucursales, roles y autorizacion
--
-- La ficha de cliente (190000) responde "a quien le vendo". Esta migracion
-- responde la pregunta que separa una tienda de un canal B2B: **quien, de esa
-- empresa, puede comprar, hasta cuanto, y a que sucursal**.
--
-- ## Por que `business_accounts` existe y no es `customers` con banderas
--
-- La tentacion es evidente: la cuenta B2B es 1:1 con el cliente empresa, o sea
-- que "podrian ser columnas". No lo son, y por dos razones que se notan el
-- primer dia:
--
--  · **Ciclo de vida distinto.** Casi todos los clientes de una tienda NUNCA
--    tienen portal. Meter `requires_approval`, `approval_threshold` y
--    `purchase_order_required` en `customers` obligaria a que cada comprador
--    de mostrador arrastre tres columnas que no significan nada para el.
--  · **Se contrata aparte.** El portal B2B es la capacidad vendible
--    `customers.b2b`; la ficha de cliente es baseline. Con todo en una tabla,
--    la policy tendria que exigir la capacidad para escribir el telefono de un
--    comprador anonimo, o no exigirla para nada.
--
-- Lo que SI se hace es que la cuenta no pueda existir sin su cliente ni colgar
-- de una persona: `business_accounts` referencia `(customer_id, customer_kind)`
-- contra `customers (id, kind)`, asi que una cuenta corporativa sobre una
-- persona fisica es un estado imposible — y un cliente con cuenta ya no se
-- puede convertir en persona.
--
-- ## Los roles: enum, y la configuracion esta en los limites
--
-- Cuatro roles fijos —`admin`, `buyer`, `approver`, `viewer`— y no una tabla de
-- roles con permisos por fila. Es deliberado:
--
--  · Un permiso que es un dato ya no se puede leer dentro de una policy sin
--    una consulta mas por cada comprobacion, y deja de ser auditable de un
--    vistazo: "quien puede aprobar" pasa a ser el resultado de un JOIN.
--  · Un "comprador" al que se le puede marcar `puede_aprobar` destruye
--    exactamente la separacion de funciones para la que existen las reglas de
--    aprobacion. Si el rol es configurable, el control es decorativo.
--
-- Lo que si es configurable, y es lo que cada empresa necesita de verdad, son
-- los IMPORTES: `business_account_users.spending_limit` por persona y
-- `approval_rules.min_amount` por cuenta. Es la misma decision que P04 tomo con
-- la precedencia de precios: el orden no se configura, los numeros si.
--
-- ## Lo que esta migracion NO hace
--
--  · **No hay flujo de aprobacion.** Hay reglas y una funcion que dice si un
--    importe las cruza. Estados, notificaciones y bandeja del aprobador son
--    otra fase: la fase pide fundamento, no workflow.
--  · **No hay credito, ni condiciones de pago, ni bloqueo por deuda.** Regla 7:
--    nada de la logica de un ERP concreto.
--  · **El usuario B2B todavia no compra.** El checkout sigue siendo anonimo. Lo
--    que existe ya es el vinculo servidor y su contexto (`my_business_accounts`)
--    para que, cuando el comprador tenga sesion, no haya que inventar de donde
--    sale su cuenta.
-- =============================================================================

create type public.business_role as enum ('admin', 'buyer', 'approver', 'viewer');

-- ---------------------------------------------------------------------------
-- business_accounts — la activacion del portal sobre un cliente empresa.
-- ---------------------------------------------------------------------------
create table public.business_accounts (
  id                      uuid        primary key default gen_random_uuid(),
  organization_id         uuid        not null,
  company_id              uuid        not null,
  customer_id             uuid        not null,
  -- Denormalizada para que el CHECK pueda mirar la fila del padre. Sin ella no
  -- hay forma declarativa de exigir que el cliente sea una empresa.
  customer_kind           public.customer_kind not null default 'company',
  code                    text        not null,
  name                    text        not null,
  is_active               boolean     not null default true,
  -- Aprobacion: `requires_approval` enciende el control; el umbral dice desde
  -- cuanto. NULL con el control encendido = SIEMPRE hace falta aprobacion, que
  -- es lo que pide una empresa que quiere revisarlo todo.
  requires_approval       boolean     not null default false,
  approval_threshold      numeric(14,2),
  -- Muchas empresas no aceptan una compra sin su numero de orden interno.
  purchase_order_required boolean     not null default false,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint business_accounts_code_fmt
    check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$'),
  constraint business_accounts_name_len  check (char_length(btrim(name)) between 1 and 200),
  constraint business_accounts_notes_len check (notes is null or char_length(notes) <= 2000),
  constraint business_accounts_threshold_sign
    check (approval_threshold is null or approval_threshold >= 0),
  -- Un umbral sin control encendido es un numero que no decide nada y que
  -- alguien leera como si decidiera.
  constraint business_accounts_threshold_needs_control
    check (requires_approval or approval_threshold is null),
  -- Una cuenta corporativa sobre una persona fisica: imposible.
  constraint business_accounts_kind_is_company check (customer_kind = 'company'),
  constraint business_accounts_customer_fk foreign key (customer_id, customer_kind)
    references public.customers (id, kind) on update cascade on delete cascade,
  constraint business_accounts_tenant_fk foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade,
  -- Una cuenta por cliente: el portal es una activacion, no un catalogo.
  constraint business_accounts_one_per_customer unique (customer_id),
  constraint business_accounts_customer_key unique (id, customer_id),
  constraint business_accounts_tenant_key   unique (id, organization_id, company_id)
);

create unique index business_accounts_code_key
  on public.business_accounts (organization_id, company_id, lower(code));
create index business_accounts_tenant_idx on public.business_accounts (organization_id, company_id);
create index business_accounts_customer_idx on public.business_accounts (customer_id);

-- ---------------------------------------------------------------------------
-- business_locations — sucursales y centros de entrega.
--
-- Una empresa no compra "para la empresa": compra para su planta de Arequipa o
-- para su tienda del centro. La sucursal es la unidad que despues explica un
-- pedido, un reparto y un consumo, y sin ella todo el gasto de un cliente
-- grande queda en un solo monton.
--
-- La direccion es opcional y apunta a `customer_addresses`: no se duplica el
-- domicilio, porque una direccion escrita dos veces se corrige una vez.
-- ---------------------------------------------------------------------------
create table public.business_locations (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null,
  company_id          uuid        not null,
  business_account_id uuid        not null,
  -- Denormalizada para que la FK de la direccion pueda exigir que sea del
  -- MISMO cliente. Amarrada a la cuenta por FK compuesta: no se puede mentir.
  customer_id         uuid        not null,
  code                text        not null,
  name                text        not null,
  address_id          uuid,
  is_default          boolean     not null default false,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint business_locations_code_fmt
    check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$'),
  constraint business_locations_name_len check (char_length(btrim(name)) between 1 and 160),
  constraint business_locations_account_fk foreign key (business_account_id, customer_id)
    references public.business_accounts (id, customer_id) on delete cascade,
  constraint business_locations_tenant_fk
    foreign key (business_account_id, organization_id, company_id)
    references public.business_accounts (id, organization_id, company_id) on delete cascade,
  -- La direccion tiene que ser del cliente de esta cuenta.
  constraint business_locations_address_fk foreign key (address_id, customer_id)
    references public.customer_addresses (id, customer_id) on delete set null (address_id),
  constraint business_locations_account_key unique (id, business_account_id)
);

create unique index business_locations_code_key
  on public.business_locations (business_account_id, lower(code));
create unique index business_locations_one_default
  on public.business_locations (business_account_id) where is_default;
create index business_locations_tenant_idx on public.business_locations (organization_id, company_id);
create index business_locations_address_idx
  on public.business_locations (address_id) where address_id is not null;

-- ---------------------------------------------------------------------------
-- business_account_users — EL VINCULO. Aqui vive la regla 8 de la fase.
--
-- «Acceso a una business account requiere vinculo servidor, no ID declarada por
-- browser.» Esta tabla ES ese vinculo, y por eso ninguna funcion de esta
-- migracion acepta una cuenta como parametro sin comprobarla contra ella:
-- `my_business_accounts()` no recibe ningun argumento y deriva TODO de
-- `ebim.user_id()`.
--
-- `user_id` es el `sub` del JWT y NO tiene FK a `auth.users`: la identidad la
-- emite el hub (contrato §2), no esta base. Una FK aqui ataria el portal al
-- proveedor de identidad de hoy, que es exactamente lo que la definicion de
-- hecho de la fase prohibe.
-- ---------------------------------------------------------------------------
create table public.business_account_users (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null,
  company_id          uuid        not null,
  business_account_id uuid        not null,
  user_id             uuid        not null,
  email               text        not null,
  role                public.business_role not null default 'buyer',
  -- Limite de gasto por persona. NULL = sin limite propio; manda el de la
  -- cuenta. Es "por monto" desde el principio porque anadirlo despues obliga a
  -- migrar pedidos ya aprobados sin limite.
  spending_limit      numeric(14,2),
  status              public.member_status not null default 'invited',
  default_location_id uuid,
  invited_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint business_account_users_email_fmt check (position('@' in email) > 1),
  constraint business_account_users_limit_sign
    check (spending_limit is null or spending_limit >= 0),
  -- Contrato §13: `@ebim.pe` no es actor de negocio de un tenant. Un operador
  -- de la suite dentro de la cuenta B2B de un cliente compraria en su nombre.
  constraint business_account_users_not_suite
    check (position('@ebim.pe' in lower(email)) = 0),
  constraint business_account_users_account_fk
    foreign key (business_account_id, organization_id, company_id)
    references public.business_accounts (id, organization_id, company_id) on delete cascade,
  constraint business_account_users_location_fk
    foreign key (default_location_id, business_account_id)
    references public.business_locations (id, business_account_id)
    on delete set null (default_location_id),
  -- Una persona, un vinculo por cuenta. Sin esto el mismo usuario podria tener
  -- dos filas con roles distintos y "cual manda" seria el orden de las filas.
  constraint business_account_users_unique unique (business_account_id, user_id)
);

create index business_account_users_user_idx
  on public.business_account_users (user_id, status);
create index business_account_users_account_idx
  on public.business_account_users (business_account_id);
create index business_account_users_tenant_idx
  on public.business_account_users (organization_id, company_id);
create index business_account_users_email_idx
  on public.business_account_users (lower(email));

-- ---------------------------------------------------------------------------
-- approval_rules — el fundamento de la autorizacion por monto.
--
-- Una fila dice: «a partir de este importe hace falta que apruebe alguien con
-- este rol». Gana la de mayor `min_amount` alcanzado, igual que una escala de
-- precio: de 0, 500 y 5000, un pedido de 800 cae en la de 500.
--
-- La unicidad de `(cuenta, min_amount)` no es prolijidad: dos reglas para el
-- mismo umbral serian una ambiguedad que ningun orden de filas resuelve, y el
-- resultado dependeria del plan de ejecucion — el mismo error que P04 persiguio
-- en la precedencia de precios.
-- ---------------------------------------------------------------------------
create table public.approval_rules (
  id                  uuid          primary key default gen_random_uuid(),
  organization_id     uuid          not null,
  company_id          uuid          not null,
  business_account_id uuid          not null,
  name                text          not null,
  min_amount          numeric(14,2) not null default 0,
  approver_role       public.business_role not null default 'approver',
  is_active           boolean       not null default true,
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),
  constraint approval_rules_name_len   check (char_length(btrim(name)) between 1 and 120),
  constraint approval_rules_amount_sign check (min_amount >= 0),
  -- Un `viewer` no puede ser el aprobador: no puede ni ver un pedido en curso.
  constraint approval_rules_approver_can_act check (approver_role <> 'viewer'),
  constraint approval_rules_account_fk
    foreign key (business_account_id, organization_id, company_id)
    references public.business_accounts (id, organization_id, company_id) on delete cascade,
  constraint approval_rules_one_per_amount unique (business_account_id, min_amount)
);

create index approval_rules_account_idx
  on public.approval_rules (business_account_id, min_amount desc) where is_active;
create index approval_rules_tenant_idx on public.approval_rules (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create trigger business_accounts_set_updated_at before update on public.business_accounts
  for each row execute function ebim.set_updated_at();
create trigger business_locations_set_updated_at before update on public.business_locations
  for each row execute function ebim.set_updated_at();
create trigger business_account_users_set_updated_at before update on public.business_account_users
  for each row execute function ebim.set_updated_at();
create trigger approval_rules_set_updated_at before update on public.approval_rules
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- ebim.business_role_of — que rol tiene EL QUE PREGUNTA en esta cuenta.
--
-- `SECURITY DEFINER` con la autorizacion dentro (leccion esupplier-030): la
-- funcion solo responde sobre `ebim.user_id()`. No hay forma de preguntar por
-- otra persona porque no hay parametro para decir cual, que es la unica version
-- de esta garantia que no depende de que el llamante se porte bien.
--
-- Definer ademas porque los usuarios B2B NO tienen policies sobre estas tablas:
-- un comprador de un cliente no es miembro del tenant y `can_access` le
-- devuelve `false`. Su unica puerta es esta.
-- ---------------------------------------------------------------------------
create or replace function ebim.business_role_of(p_business_account_id uuid)
returns public.business_role
language sql
stable
security definer
set search_path = ''
as $fn$
  select u.role
  from public.business_account_users u
  join public.business_accounts a on a.id = u.business_account_id
  where u.business_account_id = p_business_account_id
    and u.user_id = ebim.user_id()
    and u.status  = 'active'
    and a.is_active
  limit 1;
$fn$;

/** ¿El que pregunta esta vinculado a esta cuenta? Nunca "por confianza". */
create or replace function ebim.is_business_member(p_business_account_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select ebim.user_id() is not null
     and ebim.business_role_of(p_business_account_id) is not null;
$fn$;

-- ---------------------------------------------------------------------------
-- public.my_business_accounts — el contexto de cuenta del usuario.
--
-- SIN PARAMETROS. Es la forma de la regla 8 escrita en la firma: no existe un
-- `p_account_id` que el navegador pueda mandar, asi que no existe la clase de
-- error que consiste en creerselo.
--
-- Devuelve, para cada cuenta a la que el usuario esta vinculado y activa: la
-- cuenta, su rol, su limite, las sucursales y las direcciones del cliente. Todo
-- eso es informacion de SU empresa; lo que NO sale de aqui es nada del tenant
-- que vende —ni precios, ni otros clientes, ni ids internos de tienda—.
-- ---------------------------------------------------------------------------
create or replace function public.my_business_accounts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(item order by item ->> 'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'account_id',              a.id,
      'code',                    a.code,
      'name',                    a.name,
      'customer_name',           c.name,
      'customer_kind',           c.kind,
      'role',                    u.role,
      'status',                  u.status,
      'spending_limit',          case when u.spending_limit is null then null
                                      else u.spending_limit::text end,
      'requires_approval',       a.requires_approval,
      'approval_threshold',      case when a.approval_threshold is null then null
                                      else a.approval_threshold::text end,
      'purchase_order_required', a.purchase_order_required,
      'default_location_id',     u.default_location_id,
      'locations', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id',         l.id,
                 'code',       l.code,
                 'name',       l.name,
                 'is_default', l.is_default,
                 'address_id', l.address_id
               ) order by l.name)
        from public.business_locations l
        where l.business_account_id = a.id and l.is_active
      ), '[]'::jsonb),
      'addresses', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id',                  ad.id,
                 'label',               ad.label,
                 'recipient',           ad.recipient,
                 'line1',               ad.line1,
                 'line2',               ad.line2,
                 'city',                ad.city,
                 'region',              ad.region,
                 'postal_code',         ad.postal_code,
                 'country',             ad.country,
                 'is_shipping',         ad.is_shipping,
                 'is_billing',          ad.is_billing,
                 'is_default_shipping', ad.is_default_shipping,
                 'is_default_billing',  ad.is_default_billing,
                 'verification',        ad.verification
               ) order by ad.is_default_shipping desc, ad.label)
        from public.customer_addresses ad
        where ad.customer_id = c.id and ad.is_active
      ), '[]'::jsonb)
    ) as item
    from public.business_account_users u
    join public.business_accounts a on a.id = u.business_account_id
    join public.customers        c on c.id = a.customer_id
    where u.user_id = ebim.user_id()
      and u.status  = 'active'
      and a.is_active
      and c.is_active
  ) accounts;
$fn$;

-- ---------------------------------------------------------------------------
-- public.purchase_approval — ¿este importe necesita que alguien lo apruebe?
--
-- Funcion PURA de decision, sin efectos: no crea una solicitud, no notifica y
-- no cambia un estado. Es el fundamento sobre el que se monta el flujo cuando
-- toque, y hoy sirve para lo que el portal necesita de verdad — avisar ANTES de
-- comprar, en vez de dejar que el comprador descubra el limite al confirmar.
--
-- Tres motivos, y se evaluan en este orden porque el mas especifico manda:
--   1. `user_limit`      — el importe pasa del limite personal del comprador.
--   2. `rule`            — hay una regla de la cuenta cuyo umbral se alcanza.
--   3. `account_threshold` — la cuenta exige aprobacion (desde su umbral, o
--      siempre si no tiene umbral).
--
-- Autorizacion DENTRO: o el que pregunta esta vinculado a la cuenta, o es
-- miembro del tenant que la administra. Cualquier otro recibe 42501, no una
-- respuesta vacia: preguntar por una cuenta ajena es un error del llamante, no
-- un resultado.
-- ---------------------------------------------------------------------------
create or replace function public.purchase_approval(
  p_business_account_id uuid,
  p_amount              numeric
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_account public.business_accounts%rowtype;
  v_user    public.business_account_users%rowtype;
  v_rule    public.approval_rules%rowtype;
  v_amount  numeric(14,2) := round(coalesce(p_amount, 0), 2);
begin
  if v_amount < 0 then
    raise exception 'MONTO_INVALIDO: el importe no puede ser negativo' using errcode = '22023';
  end if;

  select * into v_account
  from public.business_accounts a
  where a.id = p_business_account_id;

  if not found then
    raise exception 'CUENTA_NO_ENCONTRADA: la cuenta no existe' using errcode = '22023';
  end if;

  select * into v_user
  from public.business_account_users u
  where u.business_account_id = v_account.id
    and u.user_id = ebim.user_id()
    and u.status  = 'active';

  if not found
     and not ebim.can_access(v_account.organization_id, v_account.company_id) then
    raise exception 'SIN_PERMISO: esta cuenta no es del usuario' using errcode = '42501';
  end if;

  select * into v_rule
  from public.approval_rules r
  where r.business_account_id = v_account.id
    and r.is_active
    and r.min_amount <= v_amount
  order by r.min_amount desc
  limit 1;

  return jsonb_build_object(
    'business_account_id', v_account.id,
    'amount',              v_amount::text,
    'required',
      (v_user.spending_limit is not null and v_amount > v_user.spending_limit)
      or v_rule.id is not null
      or (v_account.requires_approval
          and (v_account.approval_threshold is null or v_amount >= v_account.approval_threshold)),
    'reason', case
      when v_user.spending_limit is not null and v_amount > v_user.spending_limit then 'user_limit'
      when v_rule.id is not null then 'rule'
      when v_account.requires_approval
       and (v_account.approval_threshold is null or v_amount >= v_account.approval_threshold)
        then 'account_threshold'
    end,
    'rule_id',        v_rule.id,
    'rule_name',      v_rule.name,
    'rule_min_amount', case when v_rule.id is null then null else v_rule.min_amount::text end,
    'approver_role',  v_rule.approver_role,
    'user_limit',     case when v_user.spending_limit is null then null
                           else v_user.spending_limit::text end,
    'purchase_order_required', v_account.purchase_order_required
  );
end;
$fn$;

revoke execute on function
  ebim.business_role_of(uuid),
  ebim.is_business_member(uuid),
  public.my_business_accounts(),
  public.purchase_approval(uuid, numeric)
from public, anon;

-- `authenticated` a secas: el usuario B2B no es miembro del tenant y aun asi
-- tiene que poder preguntar por SU cuenta. La autorizacion no la da el GRANT,
-- la da el cuerpo de la funcion.
grant execute on function
  ebim.business_role_of(uuid),
  ebim.is_business_member(uuid),
  public.my_business_accounts(),
  public.purchase_approval(uuid, numeric)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS · default deny en las cuatro tablas.
--
-- Escritura: rol (`owner`/`admin`) **Y** capacidad `customers.b2b`. Los dos
-- ejes, igual que el motor de precios: un `admin` de un tenant que no contrato
-- el portal no crea cuentas, y un `orders` de uno que si lo contrato, tampoco
-- —dar de alta a un comprador de una empresa es dar acceso, no atender un
-- pedido—.
--
-- Lectura: solo `ebim.can_access`, sin capacidad. Si un tenant deja de pagar el
-- modulo, sus cuentas dejan de poder gestionarse pero se siguen VIENDO: la
-- misma decision que P04 tomo con las listas de precio, y por la misma razon
-- —esconderlas convertiria una baja comercial en una perdida de datos
-- aparente—.
--
-- **Los usuarios B2B no tienen ni una policy aqui, y es deliberado.** No son
-- miembros del tenant: para ellos `can_access` es `false` y PostgREST no les
-- devuelve una sola fila de ninguna de estas tablas. Su unica puerta es
-- `my_business_accounts()`, que no acepta el id de la cuenta. Darles policies
-- habria significado exponer las tablas del backoffice a un publico externo
-- para ahorrarse una funcion.
-- ---------------------------------------------------------------------------
alter table public.business_accounts      enable row level security;
alter table public.business_accounts      force  row level security;
alter table public.business_locations     enable row level security;
alter table public.business_locations     force  row level security;
alter table public.business_account_users enable row level security;
alter table public.business_account_users force  row level security;
alter table public.approval_rules         enable row level security;
alter table public.approval_rules         force  row level security;

revoke all on public.business_accounts      from public, anon, authenticated;
revoke all on public.business_locations     from public, anon, authenticated;
revoke all on public.business_account_users from public, anon, authenticated;
revoke all on public.approval_rules         from public, anon, authenticated;

grant select, insert, update, delete on public.business_accounts      to authenticated;
grant select, insert, update, delete on public.business_locations     to authenticated;
grant select, insert, update, delete on public.business_account_users to authenticated;
grant select, insert, update, delete on public.approval_rules         to authenticated;

grant all on public.business_accounts, public.business_locations,
             public.business_account_users, public.approval_rules
  to service_role;

create policy business_accounts_select_member on public.business_accounts
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy business_accounts_insert_admin on public.business_accounts
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy business_accounts_update_admin on public.business_accounts
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy business_accounts_delete_admin on public.business_accounts
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy business_locations_select_member on public.business_locations
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy business_locations_insert_admin on public.business_locations
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy business_locations_update_admin on public.business_locations
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy business_locations_delete_admin on public.business_locations
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy business_account_users_select_member on public.business_account_users
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy business_account_users_insert_admin on public.business_account_users
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy business_account_users_update_admin on public.business_account_users
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy business_account_users_delete_admin on public.business_account_users
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy approval_rules_select_member on public.approval_rules
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy approval_rules_insert_admin on public.approval_rules
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy approval_rules_update_admin on public.approval_rules
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

create policy approval_rules_delete_admin on public.approval_rules
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'customers.b2b')
  );

-- ---------------------------------------------------------------------------
comment on table public.business_accounts is
  'Portal B2B activado sobre un cliente EMPRESA. Es una activacion, no un catalogo: una cuenta por cliente.';
comment on column public.business_accounts.customer_kind is
  'Denormalizada con CHECK y FK a customers (id, kind): una cuenta corporativa sobre una persona fisica es un estado imposible.';
comment on column public.business_accounts.approval_threshold is
  'Desde que importe hace falta aprobacion. NULL con requires_approval = siempre.';
comment on table public.business_locations is
  'Sucursales y centros de entrega de la cuenta. La direccion se referencia, no se duplica.';
comment on table public.business_account_users is
  'EL VINCULO usuario <-> cuenta. Sin FK a auth.users: la identidad la emite el hub, no esta base.';
comment on column public.business_account_users.spending_limit is
  'Limite de gasto por persona. NULL = sin limite propio; manda el de la cuenta.';
comment on table public.approval_rules is
  'Fundamento de la autorizacion por monto: desde que importe y quien aprueba. Sin flujo, sin estados y sin notificaciones.';
comment on function public.my_business_accounts() is
  'Contexto de cuenta del usuario autenticado. SIN parametros a proposito: el vinculo lo pone el servidor, nunca el navegador.';
comment on function public.purchase_approval(uuid, numeric) is
  'Decision pura: si un importe necesita aprobacion y por que motivo. No crea solicitudes ni cambia estados.';
