-- =============================================================================
-- P02-SaaS · Capacidades, entitlements y flags tecnicos
--
-- Tres ejes que hasta hoy estaban confundidos en una sola palabra:
--
--   1. PERMISO     — que puede hacer un ROL dentro de lo que la cuenta tiene.
--                    Ya existia: `ebim.has_role` + `public.app_role`.
--   2. ENTITLEMENT — que MODULO contrato la cuenta. Lo decide el HUB
--                    (contrato EBIM §5/§6): catalogo de addons y activacion por
--                    sociedad viven en `platform.*`, no aqui. Esta base guarda
--                    una CACHE de esa respuesta, que es exactamente lo que el
--                    §7 asigna a cada app: «Lectura de addons/config (cache del
--                    context)».
--   3. FLAG        — interruptor TECNICO local: despliegue progresivo, corte de
--                    emergencia. No es comercial y no puede conceder nada.
--
-- Regla de composicion, identica aqui y en TypeScript:
--     capacidad efectiva = app activa AND (baseline OR entitlement activo)
--                                     AND (baseline OR flag distinto de false)
-- Un flag NUNCA concede: solo puede apagar lo ya contratado. Si un flag pudiera
-- encender un modulo, seria un sistema de facturacion en la sombra dentro de la
-- pantalla de ajustes del propio cliente.
--
-- Lo que este archivo NO hace, a proposito:
--   · no crea catalogo comercial (planes, precios, nombres de addon): eso es
--     del hub y duplicarlo es lo que prohibe el principio 2 del contrato;
--   · no usa `plan` para decidir nada — se guarda solo para diagnostico;
--   · no deja que el tenant se conceda un entitlement: `tenant_entitlements` no
--     tiene una sola policy de escritura para `authenticated`.
-- =============================================================================

create type public.entitlement_source as enum ('hub', 'provisioning');

-- ---------------------------------------------------------------------------
-- app_capabilities — registro TECNICO del producto, global, no dato de tenant.
--
-- Mismo patron que `integration_providers` (150000): que eCommerce sepa llevar
-- multi-almacen es una capacidad del PRODUCTO; que una sociedad la tenga es
-- otra cosa y vive en `tenant_entitlements`.
--
-- `entitlement_code` es el codigo de addon del hub que concede la capacidad.
-- NULL = baseline (viene con el producto, no se vende aparte). El prefijo
-- `ecommerce.` es la convencion propuesta y esta PENDIENTE de que el operador
-- de de alta la app y su catalogo en el hub (SAAS_ROADMAP §5.1): hasta
-- entonces estos codigos son los que espera esta app, no los que el hub
-- confirma. Cambiarlos despues es un UPDATE de una columna, no una migracion
-- de datos de tenant.
-- ---------------------------------------------------------------------------
create table public.app_capabilities (
  code             text        primary key,
  -- Frontera de `src/domain/boundaries.ts` a la que pertenece. Sirve para que
  -- una capacidad no pueda inventarse un dominio que el mapa no declara.
  boundary         text        not null,
  is_baseline      boolean     not null default false,
  entitlement_code text        unique,
  -- Verdad sobre el producto HOY, no intencion: `implemented`, `partial` o
  -- `declared`. Una capacidad `declared` se puede contratar y gatear, pero
  -- todavia no hay pantalla detras.
  state            text        not null default 'declared',
  created_at       timestamptz not null default now(),
  constraint app_capabilities_code_fmt check (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  constraint app_capabilities_ent_fmt
    check (entitlement_code is null or entitlement_code ~ '^[a-z][a-z0-9._-]{2,60}$'),
  constraint app_capabilities_state check (state in ('implemented', 'partial', 'declared')),
  -- Baseline y entitlement son excluyentes: lo que viene con el producto no se
  -- vende, y lo que se vende no viene con el producto. Sin esto se puede
  -- escribir una fila que es las dos cosas y la resolucion se vuelve ambigua.
  constraint app_capabilities_baseline_xor_code
    check ((is_baseline and entitlement_code is null) or (not is_baseline and entitlement_code is not null))
);

insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state) values
  -- Baseline: lo que cualquier tenant con eCommerce activo tiene.
  ('catalog',                  'catalog',      true,  null, 'implemented'),
  ('storefront',               'content',      true,  null, 'implemented'),
  ('checkout',                 'checkout',     true,  null, 'implemented'),
  ('orders',                   'orders',       true,  null, 'implemented'),
  ('analytics.basic',          'analytics',    true,  null, 'implemented'),
  -- Vendibles: exigen entitlement del hub.
  ('catalog.advanced',         'catalog',      false, 'ecommerce.catalog.advanced',         'declared'),
  ('pricing.lists',            'pricing',      false, 'ecommerce.pricing.lists',            'declared'),
  ('customers.b2b',            'customers',    false, 'ecommerce.customers.b2b',            'declared'),
  ('inventory.multiwarehouse', 'inventory',    false, 'ecommerce.inventory.multiwarehouse', 'declared'),
  ('payments',                 'payments',     false, 'ecommerce.payments',                 'declared'),
  ('promotions',               'promotions',   false, 'ecommerce.promotions',               'declared'),
  ('content.cms',              'content',      false, 'ecommerce.content.cms',              'declared'),
  -- Marca blanca: el contrato §4.3 ya la declara addon premium de suite, asi
  -- que no se inventa nada. Es la unica vendible con superficie real hoy.
  ('content.white_label',      'content',      false, 'ecommerce.content.white_label',      'implemented'),
  ('fulfillment',              'fulfillment',  false, 'ecommerce.fulfillment',              'declared'),
  ('analytics.advanced',       'analytics',    false, 'ecommerce.analytics.advanced',       'declared'),
  ('integrations.enterprise',  'integrations', false, 'ecommerce.integrations.enterprise',  'partial');

-- ---------------------------------------------------------------------------
-- tenant_platform_context — cache de la respuesta del Platform Context API (§5).
--
-- `app_active` y `plan` son del hub. `plan` se guarda SOLO para diagnostico:
-- ninguna funcion de este archivo lo lee para decidir. Mapear plan → modulos
-- aqui seria replicar el catalogo comercial del hub, que es justo lo prohibido.
--
-- Fila ausente = todavia no se sincronizo nunca. Se lee como «app activa, sin
-- entitlements»: el tenant conserva lo baseline y no obtiene ni un modulo
-- vendible. Cerrar tambien lo baseline dejaria sin catalogo a todo tenant ya
-- dado de alta el dia que esta migracion se aplique, que es un fallo peor y
-- menos diagnosticable que el que evitaria.
-- ---------------------------------------------------------------------------
create table public.tenant_platform_context (
  organization_id uuid        not null,
  company_id      uuid        not null,
  app_active      boolean     not null default true,
  plan            text,
  source          public.entitlement_source not null,
  synced_at       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, company_id),
  constraint tenant_platform_context_plan_len
    check (plan is null or char_length(btrim(plan)) between 1 and 60)
);

create trigger tenant_platform_context_set_updated_at
  before update on public.tenant_platform_context
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_entitlements — que addons tiene ACTIVOS cada sociedad, segun el hub.
--
-- Sin FK contra `app_capabilities`: el hub puede devolver codigos que esta app
-- no conoce todavia (o de otra app de la suite). Se guardan igual y la
-- resolucion los ignora; el area de diagnostico los muestra como «no
-- reconocidos», que es como se detecta un desfase de catalogo en vez de
-- perderlo en silencio.
-- ---------------------------------------------------------------------------
create table public.tenant_entitlements (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null,
  company_id       uuid        not null,
  entitlement_code text        not null,
  is_active        boolean     not null default true,
  source           public.entitlement_source not null,
  synced_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tenant_entitlements_unique unique (organization_id, company_id, entitlement_code),
  constraint tenant_entitlements_code_fmt check (entitlement_code ~ '^[a-z][a-z0-9._-]{2,60}$')
);

create index tenant_entitlements_tenant_idx
  on public.tenant_entitlements (organization_id, company_id) where is_active;

create trigger tenant_entitlements_set_updated_at
  before update on public.tenant_entitlements
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_feature_flags — interruptores TECNICOS del tenant.
--
-- Separados de los entitlements por diseno (no por prolijidad): tienen otro
-- dueno (el administrador del tenant, no el hub), otra vida (se apagan en
-- caliente) y otro poder (solo restan). Un flag cuya clave coincide con el
-- codigo de una capacidad vendible actua de corte de emergencia sobre ella.
--
-- No pueden apagar lo baseline: un interruptor capaz de dejar sin catalogo a la
-- tienda desde la propia pantalla de ajustes es un boton de caida, no una
-- opcion. La regla la aplica `ebim.has_capability`, no un CHECK, porque la
-- fila puede existir para un flag que no es una capacidad.
-- ---------------------------------------------------------------------------
create table public.tenant_feature_flags (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  flag_key        text        not null,
  is_enabled      boolean     not null,
  note            text,
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint tenant_feature_flags_unique unique (organization_id, company_id, flag_key),
  constraint tenant_feature_flags_key_fmt
    check (flag_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  constraint tenant_feature_flags_note_len
    check (note is null or char_length(note) <= 240)
);

create index tenant_feature_flags_tenant_idx
  on public.tenant_feature_flags (organization_id, company_id);

create trigger tenant_feature_flags_set_updated_at
  before update on public.tenant_feature_flags
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- ebim.company_is_entitled — ¿la SOCIEDAD tiene el modulo? Sin mirar quien
-- pregunta.
--
-- Separada de `has_capability` porque hay un llamante legitimo que no tiene
-- membresia: el propio servidor sincronizando (`sync_platform_context`). Mezclar
-- las dos preguntas obligaria a ese camino a saltarse la comprobacion entera.
--
-- SECURITY INVOKER: lee `tenant_entitlements` bajo la RLS del llamante, asi que
-- preguntar por la sociedad de al lado devuelve `false` por falta de filas, no
-- por cortesia. Lo unico que un `authenticated` puede sacar de aqui sobre otro
-- tenant es que las capacidades baseline existen, que es metadato del producto.
-- ---------------------------------------------------------------------------
create or replace function ebim.company_is_entitled(
  p_organization_id uuid,
  p_company_id uuid,
  p_capability text
)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select coalesce(
           (select ctx.app_active
              from public.tenant_platform_context ctx
             where ctx.organization_id = p_organization_id
               and ctx.company_id      = p_company_id),
           true)
     and exists (
       select 1
         from public.app_capabilities cap
        where cap.code = p_capability
          and (
            cap.is_baseline
            or (
              exists (
                select 1
                  from public.tenant_entitlements ent
                 where ent.organization_id  = p_organization_id
                   and ent.company_id       = p_company_id
                   and ent.entitlement_code = cap.entitlement_code
                   and ent.is_active
              )
              and coalesce(
                (select flag.is_enabled
                   from public.tenant_feature_flags flag
                  where flag.organization_id = p_organization_id
                    and flag.company_id      = p_company_id
                    and flag.flag_key        = cap.code),
                true)
            )
          )
     );
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.has_capability — LA autoridad de gating. La de la UI es cortesia.
--
-- Pertenencia Y capacidad, en ese orden: una capacidad nunca sustituye al JWT,
-- lo acompana. Un `admin` sin el addon no puede, y un tenant con el addon pero
-- sin membresia en esa sociedad, tampoco.
-- ---------------------------------------------------------------------------
create or replace function ebim.has_capability(
  p_organization_id uuid,
  p_company_id uuid,
  p_capability text
)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select ebim.can_access(p_organization_id, p_company_id)
     and ebim.company_is_entitled(p_organization_id, p_company_id, p_capability);
$fn$;

-- NO hay un `assert_capability` que levante excepcion. Se escribio y se quito:
-- hoy el enforcement vive donde tiene que vivir, en las policies, y una funcion
-- que nadie llama es una interfaz muerta con permisos que mantener (misma regla
-- que ADR 001 §3 aplica a los puertos). La primera funcion de servidor que
-- necesite cortar por capacidad la trae consigo, con su test.

/** Lista de capacidades baseline. La comparan los tests contra TypeScript. */
create or replace function ebim.baseline_capabilities()
returns text[]
language sql
stable
set search_path = ''
as $fn$
  select coalesce(array_agg(code order by code), '{}'::text[])
    from public.app_capabilities
   where is_baseline;
$fn$;

-- ---------------------------------------------------------------------------
-- public.effective_capabilities — lo que la app lee para pintar.
--
-- `p_company_id` es ALCANCE, no autorizacion: el selector de sociedad del
-- backoffice puede estar en una sociedad distinta de `active_company` del
-- claim, pero siempre dentro de `companies[]`. Quien decide sigue siendo el
-- JWT — `can_access` se comprueba antes de devolver una sola fila, y sin
-- acceso se levanta 'SIN_PERMISO', no se devuelve una lista vacia que la UI
-- confundiria con «no contrataste nada».
-- ---------------------------------------------------------------------------
create or replace function public.effective_capabilities(p_company_id uuid default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_org      uuid := ebim.org_id();
  v_company  uuid := coalesce(p_company_id, ebim.active_company());
  v_context  public.tenant_platform_context;
  v_result   jsonb;
begin
  if v_org is null or v_company is null then
    raise exception 'SIN_PERMISO: el token no trae la jerarquia de tenant';
  end if;
  if not ebim.can_access(v_org, v_company) then
    raise exception 'SIN_PERMISO: la sociedad no pertenece a este usuario';
  end if;

  select * into v_context
    from public.tenant_platform_context ctx
   where ctx.organization_id = v_org and ctx.company_id = v_company;

  select jsonb_build_object(
    'organization_id', v_org,
    'company_id',      v_company,
    -- `sin-contexto` no es un detalle cosmetico: distingue «el hub dice que no
    -- tienes el modulo» de «nunca hablamos con el hub», y son dos incidencias
    -- distintas para quien da soporte.
    'source',          coalesce(v_context.source::text, 'sin-contexto'),
    'app_active',      coalesce(v_context.app_active, true),
    'plan',            v_context.plan,
    'synced_at',       v_context.synced_at,
    'entitlements',    coalesce((
      select jsonb_agg(ent.entitlement_code order by ent.entitlement_code)
        from public.tenant_entitlements ent
       where ent.organization_id = v_org and ent.company_id = v_company and ent.is_active
    ), '[]'::jsonb),
    'flags',           coalesce((
      select jsonb_object_agg(flag.flag_key, flag.is_enabled)
        from public.tenant_feature_flags flag
       where flag.organization_id = v_org and flag.company_id = v_company
    ), '{}'::jsonb),
    'capabilities',    coalesce((
      select jsonb_agg(cap.code order by cap.code)
        from public.app_capabilities cap
       where ebim.has_capability(v_org, v_company, cap.code)
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.sync_platform_context — UNICA puerta de escritura de entitlements.
--
-- La llama el borde (`platform-context`) con `service_role`, nunca el
-- navegador. Reemplaza el conjunto entero de forma atomica: un addon que el hub
-- deja de devolver se APAGA aqui, que es la mitad que se olvida cuando se
-- sincroniza con upserts sueltos y produce el tenant que sigue usando lo que ya
-- no paga.
--
-- Se desactiva en vez de borrar: quien da soporte necesita ver que ese modulo
-- estuvo activo hasta ayer.
-- ---------------------------------------------------------------------------
create or replace function public.sync_platform_context(
  p_organization_id uuid,
  p_company_id uuid,
  p_app_active boolean,
  p_entitlements text[],
  p_source public.entitlement_source,
  p_plan text default null
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  v_codes text[] := coalesce(p_entitlements, '{}'::text[]);
  v_code  text;
begin
  if p_organization_id is null or p_company_id is null then
    raise exception 'EBIM_TENANT_REQUERIDO: falta organizacion o sociedad';
  end if;

  foreach v_code in array v_codes loop
    if v_code !~ '^[a-z][a-z0-9._-]{2,60}$' then
      raise exception 'ENTITLEMENT_INVALIDO: el codigo % no tiene forma de addon', v_code;
    end if;
  end loop;

  insert into public.tenant_platform_context
    (organization_id, company_id, app_active, plan, source, synced_at)
  values
    (p_organization_id, p_company_id, coalesce(p_app_active, true), p_plan, p_source, now())
  on conflict (organization_id, company_id) do update
    set app_active = excluded.app_active,
        plan       = excluded.plan,
        source     = excluded.source,
        synced_at  = excluded.synced_at;

  insert into public.tenant_entitlements
    (organization_id, company_id, entitlement_code, is_active, source, synced_at)
  select p_organization_id, p_company_id, code, true, p_source, now()
    from unnest(v_codes) as code
  on conflict (organization_id, company_id, entitlement_code) do update
    set is_active = true,
        source    = excluded.source,
        synced_at = excluded.synced_at;

  update public.tenant_entitlements
     set is_active = false, synced_at = now()
   where organization_id = p_organization_id
     and company_id      = p_company_id
     and is_active
     and not (entitlement_code = any (v_codes));

  -- Un addon retirado APAGA SU EFECTO, no solo el botón de encenderlo.
  --
  -- La marca blanca es la única capacidad vendible con un efecto persistido en
  -- otra tabla (`store_settings.white_label`, contrato §4.3). Sin esto, una
  -- cuenta que deja de pagar el addon conserva la vitrina sin la firma de la
  -- suite para siempre, porque la policy solo impide ENCENDERLO. Aquí se apaga
  -- en la misma transacción en la que el hub dice que ya no lo tiene.
  --
  -- No se toca en el sentido contrario: recuperar el addon no vuelve a
  -- encender la marca blanca sola. Encenderla es una decisión del tenant.
  if not ebim.company_is_entitled(p_organization_id, p_company_id, 'content.white_label') then
    update public.store_settings
       set white_label = false
     where organization_id = p_organization_id
       and company_id      = p_company_id
       and white_label;
  end if;

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'company_id',      p_company_id,
    'app_active',      coalesce(p_app_active, true),
    'entitlements',    to_jsonb(v_codes),
    'source',          p_source
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
alter table public.app_capabilities        enable row level security;
alter table public.app_capabilities        force  row level security;
alter table public.tenant_platform_context enable row level security;
alter table public.tenant_platform_context force  row level security;
alter table public.tenant_entitlements     enable row level security;
alter table public.tenant_entitlements     force  row level security;
alter table public.tenant_feature_flags    enable row level security;
alter table public.tenant_feature_flags    force  row level security;

revoke all on public.app_capabilities        from public, anon, authenticated;
revoke all on public.tenant_platform_context from public, anon, authenticated;
revoke all on public.tenant_entitlements     from public, anon, authenticated;
revoke all on public.tenant_feature_flags    from public, anon, authenticated;

grant all on public.app_capabilities, public.tenant_platform_context,
             public.tenant_entitlements, public.tenant_feature_flags
  to service_role;

-- El registro de capacidades es metadato de producto, no dato de tenant: se
-- lee, no se escribe desde la app. `anon` no lo necesita: la vitrina publica no
-- gatea por capacidad, gatea por lo que la vista publica expone.
grant select on public.app_capabilities to authenticated;

-- Entitlements y contexto: SOLO LECTURA para el backoffice. No hay policy de
-- escritura y tampoco GRANT, que son las dos capas. Un administrador del tenant
-- no puede concederse un modulo desde su propia sesion.
grant select on public.tenant_platform_context to authenticated;
grant select on public.tenant_entitlements     to authenticated;

-- Flags: el administrador del tenant SI los maneja. Es lo unico de las cuatro
-- tablas que le pertenece.
grant select, insert, update, delete on public.tenant_feature_flags to authenticated;

create policy app_capabilities_select on public.app_capabilities
  for select to authenticated using (true);

create policy tenant_platform_context_select_member on public.tenant_platform_context
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy tenant_entitlements_select_member on public.tenant_entitlements
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy tenant_feature_flags_select_member on public.tenant_feature_flags
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy tenant_feature_flags_insert_admin on public.tenant_feature_flags
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tenant_feature_flags_update_admin on public.tenant_feature_flags
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy tenant_feature_flags_delete_admin on public.tenant_feature_flags
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

revoke execute on function
  ebim.company_is_entitled(uuid, uuid, text),
  ebim.has_capability(uuid, uuid, text),
  ebim.baseline_capabilities(),
  public.effective_capabilities(uuid),
  public.sync_platform_context(uuid, uuid, boolean, text[], public.entitlement_source, text)
from public, anon;

-- `company_is_entitled` entra en la lista por la misma razon que `safe_uuid` en
-- la migracion 090000: `has_capability` la llama y NO es SECURITY DEFINER, asi
-- que el permiso lo necesita el llamador. Sin esto, toda policy que pregunte
-- por una capacidad falla con «permission denied for function».
grant execute on function
  ebim.company_is_entitled(uuid, uuid, text),
  ebim.has_capability(uuid, uuid, text),
  ebim.baseline_capabilities(),
  public.effective_capabilities(uuid)
to authenticated, service_role;

-- La escritura del contexto es del SERVIDOR y de nadie mas. Ni `authenticated`
-- ni `anon` la pueden ejecutar aunque adivinen la firma (leccion esupplier-030).
grant execute on function
  public.sync_platform_context(uuid, uuid, boolean, text[], public.entitlement_source, text)
to service_role;

-- ---------------------------------------------------------------------------
-- Enforcement en las dos superficies que HOY existen y son vendibles.
--
-- El gating visual no es seguridad. Estas dos policies son lo que hace que
-- apagar un modulo signifique algo aunque el atacante hable PostgREST directo
-- desde la consola del navegador con su propio token.
-- ---------------------------------------------------------------------------

-- 1) Marca blanca (contrato §4.3, addon premium de suite). Se puede seguir
--    editando todo el branding sin el addon; lo unico que exige capacidad es
--    dejar `white_label` en true. El `using` no la pide: si no, un tenant al
--    que se le retira el addon no podria ni apagar la marca blanca que tiene.
drop policy store_settings_write_admin  on public.store_settings;
drop policy store_settings_update_admin on public.store_settings;

create policy store_settings_write_admin on public.store_settings
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and (
      not white_label
      or ebim.has_capability(organization_id, company_id, 'content.white_label')
    )
  );

create policy store_settings_update_admin on public.store_settings
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and (
      not white_label
      or ebim.has_capability(organization_id, company_id, 'content.white_label')
    )
  );

-- 2) Integraciones enterprise. Habilitar un conector de ERP, de pasarela o de
--    facturacion es el modulo `integrations.enterprise`; el catalogo de
--    proveedores se sigue LEYENDO sin el, porque saber que existe el conector
--    es justo lo que hace que alguien lo contrate.
drop policy tenant_integrations_insert_admin on public.tenant_integrations;
drop policy tenant_integrations_update_admin on public.tenant_integrations;

create policy tenant_integrations_insert_admin on public.tenant_integrations
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'integrations.enterprise')
  );

create policy tenant_integrations_update_admin on public.tenant_integrations
  for update to authenticated
  using  (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'integrations.enterprise')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'integrations.enterprise')
  );

comment on table public.app_capabilities is
  'Registro tecnico de capacidades del producto eCommerce. NO es catalogo comercial: el catalogo de addons y su precio viven en el hub (contrato §6).';
comment on table public.tenant_entitlements is
  'Cache local de los addons activos que el hub declara para cada sociedad (contrato §5/§7). Escritura solo desde el servidor.';
comment on table public.tenant_feature_flags is
  'Interruptores tecnicos del tenant. Solo restan: nunca conceden una capacidad no contratada.';
