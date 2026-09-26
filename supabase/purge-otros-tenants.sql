-- =============================================================================
-- Dejar el entorno con UNA sola tienda de trabajo: `miquimica`.
--
-- Para que existe: QAS acumulo tiendas de pruebas sucesivas (`biel`,
-- `bata-store`, `botica-cerrada`, `tienda-tenant-b`) y cada una arrastra su
-- catalogo, sus clientes y sus usuarios.
--
-- ## Lo que la base NO deja borrar, y por que esta bien
--
-- Una tienda con ANALITICA no se puede borrar. `analytics_events` es
-- append-only por trigger (`ebim.reject_analytics_rewrite`) y rechaza el
-- borrado incluso a `service_role`; como la tienda cae en cascada sobre esa
-- tabla, el borrado entero aborta. Es la misma garantia del audit log: una
-- bitacora que se puede vaciar no vale como bitacora.
--
-- Por eso el script trata las tiendas en DOS grupos, decidido por los datos y
-- no por una lista escrita a mano:
--
--   · sin analitica  -> se borran enteras;
--   · con analitica  -> se VACIAN (catalogo, clientes, cuentas, modulos) y se
--                       dejan en `suspended`. La vitrina responde 404 y el
--                       backoffice no las lista, pero su historia sigue ahi.
--
-- Lo mismo aguas arriba: la cuenta de una tienda que sobrevive tampoco se
-- borra, porque `stores` cuelga de `tenants` con `on delete cascade` y volveria
-- a chocar con la analitica.
--
-- ## Lo que tampoco hace
--
-- · **No borra pedidos.** Si una tienda a retirar tuviera alguno, ABORTA antes
--   de tocar nada: una tienda con historia de venta se desactiva, no se borra.
-- · **No borra `auth.users`.** Eso se hace en el panel de Authentication; aqui
--   se retiran los vinculos (membresias y compradores), que es lo que ata a una
--   persona al negocio. El script termina listando los correos que quedan sin
--   negocio.
-- · **No es definitivo hacia atras.** Resembrar `seed.sql` vuelve a crear
--   `botica-cerrada`: esa tienda en borrador es un fixture, existe para
--   comprobar que la vitrina responde 404 y no lista lo no publicado.
--
--   node scripts/apply-demo-data.mjs --file supabase/purge-otros-tenants.sql
-- =============================================================================

do $$
declare
  v_tienda      text := 'miquimica';
  v_owner       text := 'emoreno@grupoebim.com';
  v_org_viva    uuid;
  v_pedidos     integer;
  v_borradas    integer;
  v_suspendidas integer;
  v_cuentas     integer;
  v_correos     text;
begin
  select s.organization_id into v_org_viva
  from public.stores s where s.slug = v_tienda;

  if v_org_viva is null then
    raise exception 'La tienda que hay que CONSERVAR (%) no existe: el script no se ejecuta a ciegas', v_tienda;
  end if;

  -- ---- Guarda: ninguna tienda con historia de venta ------------------------
  select count(*) into v_pedidos
  from public.orders o
  join public.stores s on s.id = o.store_id
  where s.slug <> v_tienda;

  if v_pedidos > 0 then
    raise exception 'Hay % pedidos en tiendas que se iban a retirar. Se aborta: una tienda con historia se desactiva, no se borra', v_pedidos;
  end if;

  -- ---- Quien se va, y como ------------------------------------------------
  create temporary table _fuera on commit drop as
  select s.id, s.slug, s.organization_id as org, s.company_id as comp,
         exists (select 1 from public.analytics_events a where a.store_id = s.id) as con_analitica
  from public.stores s
  where s.slug <> v_tienda;

  create temporary table _orgs_fuera on commit drop as
  select distinct org, comp from _fuera where org <> v_org_viva;

  select string_agg(distinct correo, ', ') into v_correos
  from (
    select m.email as correo from public.tenant_members m
     where m.organization_id in (select org from _orgs_fuera)
    union
    select m.email from public.tenant_members m
     where m.organization_id = v_org_viva and lower(m.email) <> lower(v_owner)
    union
    select u.email from public.business_account_users bau
      join public.business_accounts ba on ba.id = bau.business_account_id
      join auth.users u on u.id = bau.user_id
     where ba.company_id in (select comp from _orgs_fuera)
  ) s;

  -- ---- 1 · El catalogo y los clientes de las sociedades que se van ---------
  -- Los productos son MAESTROS de la sociedad y su `store_id` es `set null`:
  -- borrar la tienda los dejaria vivos y huerfanos. Por eso van por sociedad.
  delete from public.variant_attribute_values where company_id in (select comp from _orgs_fuera);
  delete from public.product_attribute_values where company_id in (select comp from _orgs_fuera);
  delete from public.product_uoms             where company_id in (select comp from _orgs_fuera);
  delete from public.product_relations        where company_id in (select comp from _orgs_fuera);
  delete from public.bundle_items             where company_id in (select comp from _orgs_fuera);
  delete from public.product_variants         where company_id in (select comp from _orgs_fuera);
  delete from public.products                 where company_id in (select comp from _orgs_fuera);
  delete from public.attribute_values         where company_id in (select comp from _orgs_fuera);
  delete from public.attributes               where company_id in (select comp from _orgs_fuera);
  delete from public.brands                   where company_id in (select comp from _orgs_fuera);
  delete from public.product_families         where company_id in (select comp from _orgs_fuera);
  delete from public.units_of_measure         where company_id in (select comp from _orgs_fuera);

  delete from public.business_account_users
   where business_account_id in (
     select id from public.business_accounts where company_id in (select comp from _orgs_fuera)
   );
  delete from public.business_accounts        where company_id in (select comp from _orgs_fuera);
  delete from public.customers                where company_id in (select comp from _orgs_fuera);
  delete from public.warehouses               where company_id in (select comp from _orgs_fuera);

  -- ---- 2 · Las tiendas sin analitica, enteras ------------------------------
  delete from public.stores
   where id in (select id from _fuera where not con_analitica);
  get diagnostics v_borradas = row_count;

  -- ---- 3 · Las que tienen analitica: vaciadas y suspendidas ----------------
  update public.stores
     set status = 'suspended'
   where id in (select id from _fuera where con_analitica)
     and status <> 'suspended';
  get diagnostics v_suspendidas = row_count;

  -- ---- 4 · Los modulos y las membresias de las cuentas que se van ----------
  delete from public.ai_quotas               where organization_id in (select org from _orgs_fuera);
  delete from public.tenant_feature_flags    where organization_id in (select org from _orgs_fuera);
  delete from public.tenant_entitlements     where organization_id in (select org from _orgs_fuera);
  delete from public.tenant_platform_context where organization_id in (select org from _orgs_fuera);
  delete from public.tenant_members          where organization_id in (select org from _orgs_fuera);

  -- La cuenta solo se borra si ya no le queda ninguna tienda: `stores` cuelga
  -- de `tenants` en cascada, y con una tienda suspendida viva volveriamos a
  -- chocar contra la analitica.
  delete from public.tenants t
   where t.organization_id in (select org from _orgs_fuera)
     and not exists (select 1 from public.stores s where s.organization_id = t.organization_id);
  get diagnostics v_cuentas = row_count;

  -- ---- 5 · En la sociedad que se queda, solo el owner ----------------------
  delete from public.tenant_members
   where organization_id = v_org_viva
     and lower(email) <> lower(v_owner);

  raise notice 'Tiendas borradas: %. Tiendas vaciadas y suspendidas: %. Cuentas borradas: %.',
    v_borradas, v_suspendidas, v_cuentas;
  raise notice 'Queda % con el owner %.', v_tienda, v_owner;
  raise notice 'Accesos sin negocio, a borrar en Authentication: %', coalesce(v_correos, 'ninguno');
end $$;
