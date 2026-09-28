-- =============================================================================
-- Toda tienda nace con sus medios de pago y sus metodos de entrega.
--
-- ## El problema
--
-- Una tienda recien creada tenia catalogo, canal y ajustes, pero ni un medio de
-- pago ni un metodo de entrega. El checkout no podia cerrarse, y nada en la
-- pantalla lo decia: le paso a `ferromax`, con 200 productos publicados, precio
-- y stock, y sin forma de cobrar ni de entregar.
--
-- ## La regla
--
-- Al insertar una tienda se siembran CINCO medios de pago y CINCO metodos de
-- entrega por defecto. Son filas normales: el comercio las edita, las desactiva
-- o las borra desde Pagos y Entregas como cualquier otra. No son plantilla ni
-- se regeneran: `on conflict do nothing` y solo al insertar.
--
-- ## Por que activos unos y no otros
--
-- Activo = el comprador lo ve en el checkout. Solo se activa lo que funciona
-- sin configuracion adicional y no promete nada que el comercio no haya dicho:
--
--  · Pagos manuales (transferencia, Yape, Plin, efectivo): ACTIVOS. Sus
--    instrucciones no inventan una cuenta ni un numero —dicen que el comercio
--    los enviara al confirmar—, y el comercio las reemplaza por las suyas.
--  · Credito empresa: INACTIVO. El checkout no lo restringe a clientes con
--    linea aprobada; activo, cualquier comprador podria elegir pagar a credito.
--  · Envios (`ship`, `local_delivery`): exigen zona que cubra la direccion y
--    tarifa (`ebim.delivery_options`). Se siembran dos zonas de Peru y sus
--    tarifas SOLO si la tienda vende en PEN; en otra moneda los envios nacen
--    inactivos, porque una zona de Peru con tarifa en soles no les sirve.
--  · Recojo: exige un punto de recojo activo, y una tienda nueva no tiene
--    direccion. Nace INACTIVO hasta que el comercio cree su punto.
--
-- ## Por que en trigger
--
-- Mismo motivo que `stores_default_channel`: vale para TODOS los caminos que
-- crean tiendas (`bootstrap_tenant`, alta de tienda adicional y los futuros).
--
-- Las tiendas que ya existen no se tocan aqui: cada una se siembra a pedido
-- con `scripts/sembrar-pagos-entregas.mjs <slug>`.
-- =============================================================================

create or replace function ebim.seed_store_payment_delivery(
  p_store_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_pen   boolean;
  v_lima  uuid;
  v_peru  uuid;
begin
  select * into v_store from public.stores s where s.id = p_store_id;
  if not found then
    return;
  end if;

  v_pen := v_store.currency = 'PEN';

  -- ---- Medios de pago ------------------------------------------------------
  insert into public.payment_methods
    (organization_id, company_id, store_id, code, kind, display_name,
     capture_mode, is_active, position, instructions)
  values
    (v_store.organization_id, v_store.company_id, v_store.id,
     'transferencia', 'bank_transfer', 'Transferencia bancaria', 'manual', true, 10,
     'Al confirmar tu pedido te enviaremos los datos de la cuenta. Tu pedido se despacha cuando recibamos el abono.'),
    (v_store.organization_id, v_store.company_id, v_store.id,
     'yape', 'wallet', 'Yape', 'manual', true, 20,
     'Al confirmar tu pedido te enviaremos el numero para yapear. Envianos la captura del pago.'),
    (v_store.organization_id, v_store.company_id, v_store.id,
     'plin', 'wallet', 'Plin', 'manual', true, 30,
     'Al confirmar tu pedido te enviaremos el numero para pagar con Plin. Envianos la captura del pago.'),
    (v_store.organization_id, v_store.company_id, v_store.id,
     'contraentrega', 'cash', 'Efectivo contra entrega', 'manual', true, 40,
     'Paga en efectivo al recibir tu pedido o al recogerlo en tienda.'),
    (v_store.organization_id, v_store.company_id, v_store.id,
     'credito', 'credit', 'Credito empresa', 'manual', false, 50,
     'Solo para empresas con linea de credito aprobada.')
  on conflict (store_id, code) do nothing;

  -- ---- Zonas (solo Peru, solo en soles) ------------------------------------
  if v_pen then
    insert into public.delivery_zones
      (organization_id, company_id, store_id, code, name, country, regions, priority)
    values
      (v_store.organization_id, v_store.company_id, v_store.id,
       'lima-callao', 'Lima y Callao', 'PE', array['Lima', 'Callao'], 10),
      (v_store.organization_id, v_store.company_id, v_store.id,
       'resto-peru', 'Resto del Peru', 'PE', '{}'::text[], 90)
    on conflict (store_id, code) do nothing;

    select z.id into v_lima from public.delivery_zones z
     where z.store_id = v_store.id and z.code = 'lima-callao';
    select z.id into v_peru from public.delivery_zones z
     where z.store_id = v_store.id and z.code = 'resto-peru';
  end if;

  -- ---- Metodos de entrega --------------------------------------------------
  insert into public.delivery_methods
    (organization_id, company_id, store_id, code, strategy, display_name, description,
     lead_time_min_days, lead_time_max_days, is_active, position)
  values
    (v_store.organization_id, v_store.company_id, v_store.id,
     'estandar', 'ship', 'Envio estandar', 'Entrega a domicilio en 2 a 4 dias',
     2, 4, v_pen, 10),
    (v_store.organization_id, v_store.company_id, v_store.id,
     'express', 'ship', 'Envio express', 'Entrega al dia siguiente en Lima y Callao',
     1, 1, v_pen, 20),
    (v_store.organization_id, v_store.company_id, v_store.id,
     'agencia', 'ship', 'Envio a provincia por agencia', 'Despacho por agencia de transporte a todo el Peru',
     3, 7, v_pen, 30),
    (v_store.organization_id, v_store.company_id, v_store.id,
     'reparto-propio', 'local_delivery', 'Reparto propio', 'Reparto con nuestra movilidad en Lima y Callao',
     1, 2, v_pen, 40),
    (v_store.organization_id, v_store.company_id, v_store.id,
     'recojo', 'pickup', 'Recojo en tienda', 'Recoge tu pedido sin costo',
     0, 1, false, 50)
  on conflict (store_id, code) do nothing;

  -- ---- Tarifas (solo si hay zonas) -----------------------------------------
  -- Se siembran solo para metodos que todavia no tienen ninguna: una tienda
  -- con sus tarifas ya puestas no recibe otras encima.
  if v_pen then
    insert into public.delivery_rates
      (organization_id, company_id, store_id, delivery_method_id, zone_id,
       currency, base_amount, free_over_subtotal)
    select v_store.organization_id, v_store.company_id, v_store.id, m.id, t.zone_id,
           'PEN', t.base_amount, t.free_over
      from (values
              ('estandar',       v_lima, 15::numeric, 300::numeric),
              ('estandar',       v_peru, 30::numeric, null::numeric),
              ('express',        v_lima, 25::numeric, null::numeric),
              ('agencia',        v_peru, 20::numeric, null::numeric),
              ('reparto-propio', v_lima, 10::numeric, 200::numeric)
           ) as t(code, zone_id, base_amount, free_over)
      join public.delivery_methods m
        on m.store_id = v_store.id and m.code = t.code
     where not exists (
             select 1 from public.delivery_rates r where r.delivery_method_id = m.id);
  end if;
end;
$fn$;

revoke execute on function ebim.seed_store_payment_delivery(uuid) from public, anon, authenticated;
grant  execute on function ebim.seed_store_payment_delivery(uuid) to service_role;

comment on function ebim.seed_store_payment_delivery(uuid) is
  'Siembra 5 medios de pago y 5 metodos de entrega por defecto (y zonas + tarifas de Peru si la tienda es PEN). Idempotente: no pisa lo que ya exista.';

-- SECURITY DEFINER porque `create_store` corre como el usuario autenticado, que
-- no tiene EXECUTE sobre la siembra. No abre nada: una funcion `returns trigger`
-- no se puede llamar directamente, y solo actua sobre la fila recien insertada,
-- cuyo tenant ya valido la RLS de `stores`.
create or replace function ebim.ensure_default_payment_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform ebim.seed_store_payment_delivery(new.id);
  return new;
end;
$fn$;

revoke execute on function ebim.ensure_default_payment_delivery() from public, anon, authenticated;

drop trigger if exists stores_default_payment_delivery on public.stores;
create trigger stores_default_payment_delivery
  after insert on public.stores
  for each row execute function ebim.ensure_default_payment_delivery();
