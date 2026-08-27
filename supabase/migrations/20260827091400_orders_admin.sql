-- =============================================================================
-- P07 · 01/02 — Gestión de pedidos desde el backoffice: BITÁCORA de estados.
--
-- El listado y el detalle de pedidos ya se pueden leer con las policies de P02
-- (`orders_select_member`, `order_items_select_member`). Lo que faltaba para
-- gestionar de verdad es el HISTORIAL: quién movió el pedido, cuándo y desde
-- qué estado. Sin eso, "el pedido está cancelado" es un dato sin autor.
--
-- Tres decisiones que gobiernan este archivo:
--
--  1. **La bitácora la escribe un TRIGGER, no la aplicación.** Así el historial
--     no puede desviarse de la realidad: se escribe en la MISMA transacción que
--     el UPDATE que ya validaron la RLS (`orders_update_orders_role`) y el
--     trigger de máquina de estados. Un cambio de estado sin evento, o un
--     evento sin cambio de estado, son estados imposibles, no bugs a vigilar.
--
--  2. **Append-only de verdad, no "por convención".** La tabla no tiene GRANT
--     de INSERT/UPDATE/DELETE para `anon` ni para `authenticated`, ni policy
--     que los habilite: la única escritura viene de una función SECURITY
--     DEFINER (regla de CLAUDE.md para bitácoras, y lección `esupplier-030`:
--     un COMMENT que dice "append-only" no impide nada). Es el mismo patrón
--     que `orders` + `create_order` en P02.
--
--  3. **El actor sale del JWT, nunca de un parámetro.** Si no hay JWT —el alta
--     del comprador anónimo por `create-order`— el actor queda NULL y la
--     pantalla lo lee como "pedido recibido de la tienda", que es la verdad.
-- =============================================================================

create table public.order_status_events (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  order_id        uuid        not null,
  -- NULL = alta del pedido. El primer evento de todo pedido es "nace en pending".
  from_status     public.order_status,
  to_status       public.order_status not null,
  note            text,
  actor_id        uuid,
  actor_email     text,
  created_at      timestamptz not null default now(),
  constraint order_status_events_note_len  check (note is null or char_length(note) <= 1000),
  constraint order_status_events_email_len check (actor_email is null or char_length(actor_email) <= 320),
  -- Un evento que no cambia nada es ruido: la bitácora solo guarda transiciones.
  constraint order_status_events_change    check (from_status is distinct from to_status),
  constraint order_status_events_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade,
  constraint order_status_events_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete restrict
);
create index order_status_events_order_idx  on public.order_status_events (order_id, created_at);
create index order_status_events_tenant_idx on public.order_status_events (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- El escritor único de la bitácora.
--
-- `security definer` porque la tabla no da INSERT a nadie; `search_path = ''`
-- para que ningún esquema del llamador se cuele. El tenant del evento se copia
-- de la FILA del pedido (que ya lo tiene amarrado por FK a `stores`), no de un
-- argumento: aquí no hay forma de escribir un evento en el tenant de al lado.
-- ---------------------------------------------------------------------------
create or replace function ebim.log_order_status_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_from public.order_status;
  v_note text;
begin
  if tg_op = 'UPDATE' then
    -- `after update of status` también dispara cuando el UPDATE menciona la
    -- columna sin cambiarla (es el caso de `update-order-status` cuando solo
    -- se edita la nota). Un evento ahí sería un cambio de estado que no ocurrió.
    if new.status is not distinct from old.status then
      return null;
    end if;
    v_from := old.status;
    v_note := case when new.notes is distinct from old.notes then new.notes end;
  else
    v_from := null;
    v_note := new.notes;
  end if;

  insert into public.order_status_events (
    organization_id, company_id, store_id, order_id,
    from_status, to_status, note, actor_id, actor_email
  )
  values (
    new.organization_id, new.company_id, new.store_id, new.id,
    v_from, new.status,
    nullif(left(btrim(coalesce(v_note, '')), 1000), ''),
    ebim.user_id(),
    left(ebim.email(), 320)
  );

  return null;
end;
$fn$;

create trigger orders_log_status_created
  after insert on public.orders
  for each row execute function ebim.log_order_status_event();

create trigger orders_log_status_changed
  after update of status on public.orders
  for each row execute function ebim.log_order_status_event();

-- Nadie llama a esta función a mano: Postgres comprueba el EXECUTE del trigger
-- al CREARLO, no al dispararlo, así que revocarlo no lo rompe y sí cierra la
-- puerta a inventar un evento invocándola con un `select`.
revoke execute on function ebim.log_order_status_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS · bitácora. Lectura para el tenant, escritura para nadie.
-- ---------------------------------------------------------------------------
alter table public.order_status_events enable row level security;
alter table public.order_status_events force  row level security;

revoke all on public.order_status_events from public, anon, authenticated;

grant select on public.order_status_events to authenticated;
grant all    on public.order_status_events to service_role;

create policy order_status_events_select_member on public.order_status_events
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

comment on table public.order_status_events is
  'Bitacora append-only de transiciones de estado. Escritura EXCLUSIVA del trigger SECURITY DEFINER ebim.log_order_status_event; sin GRANT ni policy de INSERT/UPDATE/DELETE para anon ni authenticated.';
comment on column public.order_status_events.actor_id is
  'sub del JWT. NULL = alta por create-order (comprador anonimo): no se inventa un autor.';
