-- =============================================================================
-- P10 · Limite de tasa del checkout anonimo
-- 22/22 — `create_order` es la unica puerta abierta a internet sin sesion, y se
--         sirve con `service_role`. Hasta aqui la unica barrera era que el
--         pedido no puede falsificar precios ni tenant: nada impedia crear
--         pedidos basura en masa, que ademas DESCUENTAN STOCK y consumen el
--         contador de numero de pedido de la tienda.
--
-- El limite vive en la BASE y no en la Edge Function a proposito: la funcion
-- corre con `service_role` y podria reintentarse, desplegarse mal o invocarse
-- desde otro sitio. En la base, la transaccion que crea el pedido es la misma
-- que cuenta el intento, asi que no hay ventana entre contar y crear.
--
-- Politica por defecto (configurable por tienda en `store_settings.config`):
--   · 5 pedidos por correo y hora
--   · 20 pedidos por tienda y hora
-- Un comercio real no roza esos numeros; un bot los agota en segundos.
-- =============================================================================

create table public.checkout_attempts (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  -- Correo normalizado del intento. No se guarda IP: el servidor no la recibe
  -- de forma fiable y seria un dato personal mas que custodiar sin necesidad.
  customer_email  text        not null,
  succeeded       boolean     not null default false,
  created_at      timestamptz not null default now(),
  constraint checkout_attempts_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index checkout_attempts_tenant on public.checkout_attempts (organization_id, company_id);
create index checkout_attempts_window on public.checkout_attempts (store_id, created_at desc);
create index checkout_attempts_email  on public.checkout_attempts (store_id, customer_email, created_at desc);

-- ---------------------------------------------------------------------------
-- Limpieza: la tabla es un contador con ventana, no una bitacora. Sin purga
-- crece sin fin y los indices se degradan justo en la ruta mas caliente.
-- ---------------------------------------------------------------------------
create or replace function public.purge_checkout_attempts(p_older_than interval default '24 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_deleted integer;
begin
  delete from public.checkout_attempts
   where created_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

revoke execute on function public.purge_checkout_attempts(interval) from public, anon, authenticated;
grant  execute on function public.purge_checkout_attempts(interval) to service_role;

-- ---------------------------------------------------------------------------
-- El guard, invocado desde `create_order` dentro de su transaccion.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_checkout_allowed(
  p_store_id uuid,
  p_email    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store       public.stores%rowtype;
  v_config      jsonb;
  v_max_email   integer;
  v_max_store   integer;
  v_count_email integer;
  v_count_store integer;
begin
  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    return; -- `create_order` ya valido la tienda; aqui no se decide eso.
  end if;

  select coalesce(ss.config, '{}'::jsonb) into v_config
  from public.store_settings ss where ss.store_id = p_store_id;

  -- Configurable por tienda sin migracion: una tienda con campaña puntual sube
  -- el techo desde Configuracion en vez de esperar a un despliegue.
  v_max_email := coalesce((v_config -> 'checkout_rate_limit' ->> 'per_email_hour')::integer, 5);
  v_max_store := coalesce((v_config -> 'checkout_rate_limit' ->> 'per_store_hour')::integer, 20);

  -- 0 desactiva el limite para esa dimension (escape deliberado y explicito).
  if v_max_email > 0 then
    select count(*) into v_count_email
    from public.checkout_attempts a
    where a.store_id = p_store_id
      and a.customer_email = p_email
      and a.created_at > now() - interval '1 hour';

    if v_count_email >= v_max_email then
      raise exception 'LIMITE_DE_PEDIDOS: demasiados pedidos desde este correo en la ultima hora'
        using errcode = '22023';
    end if;
  end if;

  if v_max_store > 0 then
    select count(*) into v_count_store
    from public.checkout_attempts a
    where a.store_id = p_store_id
      and a.created_at > now() - interval '1 hour';

    if v_count_store >= v_max_store then
      raise exception 'LIMITE_DE_PEDIDOS: la tienda ha recibido demasiados pedidos en la ultima hora'
        using errcode = '22023';
    end if;
  end if;

  insert into public.checkout_attempts
    (organization_id, company_id, store_id, customer_email, succeeded)
  values (v_store.organization_id, v_store.company_id, p_store_id, p_email, true);
end;
$fn$;

revoke execute on function ebim.assert_checkout_allowed(uuid, text) from public, anon, authenticated;
grant  execute on function ebim.assert_checkout_allowed(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- RLS — la tabla no la lee nadie desde el cliente
-- ---------------------------------------------------------------------------
alter table public.checkout_attempts enable row level security;
alter table public.checkout_attempts force  row level security;

revoke all on public.checkout_attempts from public, anon, authenticated;
grant all  on public.checkout_attempts to service_role;

-- Solo lectura, y solo para el tenant: sirve para diagnosticar un pico, no para
-- operar. Sin INSERT/UPDATE/DELETE ni para `authenticated`: quien cuenta los
-- intentos es la funcion, y un contador que el cliente pueda tocar no cuenta.
grant select on public.checkout_attempts to authenticated;

create policy checkout_attempts_select_member on public.checkout_attempts
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

comment on table public.checkout_attempts is
  'Contador con ventana del checkout anonimo. No es bitacora: se purga con purge_checkout_attempts.';
comment on function ebim.assert_checkout_allowed(uuid, text) is
  'Guard de tasa del checkout. Cuenta y crea en la MISMA transaccion que el pedido: no hay ventana entre contar y crear.';
