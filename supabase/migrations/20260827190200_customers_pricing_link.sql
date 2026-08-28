-- =============================================================================
-- P05-SaaS · El cliente entra en el motor de precios y en el registro de modulos
--
-- Las dos migraciones anteriores crean el dominio. Esta lo CONECTA con lo que
-- ya existia, que es la parte que decide si un dominio nuevo es reutilizable o
-- una isla:
--
--  1. `price_quote` deriva el SEGMENTO del cliente en vez de exigir que se lo
--     digan. Cierra la deuda que `docs/STATE.md` dejo escrita en P04: «el
--     comprador todavia no tiene segmento ni cuenta».
--  2. `customer_orders` responde "que ha comprado este cliente" con la unica
--     verdad que hoy existe: el correo del pedido.
--  3. `app_capabilities` gana `customers` (baseline) y `customers.b2b` pasa de
--     `declared` a `implemented`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.customer_segment — el segmento de un cliente, dentro de una sociedad.
--
-- Recibe la sociedad y no la deduce del cliente a proposito: quien llama ya
-- sabe de que sociedad esta hablando (la tienda), y comparar las dos es lo que
-- convierte «este cliente no es tuyo» en un resultado vacio en vez de en una
-- fuga silenciosa.
-- ---------------------------------------------------------------------------
create or replace function ebim.customer_segment(
  p_customer_id     uuid,
  p_organization_id uuid,
  p_company_id      uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select c.segment_id
  from public.customers c
  where c.id = p_customer_id
    and c.organization_id = p_organization_id
    and c.company_id      = p_company_id
    and c.is_active;
$fn$;

revoke execute on function ebim.customer_segment(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function ebim.customer_segment(uuid, uuid, uuid) to service_role;

comment on function ebim.customer_segment(uuid, uuid, uuid) is
  'Segmento comercial de un cliente DE ESTA sociedad. Definer: la llaman funciones que ya autorizaron al llamante.';

-- ---------------------------------------------------------------------------
-- public.price_quote — el simulador del backoffice, ahora con cliente de verdad
--
-- Cambia UNA cosa respecto de P04 (migracion 180100): si se pasa un cliente y
-- no se pasa segmento, el segmento sale de la ficha. Antes habia que teclear
-- los dos y nada garantizaba que coincidieran — o sea que se podia simular «el
-- cliente X con el segmento del vecino», que es un precio que no le van a
-- cobrar a nadie.
--
-- El segmento explicito sigue mandando cuando se da: el simulador tiene que
-- poder responder «y si a este lo pasamos a mayorista, cuanto pagaria». Lo que
-- ya no se puede es inventar un cliente: si no es de esta sociedad, la funcion
-- corta. Sin esa comprobacion, un `customer_id` de otro tenant llegaria al
-- motor y aplicaria —o no— acuerdos ajenos, que es exactamente la fuga que la
-- FK de la migracion 190000 cierra por el otro lado.
--
-- El resto del cuerpo es el de P04, sin tocar: misma autorizacion, mismo canal
-- por defecto, misma delegacion en `ebim.build_quote`.
-- ---------------------------------------------------------------------------
create or replace function public.price_quote(
  p_store_id    uuid,
  p_items       jsonb,
  p_channel_id  uuid        default null,
  p_segment_id  uuid        default null,
  p_customer_id uuid        default null,
  p_at          timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store   public.stores%rowtype;
  v_channel public.channels%rowtype;
  v_segment uuid := p_segment_id;
begin
  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    raise exception 'TIENDA_NO_ENCONTRADA: la tienda no existe' using errcode = '22023';
  end if;

  if not ebim.can_access(v_store.organization_id, v_store.company_id) then
    raise exception 'SIN_PERMISO: la tienda no pertenece a este usuario' using errcode = '42501';
  end if;

  if p_channel_id is null then
    select * into v_channel
    from public.channels c
    where c.store_id = v_store.id and c.is_default and c.is_active;
  else
    select * into v_channel
    from public.channels c
    where c.id = p_channel_id and c.store_id = v_store.id and c.is_active;
  end if;

  if not found then
    raise exception 'CANAL_NO_DISPONIBLE: no hay canal activo para simular' using errcode = '22023';
  end if;

  if p_customer_id is not null then
    if not exists (
      select 1 from public.customers c
      where c.id = p_customer_id
        and c.organization_id = v_store.organization_id
        and c.company_id      = v_store.company_id
    ) then
      raise exception 'CLIENTE_NO_ENCONTRADO: ese cliente no es de esta sociedad' using errcode = '22023';
    end if;

    -- Sin segmento explicito, manda el de la ficha. Con segmento explicito,
    -- manda el que se pide: simular una reclasificacion es para lo que sirve.
    if v_segment is null then
      v_segment := ebim.customer_segment(
        p_customer_id, v_store.organization_id, v_store.company_id
      );
    end if;
  end if;

  if v_segment is not null and not exists (
    select 1 from public.customer_segments cs
    where cs.id = v_segment
      and cs.organization_id = v_store.organization_id
      and cs.company_id      = v_store.company_id
  ) then
    raise exception 'SEGMENTO_NO_ENCONTRADO: ese segmento no es de esta sociedad' using errcode = '22023';
  end if;

  return ebim.build_quote(
    v_store.id, v_channel.id, p_items, v_segment, p_customer_id,
    coalesce(p_at, now()), false
  );
end;
$fn$;

comment on function public.price_quote(uuid, jsonb, uuid, uuid, uuid, timestamptz) is
  'Simulador de precio del backoffice. Desde P05 el segmento sale de la ficha del cliente cuando no se declara, y un cliente de otra sociedad se rechaza.';

-- ---------------------------------------------------------------------------
-- public.customer_orders — que ha comprado este cliente.
--
-- **Por correo, y se dice que es por correo.** `orders` no tiene `customer_id`
-- y no lo va a tener hasta que el comprador tenga sesion: hoy el unico dato
-- que enlaza un pedido anonimo con una ficha es la direccion de correo con la
-- que se compro. Enlazarlo asi es una heuristica, no una identidad, y por eso
-- vive en una funcion con nombre propio en vez de en una FK que aparentaria
-- una certeza que no hay.
--
-- Busca por el correo de la ficha Y por el de sus contactos: en una empresa
-- compra el area de compras, no la razon social.
--
-- `SECURITY INVOKER`: lee `customers`, `customer_contacts` y `orders` bajo la
-- RLS de quien pregunta, asi que preguntar por el cliente del vecino no
-- devuelve filas por falta de permiso, no por cortesia.
-- ---------------------------------------------------------------------------
create or replace function public.customer_orders(p_customer_id uuid)
returns table (
  order_id     uuid,
  store_id     uuid,
  order_number text,
  status       public.order_status,
  currency     char(3),
  -- TEXTO, como todo el dinero que sale de esta base: un `numeric` convertido a
  -- `number` por JSON.parse pierde los centimos de cola ("8.00" -> 8).
  grand_total  text,
  placed_at    timestamptz
)
language sql
stable
set search_path = ''
as $fn$
  with emails as (
    select lower(c.email) as email
    from public.customers c
    where c.id = p_customer_id and c.email is not null
    union
    select lower(ct.email)
    from public.customer_contacts ct
    where ct.customer_id = p_customer_id and ct.email is not null
  )
  select o.id, o.store_id, o.order_number, o.status, o.currency, o.grand_total::text, o.placed_at
  from public.orders o
  join emails e on e.email = lower(o.customer_email)
  order by o.placed_at desc
  limit 100;
$fn$;

revoke execute on function public.customer_orders(uuid) from public, anon;
grant  execute on function public.customer_orders(uuid) to authenticated, service_role;

comment on function public.customer_orders(uuid) is
  'Pedidos asociados a un cliente POR CORREO (de la ficha o de sus contactos). Heuristica declarada: orders no tiene customer_id mientras el comprador sea anonimo.';

-- ---------------------------------------------------------------------------
-- public.customer_deletion_usage — que se lleva por delante borrar un cliente.
--
-- Contrato §4.2: eliminar ensena el conteo de uso REAL antes de borrar. Aqui
-- importa mas que en el catalogo, porque el borrado arrastra por cascada cosas
-- que nadie tiene delante: las direcciones, los contactos, los identificadores
-- externos, la cuenta B2B con sus usuarios y —desde la FK de 190000— las
-- asignaciones de lista de precio hechas a ese cliente.
--
-- `orders` se cuenta y NO se borra: un pedido es un hecho contable y no
-- desaparece porque se limpie una ficha. Sale en la lista para que quien borra
-- sepa que esta dejando pedidos sin ficha detras.
--
-- `SECURITY INVOKER`: cuenta bajo la RLS de quien pregunta, asi que sobre un
-- cliente ajeno devuelve ceros por falta de permiso, no por cortesia.
-- ---------------------------------------------------------------------------
create or replace function public.customer_deletion_usage(p_customer_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'addresses',    (select count(*) from public.customer_addresses    a where a.customer_id = p_customer_id),
    'contacts',     (select count(*) from public.customer_contacts     c where c.customer_id = p_customer_id),
    'external_ids', (select count(*) from public.customer_external_ids e where e.customer_id = p_customer_id),
    'accounts',     (select count(*) from public.business_accounts     b where b.customer_id = p_customer_id),
    'account_users',(select count(*)
                       from public.business_account_users u
                       join public.business_accounts b on b.id = u.business_account_id
                      where b.customer_id = p_customer_id),
    'price_assignments',
                    (select count(*) from public.price_list_assignments p
                      where p.customer_id = p_customer_id),
    'orders',       (select count(*) from public.customer_orders(p_customer_id))
  );
$fn$;

revoke execute on function public.customer_deletion_usage(uuid) from public, anon;
grant  execute on function public.customer_deletion_usage(uuid) to authenticated, service_role;

comment on function public.customer_deletion_usage(uuid) is
  'Conteo real de lo que arrastra borrar un cliente. Los pedidos se cuentan y no se borran: un pedido es un hecho contable.';

-- ---------------------------------------------------------------------------
-- El registro de capacidades.
--
-- `customers` entra como BASELINE: guardar a quien le vendiste viene con el
-- producto. Cobrar aparte por poder anotar el correo del comprador no seria un
-- modulo, seria un peaje — y dejaria a un tenant sin plan sin poder atender una
-- devolucion.
--
-- `customers.b2b` deja de ser `declared`: desde P05 tiene esquema (cuentas,
-- sucursales, usuarios y reglas), enforcement en policies, contexto de servidor
-- y pantalla. Es la tercera vendible que pasa a `implemented`, y un test de
-- paridad compara esta fila con `src/domain/capabilities.ts`.
-- ---------------------------------------------------------------------------
insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
values ('customers', 'customers', true, null, 'implemented');

update public.app_capabilities
   set state = 'implemented'
 where code = 'customers.b2b';
