-- =============================================================================
-- P08-SaaS · 3/7 — La linea de tiempo del pedido: un solo relato, inmutable
--
-- ## Por que no basta con `order_status_events`
--
-- Esa tabla (P07 historico) hace bien lo unico que sabe hacer: registrar
-- transiciones de `orders.status`. Desde la migracion 110000 un pedido tiene
-- CUATRO ejes, y ademas hay hechos que no son un cambio de estado y que la
-- operacion necesita ver en el mismo hilo: se corrigio la direccion, se pidio
-- autorizacion, se anoto una referencia externa. Un historial que solo cuenta
-- uno de los cuatro ejes obliga a la pantalla a coser varias fuentes, y el
-- orden entre ellas se vuelve una suposicion del cliente.
--
-- `order_status_events` **no se toca ni se retira**: sigue viva, sigue
-- escribiendose por su trigger y sigue siendo lo que leen las consultas
-- existentes. Lo que hace esta migracion es CONSTRUIR el relato completo encima
-- y traerse el historial que ya existia, para que la pantalla nueva no empiece
-- con la memoria en blanco.
--
-- ## Tres propiedades
--
-- 1. **Un solo escritor.** La tabla no tiene GRANT de INSERT/UPDATE/DELETE para
--    `anon` ni `authenticated`, y el unico que escribe es un trigger
--    `SECURITY DEFINER` sobre `orders`. No hay forma de que la linea de tiempo
--    diga algo distinto de lo que le paso a la fila, porque se escribe en la
--    MISMA transaccion que el cambio (regla de bitacoras de `CLAUDE.md`, y
--    leccion `esupplier-030`: un COMMENT que dice «append-only» no impide nada).
--
-- 2. **El actor sale del JWT.** Nunca de un parametro. Sin JWT —el checkout del
--    comprador anonimo— el actor queda NULL y el `source` es `storefront`, que
--    es la verdad, en vez de atribuirle el pedido a alguien.
--
-- 3. **El motivo viaja por un ajuste LOCAL de transaccion**, no por una
--    columna que alguien pueda dejar desincronizada. `public.order_transition`
--    hace `set_config('ebim.order_event_reason', ..., true)` justo antes de su
--    UPDATE; el trigger lo lee y lo olvida al terminar la transaccion. La
--    alternativa —que el comando inserte su propio evento— permitiria un cambio
--    de estado sin evento el dia que alguien escriba un UPDATE a mano.
-- =============================================================================

-- El eje al que se refiere el evento. NULL en los que no son de estado.
create type public.order_event_axis as enum (
  'order_status',
  'payment_status',
  'fulfillment_status',
  'approval_status'
);

-- De donde vino la accion. `system` es el proceso automatico (caducidades,
-- consumidores del outbox); `storefront`, el comprador.
create type public.order_event_source as enum (
  'storefront',
  'backoffice',
  'system',
  'api',
  'import'
);

create table public.order_events (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  order_id        uuid        not null,
  -- Nombre CANONICO del hecho, en pasado y con el mismo formato que
  -- `domain_events.event_type`: son dos registros del mismo vocabulario.
  event_type      text        not null,
  axis            public.order_event_axis,
  from_value      text,
  to_value        text,
  note            text,
  payload         jsonb       not null default '{}'::jsonb,
  source          public.order_event_source not null default 'system',
  actor_id        uuid,
  actor_email     text,
  created_at      timestamptz not null default now(),
  constraint order_events_type_fmt
    check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint order_events_note_len  check (note is null or char_length(note) <= 1000),
  constraint order_events_email_len check (actor_email is null or char_length(actor_email) <= 320),
  constraint order_events_value_len check (
    (from_value is null or char_length(from_value) <= 60)
    and (to_value is null or char_length(to_value) <= 60)
  ),
  constraint order_events_payload_shape check (jsonb_typeof(payload) = 'object'),
  -- Un evento de eje que no dice a donde fue no explica nada.
  constraint order_events_axis_shape check (axis is null or to_value is not null),
  constraint order_events_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade,
  constraint order_events_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete restrict
);

-- `id` desempata: dos eventos de la misma transaccion comparten `now()` al
-- microsegundo y sin desempate la pantalla los pintaria en orden aleatorio.
create index order_events_order_idx  on public.order_events (order_id, created_at, id);
create index order_events_tenant_idx on public.order_events (organization_id, company_id);
create index order_events_type_idx   on public.order_events (store_id, event_type, created_at desc);

-- ---------------------------------------------------------------------------
-- ebim.order_event_context — que dijo el llamante sobre esta accion
--
-- Lee los dos ajustes locales que puede poner un comando. `true` en
-- `current_setting` significa «si no existe, devuelve NULL en vez de fallar»:
-- un UPDATE directo desde el backoffice no pone ninguno y tiene que funcionar
-- igual.
-- ---------------------------------------------------------------------------
create or replace function ebim.order_event_reason()
returns text
language sql
stable
set search_path = ''
as $fn$
  select nullif(left(btrim(coalesce(current_setting('ebim.order_event_reason', true), '')), 1000), '');
$fn$;

-- El origen por defecto se DEDUCE y no se pregunta: si hay JWT, la accion la
-- hizo una persona del backoffice; si no lo hay, fue el comprador. Un comando
-- puede decir otra cosa (`api`, `import`, `system`) poniendo el ajuste.
create or replace function ebim.order_event_source()
returns public.order_event_source
language sql
stable
set search_path = ''
as $fn$
  select coalesce(
    -- Se comprueba contra las etiquetas del enum ANTES de convertir: un ajuste
    -- con un valor inventado tiene que ignorarse, no reventar el UPDATE que
    -- de verdad importa.
    (select v.label::public.order_event_source
       from unnest(enum_range(null::public.order_event_source)) as v(label)
      where v.label::text = btrim(coalesce(current_setting('ebim.order_event_source', true), ''))),
    case when ebim.user_id() is null then 'storefront' else 'backoffice' end
      ::public.order_event_source
  );
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.log_order_timeline — el escritor UNICO de la linea de tiempo
--
-- Un solo trigger para el alta y para todos los cambios. Emite una fila POR
-- EJE que se movio: un UPDATE que aprueba y cobra a la vez deja dos eventos,
-- porque son dos hechos distintos aunque compartan transaccion.
-- ---------------------------------------------------------------------------
create or replace function ebim.log_order_timeline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_reason text := ebim.order_event_reason();
  v_source public.order_event_source := ebim.order_event_source();
  v_actor  uuid := ebim.user_id();
  v_email  text := left(ebim.email(), 320);
  v_note   text;
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (
      organization_id, company_id, store_id, order_id,
      event_type, axis, from_value, to_value, note, payload, source, actor_id, actor_email
    ) values (
      new.organization_id, new.company_id, new.store_id, new.id,
      'order.created', 'order_status', null, new.status::text,
      coalesce(v_reason, nullif(btrim(coalesce(new.notes, '')), '')),
      jsonb_build_object(
        'order_number',       new.order_number,
        'source_channel',     new.source_channel,
        'currency',           new.currency,
        'grand_total',        new.grand_total::text,
        'payment_status',     new.payment_status,
        'fulfillment_status', new.fulfillment_status,
        'approval_status',    new.approval_status),
      -- Un pedido nace por donde dice `source_channel`: es mas fiable que
      -- deducirlo de si habia sesion, porque una importacion la lanza una
      -- persona con JWT y no por eso es un alta de backoffice.
      case new.source_channel
        when 'storefront' then 'storefront'
        when 'backoffice' then 'backoffice'
        when 'api'        then 'api'
        when 'import'     then 'import'
        else 'system'
      end::public.order_event_source,
      v_actor, v_email);

    -- Un pedido que nace esperando autorizacion lo dice desde el primer
    -- momento: si no, la cola de aprobacion no tendria origen en el relato.
    if new.approval_status = 'pending' then
      insert into public.order_events (
        organization_id, company_id, store_id, order_id,
        event_type, axis, from_value, to_value, payload, source, actor_id, actor_email
      ) values (
        new.organization_id, new.company_id, new.store_id, new.id,
        'order.approval_requested', 'approval_status', null, 'pending',
        jsonb_strip_nulls(jsonb_build_object(
          'business_account_id', new.business_account_id,
          'reason',             new.approval_reason)),
        'system', v_actor, v_email);
    end if;

    return null;
  end if;

  -- La nota que acompaña al cambio: el motivo declarado por el comando o, si no
  -- lo hay, la nota que se edito en la misma sentencia (comportamiento identico
  -- al de `ebim.log_order_status_event` desde P07 historico).
  v_note := coalesce(
    v_reason,
    case when new.notes is distinct from old.notes
         then nullif(left(btrim(coalesce(new.notes, '')), 1000), '') end);

  if new.status is distinct from old.status then
    insert into public.order_events (
      organization_id, company_id, store_id, order_id,
      event_type, axis, from_value, to_value, note, source, actor_id, actor_email
    ) values (
      new.organization_id, new.company_id, new.store_id, new.id,
      'order.status_changed', 'order_status', old.status::text, new.status::text,
      v_note, v_source, v_actor, v_email);
  end if;

  if new.payment_status is distinct from old.payment_status then
    insert into public.order_events (
      organization_id, company_id, store_id, order_id,
      event_type, axis, from_value, to_value, note, source, actor_id, actor_email
    ) values (
      new.organization_id, new.company_id, new.store_id, new.id,
      'order.payment_status_changed', 'payment_status',
      old.payment_status::text, new.payment_status::text,
      v_note, v_source, v_actor, v_email);
  end if;

  if new.fulfillment_status is distinct from old.fulfillment_status then
    insert into public.order_events (
      organization_id, company_id, store_id, order_id,
      event_type, axis, from_value, to_value, note, source, actor_id, actor_email
    ) values (
      new.organization_id, new.company_id, new.store_id, new.id,
      'order.fulfillment_status_changed', 'fulfillment_status',
      old.fulfillment_status::text, new.fulfillment_status::text,
      v_note, v_source, v_actor, v_email);
  end if;

  if new.approval_status is distinct from old.approval_status then
    insert into public.order_events (
      organization_id, company_id, store_id, order_id,
      event_type, axis, from_value, to_value, note, payload, source, actor_id, actor_email
    ) values (
      new.organization_id, new.company_id, new.store_id, new.id,
      'order.approval_decided', 'approval_status',
      old.approval_status::text, new.approval_status::text,
      coalesce(v_note, new.approval_reason),
      jsonb_strip_nulls(jsonb_build_object('decided_by', new.approval_decided_by)),
      v_source, v_actor, v_email);
  end if;

  -- Correcciones de datos operativos. No son cambios de estado y por eso no
  -- llevan `axis`, pero son exactamente lo que alguien busca cuando el paquete
  -- llego a la direccion equivocada.
  if (new.shipping_address, new.customer_name, new.customer_phone)
     is distinct from
     (old.shipping_address, old.customer_name, old.customer_phone)
  then
    insert into public.order_events (
      organization_id, company_id, store_id, order_id,
      event_type, note, payload, source, actor_id, actor_email
    ) values (
      new.organization_id, new.company_id, new.store_id, new.id,
      'order.details_updated', v_note,
      jsonb_build_object(
        'shipping_address_changed', new.shipping_address is distinct from old.shipping_address,
        'contact_changed',
          (new.customer_name, new.customer_phone) is distinct from (old.customer_name, old.customer_phone)),
      v_source, v_actor, v_email);
  end if;

  return null;
end;
$fn$;

create trigger orders_log_timeline_created
  after insert on public.orders
  for each row execute function ebim.log_order_timeline();

create trigger orders_log_timeline_changed
  after update on public.orders
  for each row execute function ebim.log_order_timeline();

-- Postgres comprueba el EXECUTE del trigger al CREARLO, no al dispararlo: se
-- puede revocar sin romper nada y si cierra la puerta a inventar un evento
-- invocando la funcion con un `select`.
revoke execute on function ebim.log_order_timeline() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- El historial que ya existia. `order_status_events` guarda desde P07 historico
-- todas las transiciones de `status`; sin traerlas, la pantalla nueva
-- empezaria diciendo que cada pedido antiguo «no tiene historial», que es la
-- clase de mentira que hace desconfiar de una bitacora entera.
--
-- Se traen ANTES de que ningun trigger nuevo escriba nada, asi que no hay
-- duplicados: los eventos posteriores los produce el trigger de arriba.
-- ---------------------------------------------------------------------------
insert into public.order_events (
  organization_id, company_id, store_id, order_id,
  event_type, axis, from_value, to_value, note, payload,
  source, actor_id, actor_email, created_at
)
select e.organization_id, e.company_id, e.store_id, e.order_id,
       case when e.from_status is null then 'order.created' else 'order.status_changed' end,
       'order_status', e.from_status::text, e.to_status::text, e.note,
       jsonb_build_object('migrated_from', 'order_status_events'),
       case when e.actor_id is null then 'storefront' else 'backoffice' end
         ::public.order_event_source,
       e.actor_id, e.actor_email, e.created_at
from public.order_status_events e;

-- ---------------------------------------------------------------------------
-- RLS · el tenant LEE su relato; nadie lo escribe desde fuera del trigger
-- ---------------------------------------------------------------------------
alter table public.order_events enable row level security;
alter table public.order_events force  row level security;

revoke all on public.order_events from public, anon, authenticated;

grant select on public.order_events to authenticated;
grant all    on public.order_events to service_role;

create policy order_events_select_member on public.order_events
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

comment on table public.order_events is
  'Linea de tiempo append-only del pedido, con los cuatro ejes en un solo relato. Escritura EXCLUSIVA del trigger SECURITY DEFINER ebim.log_order_timeline; sin GRANT ni policy de INSERT/UPDATE/DELETE para anon ni authenticated.';
comment on column public.order_events.axis is
  'Eje de estado al que se refiere. NULL en los hechos que no son un cambio de estado (correccion de direccion, contacto).';
comment on column public.order_events.source is
  'De donde vino la accion. Se deduce (JWT presente = backoffice) salvo que el comando declare otra cosa con set_config(ebim.order_event_source).';
comment on function ebim.log_order_timeline() is
  'Escritor unico de order_events. Una fila por EJE movido: aprobar y cobrar en la misma transaccion son dos hechos, no uno.';
