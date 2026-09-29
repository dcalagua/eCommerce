-- =============================================================================
-- Paquete de arranque: un negocio nuevo nace con sus modulos y con la IA activa.
--
-- ## El problema
--
-- `bootstrap_tenant` creaba tenant, owner, tienda y settings, y nada mas. Las
-- capacidades vendibles no son baseline, asi que el negocio recien creado no
-- tenia ni un modulo: ni PIM, ni precios, ni cobros, ni IA. Para que sirviera
-- de algo, el operador tenia que ejecutar `sync_platform_context` a mano
-- despues del alta (guia ALTA_DE_NEGOCIO_EN_DEV.md, paso 5). Quien no lo hacia
-- se quedaba con un backoffice de tres menus y sin un solo boton de IA: le paso
-- a la tienda `biel`, dada de alta cuando esa lista todavia no incluia los
-- codigos de IA.
--
-- ## La regla
--
-- El alta aplica un PAQUETE DE ARRANQUE: la lista de `ebim.starter_entitlements`
-- con origen `provisioning`, mas la fila de cuota de IA. Se aplica solo si la
-- sociedad NO tiene contexto todavia: si el hub o el operador ya dijeron algo
-- sobre ella, manda lo que dijeron y el arranque no pisa nada.
--
-- ## Por que aqui y no en la Edge Function
--
-- Porque el alta es atomica por diseno. Sembrar los modulos desde fuera abre la
-- ventana en la que existe un negocio sin modulos, que es justo el estado que
-- este cambio elimina. Ademas los dos caminos de alta —autoservicio con JWT y
-- aprovisionamiento con clave— pasan por esta funcion, asi que los dos heredan
-- el mismo arranque sin duplicar la lista.
--
-- ## Como se cambia el paquete
--
-- Reemplazando `ebim.starter_entitlements()`. No hay tabla de configuracion a
-- proposito: la lista es una decision de producto que se lee en el repositorio
-- y viaja versionada, no un dato que alguien edita en caliente. Para un negocio
-- concreto, el operador sigue teniendo `sync_platform_context`, que reemplaza
-- la lista entera.
--
-- ## Cuota de IA
--
-- Sin fila en `ai_quotas` la sociedad cae al plan de prueba, 25 usos EN TOTAL
-- (`ai_entitlement`). Contratada la IA y sin cuota, el negocio la agota en una
-- tarde y concluye que «no funciona». El arranque deja plan activo con la cuota
-- mensual por defecto del esquema (500), que es el numero que ya documenta
-- `ai_quotas.monthly_quota`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 · Que trae un negocio nuevo
-- ---------------------------------------------------------------------------
create or replace function ebim.starter_entitlements()
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select array[
    -- Catalogo y precios
    'ecommerce.catalog.advanced',
    'ecommerce.pricing.lists',
    'ecommerce.promotions',
    -- Inventario
    'ecommerce.inventory.multiwarehouse',
    'ecommerce.planning.demand',
    -- Clientes y venta B2B
    'ecommerce.customers.b2b',
    'ecommerce.sales.force',
    'ecommerce.trade.quotes',
    'ecommerce.trade.assortments',
    -- Venta, cobro y entrega
    'ecommerce.orders.advanced',
    'ecommerce.payments',
    'ecommerce.credit.management',
    'ecommerce.fulfillment',
    'ecommerce.invoicing',
    -- Tienda y medicion
    'ecommerce.content.cms',
    'ecommerce.analytics.advanced',
    -- IA
    'ecommerce.ai.assist',
    'ecommerce.ai.catalog.copy',
    'ecommerce.ai.insights',
    'ecommerce.ai.content'
  ]::text[];
$fn$;

comment on function ebim.starter_entitlements() is
  'Modulos con los que nace un negocio, IA incluida. Se cambia reemplazando esta funcion; para un negocio concreto manda sync_platform_context.';

-- ---------------------------------------------------------------------------
-- 2 · Aplicarlo, sin pisar lo que ya dijeron el hub o el operador
-- ---------------------------------------------------------------------------
create or replace function ebim.apply_starter_package(
  p_organization_id uuid,
  p_company_id      uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $fn$
begin
  if p_organization_id is null or p_company_id is null then
    return;
  end if;

  -- Con contexto ya escrito, la sociedad no es nueva para la plataforma: el
  -- arranque no tiene nada que decir sobre ella.
  if exists (
    select 1 from public.tenant_platform_context ctx
     where ctx.organization_id = p_organization_id
       and ctx.company_id      = p_company_id
  ) then
    return;
  end if;

  perform public.sync_platform_context(
    p_organization_id,
    p_company_id,
    true,
    ebim.starter_entitlements(),
    'provisioning'::public.entitlement_source,
    'starter'
  );

  -- `do nothing`: si alguien ya le puso cuota, esa manda.
  insert into public.ai_quotas (organization_id, company_id, plan)
  values (p_organization_id, p_company_id, 'active')
  on conflict (organization_id, company_id) do nothing;
end;
$fn$;

revoke execute on function ebim.starter_entitlements()             from public, anon, authenticated;
revoke execute on function ebim.apply_starter_package(uuid, uuid)  from public, anon, authenticated;
grant  execute on function ebim.starter_entitlements()             to service_role;
grant  execute on function ebim.apply_starter_package(uuid, uuid)  to service_role;

comment on function ebim.apply_starter_package(uuid, uuid) is
  'Da a una sociedad SIN contexto el paquete de arranque y su cuota de IA. Idempotente: con contexto ya escrito no toca nada.';

-- ---------------------------------------------------------------------------
-- 3 · El alta lo aplica, en la misma transaccion
--
-- Copia literal de la definicion vigente (20260827090700) con una sola linea
-- nueva antes del `return`. Se reescribe entera porque `create or replace` no
-- admite parches.
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_tenant(
  p_organization_id uuid,
  p_company_id      uuid,
  p_tenant_slug     text,
  p_tenant_name     text,
  p_admin_email     text,
  p_owner_user_id   uuid,
  p_store_slug      text,
  p_store_name      text,
  p_currency        text default 'PEN'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store_id uuid;
  v_member_id uuid;
  v_email text := lower(btrim(coalesce(p_admin_email, '')));
begin
  if p_organization_id is null or p_company_id is null then
    raise exception 'TENANT_REQUERIDO: organization_id y company_id son obligatorios'
      using errcode = '22023';
  end if;

  -- Contrato §3.2 — sin correo de administrador, el alta no se hace.
  if v_email = '' or position('@' in v_email) < 2 then
    raise exception 'ADMIN_EMAIL_REQUERIDO: el alta de tenant exige el correo de un administrador'
      using errcode = '22023';
  end if;

  if p_owner_user_id is null then
    raise exception 'OWNER_REQUERIDO: el alta de tenant exige el usuario propietario'
      using errcode = '22023';
  end if;

  -- El super admin de suite no es actor de negocio de un tenant (contrato §13).
  if v_email like '%@ebim.pe' then
    raise exception 'ADMIN_EMAIL_INVALIDO: un correo @ebim.pe no puede ser administrador de un tenant'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.tenants t where t.organization_id = p_organization_id) then
    raise exception 'TENANT_YA_EXISTE: la organizacion % ya esta dada de alta', p_organization_id
      using errcode = '23505';
  end if;

  insert into public.tenants (organization_id, slug, name, admin_email)
  values (p_organization_id, lower(btrim(p_tenant_slug)), btrim(p_tenant_name), v_email);

  insert into public.tenant_members
    (organization_id, company_id, user_id, email, role, status)
  values
    (p_organization_id, p_company_id, p_owner_user_id, v_email, 'owner', 'active')
  returning id into v_member_id;

  insert into public.stores
    (organization_id, company_id, slug, name, status, currency)
  values
    (p_organization_id, p_company_id, lower(btrim(p_store_slug)), btrim(p_store_name),
     'draft', upper(coalesce(nullif(btrim(p_currency), ''), 'PEN')))
  returning id into v_store_id;

  insert into public.store_settings (store_id, organization_id, company_id)
  values (v_store_id, p_organization_id, p_company_id);

  -- El negocio nace con su paquete de arranque: modulos e IA. Va DENTRO de la
  -- misma transaccion que el tenant, la membresia y la tienda, asi que o queda
  -- todo o no queda nada.
  perform ebim.apply_starter_package(p_organization_id, p_company_id);

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'company_id',      p_company_id,
    'tenant_slug',     lower(btrim(p_tenant_slug)),
    'admin_email',     v_email,
    'owner_member_id', v_member_id,
    'store_id',        v_store_id,
    'store_slug',      lower(btrim(p_store_slug))
  );
end;
$fn$;

comment on function public.bootstrap_tenant(uuid, uuid, text, text, text, uuid, text, text, text) is
  'Alta atomica tenant + owner + tienda + paquete de arranque (modulos e IA). Exige admin_email (contrato §3.2). Solo service_role.';
