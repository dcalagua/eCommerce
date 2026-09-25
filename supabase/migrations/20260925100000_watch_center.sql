-- =============================================================================
-- Centro de vigilancia — «qué está en rojo ahora mismo», de todos los módulos
--
-- `public.watch_findings(p_store_id)` junta en UNA lista las señales críticas
-- que cada módulo ya calcula por su cuenta: pedidos sin cobrar, pagados sin
-- despachar, inventario en negativo o bajo punto de pedido, entregas vencidas o
-- fallidas, deuda vencida, catálogo sin publicar, disyuntores abiertos e
-- incidentes críticos sin resolver.
--
-- Cuatro reglas:
--
-- 1. **Determinista.** Cada hallazgo sale de SQL, no de un modelo: la cifra, la
--    severidad y el umbral son reglas escritas aquí y auditables. La IA, cuando
--    se le pide, solo ORDENA y explica lo que esta función ya encontró; nunca
--    inventa un hallazgo ni una cifra.
-- 2. **SECURITY INVOKER.** Ve exactamente lo que la RLS deja ver a quien llama.
--    Cada sección exige además el ROL que administra ese módulo y que la
--    sociedad lo tenga CONTRATADO: el panel no habla de lo que la persona no
--    puede abrir.
-- 3. **Sin texto libre.** Devuelve `code`, cifras y referencias cortas; los
--    títulos los pone la pantalla, traducidos. Una frase en español dentro de
--    la base sería una frase que el inglés no tiene.
-- 4. **Descartar es del equipo, no del sistema.** `watch_dismissals` guarda QUÉ
--    se descartó, con qué cifra y quién lo hizo. Si la cifra cambia, el aviso
--    vuelve: silenciar «13 pedidos sin cobrar» no puede silenciar los 20 de
--    mañana.
-- =============================================================================

create table if not exists public.watch_dismissals (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  -- El aviso es de una tienda o de la sociedad entera (cobranza, integraciones).
  store_id        uuid,
  finding_key     text        not null,
  -- La CIFRA con la que se descartó. Si cambia, el aviso vuelve a aparecer.
  fingerprint     text        not null,
  dismissed_by    uuid,
  dismissed_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Un descarte caduca: un problema silenciado para siempre es un problema que
  -- nadie vuelve a ver.
  expires_at      timestamptz not null default now() + interval '7 days',
  constraint watch_dismissals_key_fmt check (finding_key ~ '^[a-z][a-z0-9_.]{2,60}$'),
  constraint watch_dismissals_fp_len check (char_length(fingerprint) between 1 and 80)
);

create unique index if not exists watch_dismissals_unique
  on public.watch_dismissals (organization_id, company_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid), finding_key);
create index if not exists watch_dismissals_live
  on public.watch_dismissals (organization_id, company_id, expires_at);

alter table public.watch_dismissals enable row level security;
alter table public.watch_dismissals force row level security;

-- Default deny: solo miembros de la sociedad, y escribir exige además uno de
-- los roles que administran algún módulo vigilado.
create policy watch_dismissals_select_member on public.watch_dismissals
  for select to authenticated
  using (organization_id = (select ebim.org_id())
         and company_id = any ((select ebim.member_companies())::uuid[]));

create policy watch_dismissals_write_member on public.watch_dismissals
  for all to authenticated
  using (organization_id = (select ebim.org_id())
         and company_id = any ((select ebim.has_role_companies(
               array['owner', 'admin', 'orders', 'catalog']::public.app_role[]))::uuid[]))
  with check (organization_id = (select ebim.org_id())
              and company_id = any ((select ebim.has_role_companies(
                    array['owner', 'admin', 'orders', 'catalog']::public.app_role[]))::uuid[]));

create trigger watch_dismissals_set_updated_at
  before update on public.watch_dismissals
  for each row execute function ebim.set_updated_at();

grant select, insert, update, delete on public.watch_dismissals to authenticated;
grant all on public.watch_dismissals to service_role;

comment on table public.watch_dismissals is
  'Avisos del centro de vigilancia silenciados por el equipo, con la cifra que tenían al descartarlos y su caducidad.';

-- ---------------------------------------------------------------------------
-- Los hallazgos
-- ---------------------------------------------------------------------------
create or replace function public.watch_findings(p_store_id uuid default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_org      uuid := ebim.org_id();
  v_company  uuid := ebim.active_company();
  v_now      timestamptz := now();
  v_today    date := current_date;
  v_items    jsonb := '[]'::jsonb;
  v_muted    jsonb := '[]'::jsonb;
  v_commerce boolean;
  v_catalog  boolean;
  v_admin    boolean;
  v_n        bigint;
  v_days     integer;
  v_extra    jsonb;
begin
  if v_org is null or v_company is null then
    raise exception 'SIN_PERMISO: el token no trae la jerarquia de tenant' using errcode = '42501';
  end if;
  if p_store_id is not null and not exists (
    select 1 from public.stores s
     where s.id = p_store_id and s.organization_id = v_org and s.company_id = v_company
  ) then
    raise exception 'SIN_PERMISO: esa tienda no es de tu sociedad' using errcode = '42501';
  end if;

  v_admin    := ebim.has_role(v_org, v_company, array['owner', 'admin']::public.app_role[]);
  v_commerce := ebim.has_role(v_org, v_company, array['owner', 'admin', 'orders']::public.app_role[]);
  v_catalog  := ebim.has_role(v_org, v_company, array['owner', 'admin', 'catalog', 'orders']::public.app_role[]);

  -- --- Pedidos -------------------------------------------------------------
  if v_commerce then
    select count(*), coalesce(max(floor(extract(epoch from (v_now - o.placed_at)) / 86400))::int, 0)
      into v_n, v_days
      from public.orders o
     where o.organization_id = v_org and o.company_id = v_company
       and (p_store_id is null or o.store_id = p_store_id)
       and o.status = 'pending' and o.payment_status = 'pending'
       and o.placed_at < v_now - interval '3 days';
    if v_n > 0 then
      select coalesce(jsonb_agg(jsonb_build_object(
               'label', left(a.order_number, 40),
               'days', floor(extract(epoch from (v_now - a.placed_at)) / 86400)::int) order by a.placed_at), '[]'::jsonb)
        into v_extra
        from (
          select o.order_number, o.placed_at
            from public.orders o
           where o.organization_id = v_org and o.company_id = v_company
             and (p_store_id is null or o.store_id = p_store_id)
             and o.status = 'pending' and o.payment_status = 'pending'
             and o.placed_at < v_now - interval '3 days'
           order by o.placed_at
           limit 3
        ) a;
      -- Diez pedidos sin cobrar, o uno parado más de una semana, ya no es un
      -- aviso: es dinero que no entra.
      v_items := v_items || ebim.watch_item(
        'orders.unpaid', 'orders',
        case when v_n >= 10 or v_days >= 7 then 'critica' else 'advertencia' end,
        v_n, jsonb_build_object('count', v_n, 'oldest_days', v_days), v_extra, '/app/orders');
    end if;

    select count(*), coalesce(max(floor(extract(epoch from (v_now - o.placed_at)) / 86400))::int, 0)
      into v_n, v_days
      from public.orders o
     where o.organization_id = v_org and o.company_id = v_company
       and (p_store_id is null or o.store_id = p_store_id)
       and o.status = 'paid' and o.fulfillment_status = 'unfulfilled'
       and o.placed_at < v_now - interval '2 days';
    if v_n > 0 then
      v_items := v_items || ebim.watch_item(
        'orders.paid_unshipped', 'orders',
        case when v_days >= 5 then 'critica' else 'advertencia' end,
        v_n, jsonb_build_object('count', v_n, 'oldest_days', v_days), '[]'::jsonb, '/app/orders');
    end if;

    select count(*) into v_n
      from public.orders o
     where o.organization_id = v_org and o.company_id = v_company
       and (p_store_id is null or o.store_id = p_store_id)
       and o.approval_status = 'pending';
    if v_n > 0 then
      v_items := v_items || ebim.watch_item(
        'orders.awaiting_approval', 'orders', 'advertencia',
        v_n, jsonb_build_object('count', v_n), '[]'::jsonb, '/app/orders');
    end if;
  end if;

  -- --- Inventario ----------------------------------------------------------
  if v_catalog and ebim.company_is_entitled(v_org, v_company, 'inventory.multiwarehouse') then
    select count(*) filter (where a.kind = 'negative'),
           coalesce(jsonb_agg(jsonb_build_object('label', left(a.sku, 40), 'qty', round(a.available_qty, 2)::text)
                              order by a.available_qty) filter (where a.kind = 'negative'), '[]'::jsonb)
      into v_n, v_extra
      from public.inventory_alerts a
     where a.organization_id = v_org and a.company_id = v_company
       and (p_store_id is null or a.store_id = p_store_id);
    if v_n > 0 then
      -- Existencia en negativo es un dato que ya no cuadra con el almacén: se
      -- vende lo que no hay.
      v_items := v_items || ebim.watch_item(
        'inventory.negative', 'inventory', 'critica',
        v_n, jsonb_build_object('count', v_n), ebim.watch_sample(v_extra), '/app/inventory');
    end if;

    select count(*) filter (where a.kind = 'below_reorder'),
           coalesce(jsonb_agg(jsonb_build_object('label', left(a.sku, 40), 'qty', round(a.available_qty, 2)::text)
                              order by a.available_qty - a.reorder_point) filter (where a.kind = 'below_reorder'), '[]'::jsonb)
      into v_n, v_extra
      from public.inventory_alerts a
     where a.organization_id = v_org and a.company_id = v_company
       and (p_store_id is null or a.store_id = p_store_id);
    if v_n > 0 then
      v_items := v_items || ebim.watch_item(
        'inventory.below_reorder', 'inventory',
        case when v_n >= 10 then 'critica' else 'advertencia' end,
        v_n, jsonb_build_object('count', v_n), ebim.watch_sample(v_extra), '/app/inventory');
    end if;
  end if;

  -- --- Entregas ------------------------------------------------------------
  if v_commerce and ebim.company_is_entitled(v_org, v_company, 'fulfillment') then
    select count(*), coalesce(max(v_today - f.promised_to), 0)
      into v_n, v_days
      from public.fulfillment_overview f
     where f.organization_id = v_org and f.company_id = v_company
       and (p_store_id is null or f.store_id = p_store_id)
       and f.state not in ('delivered', 'cancelled', 'failed')
       and f.promised_to is not null and f.promised_to < v_today;
    if v_n > 0 then
      v_items := v_items || ebim.watch_item(
        'fulfillment.overdue', 'fulfillment',
        case when v_days >= 3 or v_n >= 10 then 'critica' else 'advertencia' end,
        v_n, jsonb_build_object('count', v_n, 'days_late', v_days), '[]'::jsonb, '/app/fulfillment');
    end if;

    select count(*) into v_n
      from public.fulfillment_overview f
     where f.organization_id = v_org and f.company_id = v_company
       and (p_store_id is null or f.store_id = p_store_id)
       and f.state = 'failed';
    if v_n > 0 then
      v_items := v_items || ebim.watch_item(
        'fulfillment.failed', 'fulfillment', 'critica',
        v_n, jsonb_build_object('count', v_n), '[]'::jsonb, '/app/fulfillment');
    end if;
  end if;

  -- --- Cobranza (de la sociedad: los documentos no son de una tienda) -------
  if v_admin and ebim.company_is_entitled(v_org, v_company, 'credit.management') then
    select count(*), coalesce(max(v_today - d.due_at), 0)
      into v_n, v_days
      from public.ar_documents d
     where d.organization_id = v_org and d.company_id = v_company
       and d.kind <> 'credit_note' and d.balance > 0 and d.due_at < v_today;
    if v_n > 0 then
      v_items := v_items || ebim.watch_item(
        'credit.overdue', 'credit',
        case when v_days >= 30 then 'critica' else 'advertencia' end,
        v_n, jsonb_build_object('count', v_n, 'days_overdue', v_days), '[]'::jsonb, '/app/credit');
    end if;
  end if;

  -- --- Catálogo ------------------------------------------------------------
  if v_catalog and p_store_id is not null then
    select count(*) into v_n
      from public.store_products sp
     where sp.organization_id = v_org and sp.company_id = v_company
       and sp.store_id = p_store_id and sp.status <> 'published';
    if v_n > 0 then
      v_items := v_items || ebim.watch_item(
        'catalog.unpublished', 'catalog', 'advertencia',
        v_n, jsonb_build_object('count', v_n), '[]'::jsonb, '/app/products');
    end if;
  end if;

  -- --- Plataforma: integraciones y operación -------------------------------
  if v_admin then
    select count(*) into v_n
      from public.integration_circuit c
     where c.organization_id = v_org and c.company_id = v_company and c.state <> 'closed';
    if v_n > 0 then
      -- Un disyuntor abierto es una integración que dejó de intentarlo: nada
      -- sale hacia el otro sistema hasta que alguien lo cierre.
      v_items := v_items || ebim.watch_item(
        'integrations.circuit_open', 'integrations', 'critica',
        v_n, jsonb_build_object('count', v_n), '[]'::jsonb, '/app/integrations');
    end if;

    select count(*) into v_n
      from public.ops_events e
     where e.organization_id = v_org and e.company_id = v_company
       and (p_store_id is null or e.store_id = p_store_id or e.store_id is null)
       and e.severity = 'critical'
       and e.occurred_at >= v_now - interval '24 hours';
    if v_n > 0 then
      v_items := v_items || ebim.watch_item(
        'ops.critical_events', 'ops', 'critica',
        v_n, jsonb_build_object('count', v_n, 'window_hours', 24), '[]'::jsonb, '/app/ops');
    end if;
  end if;

  -- --- Silenciados ---------------------------------------------------------
  -- Se apartan, no se borran: la pantalla dice cuántos hay escondidos y desde
  -- cuándo, porque un panel que oculta sin decirlo enseña una calma falsa.
  select coalesce(jsonb_agg(item) filter (where not silenciado), '[]'::jsonb),
         coalesce(jsonb_agg(item) filter (where silenciado), '[]'::jsonb)
    into v_items, v_muted
    from (
      select e.item,
             exists (
               select 1 from public.watch_dismissals d
                where d.organization_id = v_org and d.company_id = v_company
                  and d.store_id is not distinct from p_store_id
                  and d.finding_key = e.item ->> 'key'
                  and d.fingerprint = e.item ->> 'fingerprint'
                  and d.expires_at > v_now
             ) as silenciado
        from jsonb_array_elements(v_items) as e(item)
    ) s;

  return jsonb_build_object(
    'generated_at', v_now,
    'store_id', p_store_id,
    'critical', (select count(*) from jsonb_array_elements(v_items) as e(item) where e.item ->> 'severity' = 'critica'),
    'total', jsonb_array_length(v_items),
    'items', v_items,
    'dismissed', v_muted);
end;
$fn$;

comment on function public.watch_findings(uuid) is
  'Señales críticas de todos los módulos, calculadas por SQL y filtradas por rol y módulo contratado. La IA solo las ordena y explica.';

-- Un hallazgo, con la MISMA forma siempre. La huella es la cifra: si cambia, un
-- descarte viejo deja de taparlo.
create or replace function ebim.watch_item(
  p_key      text,
  p_module   text,
  p_severity text,
  p_count    bigint,
  p_metrics  jsonb,
  p_samples  jsonb,
  p_href     text
)
returns jsonb
language sql
immutable
set search_path = ''
as $fn$
  select jsonb_build_array(jsonb_build_object(
    'key', p_key,
    'module', p_module,
    'severity', p_severity,
    'count', p_count,
    'fingerprint', p_count::text,
    'metrics', coalesce(p_metrics, '{}'::jsonb),
    'samples', coalesce(p_samples, '[]'::jsonb),
    'href', p_href));
$fn$;

/** Como mucho tres ejemplos: la lista es para reconocer el problema, no para trabajarlo. */
create or replace function ebim.watch_sample(p_rows jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $fn$
  select coalesce((
    select jsonb_agg(s.item order by s.n)
      from (
        select e.item, e.ord as n
          from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as e(item, ord)
      ) s
     where s.n <= 3
  ), '[]'::jsonb);
$fn$;

-- ---------------------------------------------------------------------------
-- Silenciar y devolver
-- ---------------------------------------------------------------------------
create or replace function public.watch_dismiss(
  p_key         text,
  p_fingerprint text,
  p_store_id    uuid default null,
  p_days        integer default 7
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $fn$
declare
  v_org     uuid := ebim.org_id();
  v_company uuid := ebim.active_company();
  v_days    integer := least(greatest(coalesce(p_days, 7), 1), 30);
  v_row     public.watch_dismissals%rowtype;
begin
  if v_org is null or v_company is null then
    raise exception 'SIN_PERMISO: el token no trae la jerarquia de tenant' using errcode = '42501';
  end if;
  if p_key is null or p_key !~ '^[a-z][a-z0-9_.]{2,60}$' then
    raise exception 'VALOR_INVALIDO: aviso' using errcode = '22023';
  end if;
  if p_fingerprint is null or char_length(p_fingerprint) < 1 or char_length(p_fingerprint) > 80 then
    raise exception 'VALOR_INVALIDO: fingerprint' using errcode = '22023';
  end if;
  if p_store_id is not null and not exists (
    select 1 from public.stores s
     where s.id = p_store_id and s.organization_id = v_org and s.company_id = v_company
  ) then
    raise exception 'SIN_PERMISO: esa tienda no es de tu sociedad' using errcode = '42501';
  end if;

  -- La policy de escritura decide si puede; esto solo da un error legible.
  if not ebim.has_role(v_org, v_company,
                       array['owner', 'admin', 'orders', 'catalog']::public.app_role[]) then
    raise exception 'SIN_PERMISO: silenciar un aviso exige un rol que administre su modulo'
      using errcode = '42501';
  end if;

  insert into public.watch_dismissals
    (organization_id, company_id, store_id, finding_key, fingerprint, dismissed_by, expires_at)
  values
    (v_org, v_company, p_store_id, p_key, p_fingerprint, ebim.user_id(),
     now() + make_interval(days => v_days))
  on conflict (organization_id, company_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid), finding_key)
  do update set fingerprint  = excluded.fingerprint,
                dismissed_by = excluded.dismissed_by,
                dismissed_at = now(),
                expires_at   = excluded.expires_at
  returning * into v_row;

  return jsonb_build_object('key', v_row.finding_key, 'expires_at', v_row.expires_at);
end;
$fn$;

create or replace function public.watch_restore(p_key text, p_store_id uuid default null)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $fn$
declare
  v_org     uuid := ebim.org_id();
  v_company uuid := ebim.active_company();
begin
  if v_org is null or v_company is null then
    raise exception 'SIN_PERMISO: el token no trae la jerarquia de tenant' using errcode = '42501';
  end if;
  delete from public.watch_dismissals d
   where d.organization_id = v_org and d.company_id = v_company
     and d.store_id is not distinct from p_store_id
     and d.finding_key = p_key;
end;
$fn$;

-- Nadie anónimo vigila nada.
revoke all on function public.watch_findings(uuid) from public, anon;
revoke all on function public.watch_dismiss(text, text, uuid, integer) from public, anon;
revoke all on function public.watch_restore(text, uuid) from public, anon;
revoke all on function ebim.watch_item(text, text, text, bigint, jsonb, jsonb, text) from public, anon;
revoke all on function ebim.watch_sample(jsonb) from public, anon;
grant execute on function public.watch_findings(uuid) to authenticated, service_role;
grant execute on function public.watch_dismiss(text, text, uuid, integer) to authenticated;
grant execute on function public.watch_restore(text, uuid) to authenticated;
-- Las dos piezas de ebim solo dan FORMA al hallazgo (no leen nada), pero
-- `watch_findings` es INVOKER: sin este permiso, la vigilancia falla en la
-- primera llamada.
grant execute on function ebim.watch_item(text, text, text, bigint, jsonb, jsonb, text) to authenticated, service_role;
grant execute on function ebim.watch_sample(jsonb) to authenticated, service_role;
