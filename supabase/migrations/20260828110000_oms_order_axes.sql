-- =============================================================================
-- P08-SaaS · 1/7 — Un pedido deja de tener UN estado y pasa a tener CUATRO ejes
--
-- ## El problema que cierra esta migracion
--
-- `public.order_status` mezclaba tres preguntas distintas en una sola columna:
-- si el dinero llego (`paid`), si la mercancia salio (`fulfilled`) y en que
-- punto del ciclo comercial esta el pedido. Mientras la tienda solo cobraba
-- contra entrega eso se sostenia. Deja de sostenerse en cuanto existe un pedido
-- **pagado y no despachado**, uno **despachado y no cobrado** (credito B2B), o
-- uno **parcialmente reembolsado**: los tres son estados normales del comercio
-- real y ninguno se puede escribir con una sola palabra.
--
-- La correccion NO es renombrar `status` ni ampliarlo con mas valores —eso
-- multiplica el producto cartesiano de los tres ejes y convierte la maquina de
-- estados en una tabla de veinte entradas que nadie mantiene—. Es separar los
-- ejes y dejar que cada uno tenga su propia maquina.
--
-- ## Cuatro ejes, cuatro preguntas
--
--  · `status`             (existente) — el ciclo COMERCIAL del pedido.
--  · `payment_status`     — ¿donde esta el dinero?
--  · `fulfillment_status` — ¿donde esta la mercancia?
--  · `approval_status`    — ¿alguien tiene que autorizar esta compra? (B2B)
--
-- ## Compatibilidad: `status` NO cambia de significado ni pierde autoridad
--
-- Todo lo que hoy escribe o lee `status` sigue funcionando exactamente igual:
-- la policy `orders_update_orders_role`, el GRANT por columna, el trigger
-- `ebim.assert_order_transition`, la bitacora `order_status_events`, el KPI del
-- panel, `create_order` y la Edge Function `update-order-status`. Lo que se
-- añade es un trigger de SINCRONIZACION que, cuando `status` se mueve por el
-- camino de siempre, ADELANTA los ejes nuevos a lo que ese movimiento implica.
-- Asi no existe la ventana «pedido marcado `paid` cuyo `payment_status` sigue
-- diciendo `pending`»: no es que sea improbable, es que el trigger la cierra.
--
-- La sincronizacion solo actua sobre el eje que la sentencia NO toco. Una orden
-- explicita del comando de transicion (migracion 110400) manda sobre la
-- deduccion; la deduccion solo rellena lo que nadie decidio.
--
-- ## Los ejes nuevos NO tienen GRANT de escritura
--
-- `status` se puede mover con un UPDATE directo porque asi nacio en P02 y hay
-- codigo vivo que depende de ello. Los tres ejes nuevos nacen al reves:
-- `authenticated` no tiene GRANT sobre esas columnas, asi que la unica forma de
-- moverlos es `public.order_transition` — un COMANDO con su autorizacion, su
-- maquina de estados, su evento de bitacora y su hecho de dominio. Es la regla
-- «no saltos arbitrarios desde la UI» hecha estructura y no convencion.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Los vocabularios. Enums y no texto libre: un estado que se puede escribir mal
-- es un estado que alguien escribira mal, y entonces el filtro del listado deja
-- de encontrar pedidos que si existen.
-- ---------------------------------------------------------------------------
create type public.payment_status as enum (
  'pending',            -- no se ha cobrado nada
  'authorized',         -- retenido en la pasarela, todavia no capturado
  'paid',               -- cobrado
  'partially_refunded', -- devuelto en parte
  'refunded',           -- devuelto entero
  'failed',             -- el intento de cobro se rechazo
  'voided'              -- la autorizacion se anulo sin cobrar
);

create type public.fulfillment_status as enum (
  'unfulfilled',
  'in_progress',          -- en preparacion
  'partially_fulfilled',  -- salio parte del pedido
  'fulfilled',
  'returned',
  'cancelled'
);

-- **De donde ENTRO el pedido**, que no es lo mismo que `channel_id`.
-- `channels` (P10 historico) es el canal COMERCIAL: decide precio, catalogo y
-- si exige sesion. `source_channel` es el ORIGEN tecnico: por que puerta entro
-- la peticion. Un mismo canal comercial recibe pedidos de la vitrina, de una
-- importacion masiva y de una repeticion programada, y cuando algo sale mal la
-- pregunta operativa es siempre «¿de donde salio esto?».
create type public.order_source_channel as enum (
  'storefront',   -- la vitrina publica
  'backoffice',   -- alguien del tenant lo creo a mano
  'api',          -- un sistema externo por la API
  'import',       -- carga masiva
  'scheduled',    -- pedido programado que vencio
  'repeat'        -- repeticion de un pedido anterior
);

create type public.order_approval_status as enum (
  'not_required',  -- B2C y B2B sin control: el 99% de los pedidos
  'pending',
  'approved',
  'rejected'
);

-- ---------------------------------------------------------------------------
-- Las columnas nuevas de `orders`.
--
-- Tres grupos: los ejes de estado, el SNAPSHOT inmutable de lo que se compro y
-- a quien, y el vinculo B2B.
-- ---------------------------------------------------------------------------
alter table public.orders
  add column payment_status     public.payment_status        not null default 'pending',
  add column fulfillment_status public.fulfillment_status     not null default 'unfulfilled',
  add column source_channel     public.order_source_channel   not null default 'storefront',
  add column approval_status    public.order_approval_status  not null default 'not_required',
  -- Marcas de tiempo del ciclo. Las pone el trigger, no la aplicacion: una
  -- fecha de pago escrita a mano es una fecha de pago que puede mentir.
  add column paid_at                timestamptz,
  add column fulfilled_at           timestamptz,
  add column cancelled_at           timestamptz,
  add column approval_decided_at    timestamptz,
  add column approval_decided_by    uuid,
  add column approval_decided_email text,
  add column approval_reason        text,
  -- El vinculo B2B. Lo rellena el SERVIDOR con la cuenta que resolvio la sesion
  -- del comprador (`my_business_accounts()`, que no acepta argumentos desde
  -- P05); nunca llega en el cuerpo de la peticion. `orders` sigue SIN
  -- `customer_id`, que es la decision de P05 y no se toca: el cliente de un
  -- pedido anonimo no lo puede declarar el navegador.
  add column business_account_id uuid,
  -- ---- SNAPSHOT ----------------------------------------------------------
  -- `tax_inclusive` es del pedido y no de la tienda. `store_settings` puede
  -- cambiar mañana y entonces el desglose de un pedido de ayer se recalcularia
  -- al reves. Congelarlo es lo que hace que la factura siga cuadrando.
  add column tax_inclusive boolean not null default false,
  -- La direccion de facturacion es fiscal: no se corrige, se congela.
  add column billing_address jsonb not null default '{}'::jsonb,
  -- `shipping_address` SIGUE siendo editable por el backoffice (GRANT de P02):
  -- corregir un portal equivocado antes de despachar es una necesidad real. Lo
  -- que no puede perderse es lo que el comprador escribio, y para eso esta esta
  -- copia, que no tiene GRANT de escritura para nadie.
  add column shipping_address_snapshot jsonb not null default '{}'::jsonb,
  -- Quien compro, tal y como se identifico entonces. Un cliente que despues
  -- cambia de razon social, de documento o de correo no reescribe su historial.
  add column customer_snapshot jsonb not null default '{}'::jsonb;

alter table public.orders
  add constraint orders_approval_shape check (
    (approval_status in ('not_required', 'pending')
      and approval_decided_at is null and approval_decided_by is null)
    or (approval_status in ('approved', 'rejected') and approval_decided_at is not null)
  ),
  add constraint orders_approval_reason_len
    check (approval_reason is null or char_length(approval_reason) <= 1000),
  add constraint orders_approval_email_len
    check (approval_decided_email is null or char_length(approval_decided_email) <= 320),
  -- Snapshots: objetos JSON, nunca arrays ni escalares. Un `jsonb` sin forma es
  -- una columna que cada lector interpreta a su manera.
  add constraint orders_snapshot_shapes check (
    jsonb_typeof(billing_address) = 'object'
    and jsonb_typeof(shipping_address_snapshot) = 'object'
    and jsonb_typeof(customer_snapshot) = 'object'
  ),
  -- Tenant-safe: una cuenta B2B de otra sociedad no puede firmar este pedido.
  -- La lista de columnas del `set null` es obligatoria: `organization_id` y
  -- `company_id` son NOT NULL y forman parte de la clave (misma tecnica que
  -- `order_items_product_fk` en P02).
  add constraint orders_business_account_fk
    foreign key (business_account_id, organization_id, company_id)
    references public.business_accounts (id, organization_id, company_id)
    on delete set null (business_account_id);

-- ---------------------------------------------------------------------------
-- Los pedidos que YA existen. Los ejes se deducen del `status` que tienen y la
-- direccion de envio se copia a su snapshot: sin esto, todo pedido anterior a
-- esta migracion diria «sin cobrar, sin despachar, sin direccion», que no es
-- «no se sabe» sino directamente falso.
-- ---------------------------------------------------------------------------
update public.orders set
  payment_status = case status
    when 'paid'      then 'paid'::public.payment_status
    when 'fulfilled' then 'paid'::public.payment_status
    when 'refunded'  then 'refunded'::public.payment_status
    when 'cancelled' then 'voided'::public.payment_status
    else 'pending'::public.payment_status
  end,
  fulfillment_status = case status
    when 'fulfilled' then 'fulfilled'::public.fulfillment_status
    when 'refunded'  then 'returned'::public.fulfillment_status
    when 'cancelled' then 'cancelled'::public.fulfillment_status
    else 'unfulfilled'::public.fulfillment_status
  end,
  paid_at      = case when status in ('paid', 'fulfilled', 'refunded') then updated_at end,
  fulfilled_at = case when status in ('fulfilled', 'refunded') then updated_at end,
  cancelled_at = case when status = 'cancelled' then updated_at end,
  shipping_address_snapshot = coalesce(shipping_address, '{}'::jsonb),
  customer_snapshot = jsonb_strip_nulls(jsonb_build_object(
    'email', customer_email,
    'name',  customer_name,
    'phone', customer_phone));

-- ---------------------------------------------------------------------------
-- Indices de las consultas que la pantalla hace de verdad.
--
-- El listado pagina por `(placed_at desc, id desc)` y no solo por fecha: dos
-- pedidos del mismo instante con un `order by` no total se reparten mal entre
-- paginas y el operador ve uno dos veces y otro ninguna.
-- ---------------------------------------------------------------------------
create index orders_store_placed_idx on public.orders (store_id, placed_at desc, id desc);
create index orders_store_payment_idx
  on public.orders (store_id, payment_status, placed_at desc);
create index orders_store_fulfillment_idx
  on public.orders (store_id, fulfillment_status, placed_at desc);
-- Parcial: la cola de aprobacion es pequeña y se consulta constantemente.
create index orders_pending_approval_idx
  on public.orders (organization_id, company_id, placed_at)
  where approval_status = 'pending';
create index orders_business_account_idx
  on public.orders (business_account_id, placed_at desc)
  where business_account_id is not null;
create index orders_source_channel_idx on public.orders (store_id, source_channel, placed_at desc);

-- ---------------------------------------------------------------------------
-- ebim.sync_order_axes — el camino viejo sigue siendo verdad en el modelo nuevo
--
-- Se dispara ANTES que `ebim.assert_order_axes` (los triggers BEFORE de una
-- tabla corren en orden alfabetico de nombre: `orders_axes_sync` <
-- `orders_axes_transition`), asi que lo que deduce todavia pasa por la maquina
-- de estados de los ejes. No hay puerta trasera: deducir no es saltarse nada.
--
-- Solo toca el eje que la sentencia dejo igual. Si el comando ya decidio
-- `payment_status`, la deduccion no lo pisa.
-- ---------------------------------------------------------------------------
create or replace function ebim.sync_order_axes()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    -- Un pedido que nace `paid` (alta desde el backoffice o desde un ERP) tiene
    -- que nacer con el dinero donde toca.
    if new.payment_status = 'pending' then
      new.payment_status := case new.status
        when 'paid'      then 'paid'::public.payment_status
        when 'fulfilled' then 'paid'::public.payment_status
        when 'refunded'  then 'refunded'::public.payment_status
        else new.payment_status
      end;
    end if;
    if new.fulfillment_status = 'unfulfilled' then
      new.fulfillment_status := case new.status
        when 'fulfilled' then 'fulfilled'::public.fulfillment_status
        when 'cancelled' then 'cancelled'::public.fulfillment_status
        else new.fulfillment_status
      end;
    end if;
  elsif new.status is distinct from old.status then
    if new.payment_status is not distinct from old.payment_status then
      new.payment_status := case new.status
        -- `paid` solo adelanta desde donde todavia no hay dinero cobrado.
        when 'paid' then
          case when old.payment_status in ('pending', 'authorized')
               then 'paid'::public.payment_status else old.payment_status end
        when 'fulfilled' then
          case when old.payment_status in ('pending', 'authorized')
               then 'paid'::public.payment_status else old.payment_status end
        when 'refunded' then 'refunded'::public.payment_status
        -- Cancelar un pedido YA cobrado no anula nada: deja el dinero donde
        -- esta y espera una devolucion, que es una decision aparte.
        when 'cancelled' then
          case when old.payment_status in ('pending', 'authorized')
               then 'voided'::public.payment_status else old.payment_status end
        else old.payment_status
      end;
    end if;

    if new.fulfillment_status is not distinct from old.fulfillment_status then
      new.fulfillment_status := case new.status
        when 'fulfilled' then 'fulfilled'::public.fulfillment_status
        when 'cancelled' then
          case when old.fulfillment_status = 'unfulfilled'
               then 'cancelled'::public.fulfillment_status else old.fulfillment_status end
        when 'refunded' then
          case when old.fulfillment_status in ('fulfilled', 'partially_fulfilled')
               then 'returned'::public.fulfillment_status else old.fulfillment_status end
        else old.fulfillment_status
      end;
    end if;
  end if;

  -- Las marcas de tiempo. Se estampan la PRIMERA vez que el hecho ocurre y no
  -- se reescriben: `paid_at` es cuando se cobro, no cuando se toco la fila.
  if new.payment_status in ('paid', 'partially_refunded', 'refunded') and new.paid_at is null then
    new.paid_at := now();
  end if;
  if new.fulfillment_status in ('fulfilled', 'partially_fulfilled') and new.fulfilled_at is null then
    new.fulfilled_at := now();
  end if;
  if (new.status = 'cancelled' or new.fulfillment_status = 'cancelled')
     and new.cancelled_at is null then
    new.cancelled_at := now();
  end if;

  return new;
end;
$fn$;

create trigger orders_axes_sync
  before insert or update on public.orders
  for each row execute function ebim.sync_order_axes();

-- ---------------------------------------------------------------------------
-- ebim.assert_order_axes — las maquinas de estado de los tres ejes nuevos
--
-- Misma forma que `ebim.assert_order_transition` de P02, y por la misma razon:
-- la autoridad tiene que estar donde nadie la pueda rodear. La copia del
-- orquestador y la del frontend existen para dar un mensaje antes, no para
-- decidir.
--
-- Aqui vive ademas la regla que hace util la aprobacion B2B: **un pedido a la
-- espera de que alguien lo autorice no avanza**. Sin esto, `approval_status`
-- seria una etiqueta decorativa que la operacion ignora.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_order_axes()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_allowed text[];
begin
  -- ---- Pago -------------------------------------------------------------
  if new.payment_status is distinct from old.payment_status then
    v_allowed := case old.payment_status
      when 'pending'            then array['authorized','paid','failed','voided']
      when 'authorized'         then array['paid','failed','voided']
      when 'paid'               then array['partially_refunded','refunded']
      when 'partially_refunded' then array['refunded']
      when 'failed'             then array['pending','voided']
      else array[]::text[]
    end;
    if not (new.payment_status::text = any (v_allowed)) then
      raise exception 'PAGO_TRANSICION_INVALIDA: % -> %', old.payment_status, new.payment_status
        using errcode = '23514';
    end if;
  end if;

  -- ---- Entrega ----------------------------------------------------------
  if new.fulfillment_status is distinct from old.fulfillment_status then
    v_allowed := case old.fulfillment_status
      when 'unfulfilled'         then array['in_progress','partially_fulfilled','fulfilled','cancelled']
      when 'in_progress'         then array['partially_fulfilled','fulfilled','cancelled']
      when 'partially_fulfilled' then array['fulfilled','returned','cancelled']
      when 'fulfilled'           then array['returned']
      else array[]::text[]
    end;
    if not (new.fulfillment_status::text = any (v_allowed)) then
      raise exception 'ENTREGA_TRANSICION_INVALIDA: % -> %',
        old.fulfillment_status, new.fulfillment_status
        using errcode = '23514';
    end if;
  end if;

  -- ---- Aprobacion -------------------------------------------------------
  -- `not_required` es terminal a proposito: un pedido B2C no se puede meter a
  -- posteriori en un circuito de aprobacion, porque no hay quien lo apruebe.
  if new.approval_status is distinct from old.approval_status then
    v_allowed := case old.approval_status
      when 'pending' then array['approved','rejected']
      else array[]::text[]
    end;
    if not (new.approval_status::text = any (v_allowed)) then
      raise exception 'APROBACION_TRANSICION_INVALIDA: % -> %',
        old.approval_status, new.approval_status
        using errcode = '23514';
    end if;
  end if;

  -- ---- La aprobacion pendiente FRENA el pedido --------------------------
  -- Se comprueba sobre el estado que queda tras esta sentencia, no sobre el
  -- anterior: aprobar y avanzar en la misma transaccion es legitimo. Cancelar
  -- si se permite: un pedido que nadie va a autorizar tiene que poder cerrarse.
  if new.approval_status = 'pending' then
    if new.status is distinct from old.status and new.status <> 'cancelled' then
      raise exception 'PEDIDO_PENDIENTE_APROBACION: el pedido % espera autorizacion', new.order_number
        using errcode = '23514';
    end if;
    if new.payment_status is distinct from old.payment_status
       and new.payment_status not in ('failed', 'voided') then
      raise exception 'PEDIDO_PENDIENTE_APROBACION: el pedido % espera autorizacion', new.order_number
        using errcode = '23514';
    end if;
    if new.fulfillment_status is distinct from old.fulfillment_status
       and new.fulfillment_status <> 'cancelled' then
      raise exception 'PEDIDO_PENDIENTE_APROBACION: el pedido % espera autorizacion', new.order_number
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$fn$;

create trigger orders_axes_transition
  before update on public.orders
  for each row execute function ebim.assert_order_axes();

-- ---------------------------------------------------------------------------
-- ebim.assert_order_snapshot_immutable — lo congelado, congelado
--
-- El criterio de aceptacion de esta fase es literalmente que el historial de un
-- pedido siga siendo correcto aunque despues cambie el producto, el precio, el
-- impuesto o la configuracion. Un snapshot que se puede editar no es un
-- snapshot: es un valor por defecto. Estas columnas no tienen GRANT para
-- `authenticated`, y este trigger es la segunda linea —la que tambien detiene a
-- `service_role`, que si tiene GRANT y no pasa por ninguna policy—.
--
-- `shipping_address` NO esta en la lista: se corrige, y su original vive en
-- `shipping_address_snapshot`, que si lo esta.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_order_snapshot_immutable()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if (new.order_number, new.placed_at, new.channel_id, new.source_channel,
      new.tax_inclusive, new.billing_address, new.shipping_address_snapshot,
      new.customer_snapshot, new.business_account_id, new.customer_email)
     is distinct from
     (old.order_number, old.placed_at, old.channel_id, old.source_channel,
      old.tax_inclusive, old.billing_address, old.shipping_address_snapshot,
      old.customer_snapshot, old.business_account_id, old.customer_email)
  then
    raise exception 'ORDER_SNAPSHOT_INMUTABLE: el numero, el origen, el impuesto aplicado, la direccion congelada y el cliente de un pedido no se reescriben'
      using errcode = '23514';
  end if;
  return new;
end;
$fn$;

create trigger orders_assert_snapshot_immutable
  before update on public.orders
  for each row execute function ebim.assert_order_snapshot_immutable();

-- ---------------------------------------------------------------------------
-- GRANT: los ejes nuevos NO se escriben con un UPDATE.
--
-- El GRANT por columna de P02 (`status, notes, customer_name, customer_phone,
-- shipping_address`) NO se amplia. `authenticated` puede LEER las columnas
-- nuevas —el GRANT de SELECT es de tabla entera— y no puede escribir ni una.
-- Su unica puerta es `public.order_transition` (migracion 110400).
-- ---------------------------------------------------------------------------

comment on column public.orders.status is
  'Ciclo COMERCIAL del pedido. Desde P08 convive con payment_status y fulfillment_status; moverlo sincroniza los otros ejes por trigger.';
comment on column public.orders.payment_status is
  'Donde esta el dinero. Sin GRANT de escritura: solo se mueve por public.order_transition.';
comment on column public.orders.fulfillment_status is
  'Donde esta la mercancia. Sin GRANT de escritura: solo se mueve por public.order_transition.';
comment on column public.orders.source_channel is
  'ORIGEN tecnico del pedido (por que puerta entro). Distinto de channel_id, que es el canal COMERCIAL que decide precio y catalogo.';
comment on column public.orders.approval_status is
  'Autorizacion B2B. not_required en todo pedido B2C, y es terminal: un pedido sin cuenta corporativa no entra al circuito a posteriori.';
comment on column public.orders.tax_inclusive is
  'SNAPSHOT: si el impuesto iba incluido en el precio EN EL MOMENTO de la compra. store_settings puede cambiar; este pedido no.';
comment on column public.orders.shipping_address_snapshot is
  'SNAPSHOT inmutable de la direccion que escribio el comprador. shipping_address si se puede corregir; esta no.';
comment on column public.orders.customer_snapshot is
  'SNAPSHOT del cliente tal y como se identifico. Sobrevive a que despues cambie de razon social, documento o correo.';
comment on column public.orders.business_account_id is
  'Cuenta B2B que resolvio el SERVIDOR desde la sesion del comprador (my_business_accounts()). Nunca llega en el cuerpo de la peticion.';
