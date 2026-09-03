-- =============================================================================
-- Datos de demostracion del recorrido B2B, para la tienda `miquimica` en DEV.
--
-- No es una migracion a proposito: los datos de demostracion en `migrations/`
-- acaban en produccion. Se aplica a mano y solo a DEV:
--
--   node scripts/apply-demo-data.mjs --file supabase/b2b-demo-data.sql
--
-- ## Que siembra, y por que asi
--
-- No son filas de relleno: cada bloque deja a la vista un COMPORTAMIENTO que de
-- otro modo habria que provocar a mano. Un documento vencido hace 100 dias, una
-- cotizacion que caduco sin que nadie la marcara, una liquidacion ya pagada, una
-- entrega ya firmada, una visita sin registro de entrada. Son los casos en los
-- que la pantalla tiene algo que decir; con datos «normales» todas se parecen.
--
-- Idempotente: los UUID son fijos y todo va con `on conflict do nothing`.
-- Correrlo dos veces no duplica nada.
--
-- Para vaciarlo: `supabase/b2b-demo-purge.sql`.
-- =============================================================================

do $$
declare
  v_org      uuid := 'd0000000-0000-4000-8000-000000000001';
  v_company  uuid := 'd0000000-0000-4000-8000-0000000000c1';
  v_store    uuid;
  v_cli1     uuid := 'd0000000-0000-4000-8000-d10000000001'; -- CLI-001 Luis Rojas
  v_cli2     uuid := 'd0000000-0000-4000-8000-d10000000002'; -- CLI-002 Marta Vargas
  v_cli3     uuid := 'd0000000-0000-4000-8000-d10000000003'; -- CLI-003 Diego Mendoza
  v_cli4     uuid := 'd0000000-0000-4000-8000-d10000000004'; -- CLI-004 Policlinico Andino
  v_cli5     uuid := 'd0000000-0000-4000-8000-d10000000005'; -- CLI-005 Javier Ferrer
  v_prod1    uuid;
  v_prod2    uuid;
  v_prod3    uuid;
  v_hoy      date := current_date;
begin
  select id into strict v_store from public.stores where slug = 'miquimica';

  select id into v_prod1 from public.products
   where store_id = v_store and status = 'published' order by sku limit 1 offset 0;
  select id into v_prod2 from public.products
   where store_id = v_store and status = 'published' order by sku limit 1 offset 1;
  select id into v_prod3 from public.products
   where store_id = v_store and status = 'published' order by sku limit 1 offset 2;

  -- ---------------------------------------------------------------------------
  -- Fuerza de ventas. Una jerarquia de tres niveles para que el desplegable de
  -- jefe tenga a quien excluir.
  -- ---------------------------------------------------------------------------
  insert into public.sales_reps
    (id, organization_id, company_id, employee_code, full_name, email, phone, manager_id, status, hired_at)
  values
    ('b2b00000-0000-4000-8000-000000000101', v_org, v_company, 'V-001', 'Marta Rios',
     'marta.rios@miquimica.demo', '+51 999 111 222', null, 'active', v_hoy - 900),
    ('b2b00000-0000-4000-8000-000000000102', v_org, v_company, 'V-002', 'Luis Pena',
     'luis.pena@miquimica.demo', '+51 999 333 444',
     'b2b00000-0000-4000-8000-000000000101', 'active', v_hoy - 400),
    ('b2b00000-0000-4000-8000-000000000103', v_org, v_company, 'V-003', 'Pia Quispe',
     'pia.quispe@miquimica.demo', null,
     'b2b00000-0000-4000-8000-000000000102', 'active', v_hoy - 120)
  on conflict (id) do nothing;

  -- Cartera: un titular por cliente, que es lo que impide pagar dos comisiones
  -- por la misma venta.
  insert into public.sales_rep_customers
    (id, organization_id, company_id, sales_rep_id, customer_id, is_primary)
  values
    ('b2b00000-0000-4000-8000-000000000111', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000102', v_cli1, true),
    ('b2b00000-0000-4000-8000-000000000112', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000102', v_cli2, true),
    ('b2b00000-0000-4000-8000-000000000113', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000103', v_cli4, true),
    ('b2b00000-0000-4000-8000-000000000114', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000103', v_cli5, true)
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------
  -- Territorios: un arbol de dos niveles, para ver la sangria en la tabla.
  -- ---------------------------------------------------------------------------
  insert into public.sales_territories
    (id, organization_id, company_id, parent_id, code, name, is_active)
  values
    ('b2b00000-0000-4000-8000-000000000201', v_org, v_company, null, 'NORTE', 'Lima Norte', true),
    ('b2b00000-0000-4000-8000-000000000202', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000201', 'NORTE-A', 'Los Olivos', true),
    ('b2b00000-0000-4000-8000-000000000203', v_org, v_company, null, 'SUR', 'Lima Sur', true)
  on conflict (id) do nothing;

  insert into public.sales_rep_territories
    (id, organization_id, company_id, sales_rep_id, territory_id)
  values
    ('b2b00000-0000-4000-8000-000000000211', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000102', 'b2b00000-0000-4000-8000-000000000201'),
    ('b2b00000-0000-4000-8000-000000000212', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000103', 'b2b00000-0000-4000-8000-000000000203')
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------
  -- Rutas y paradas. Una semanal y otra quincenal.
  -- ---------------------------------------------------------------------------
  insert into public.sales_routes
    (id, organization_id, company_id, sales_rep_id, territory_id, code, name, weekday, frequency_weeks, is_active)
  values
    ('b2b00000-0000-4000-8000-000000000301', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000102', 'b2b00000-0000-4000-8000-000000000202',
     'R-LUN-N', 'Lunes Los Olivos', 1, 1, true),
    ('b2b00000-0000-4000-8000-000000000302', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000103', 'b2b00000-0000-4000-8000-000000000203',
     'R-MIE-S', 'Miercoles Sur', 3, 2, true)
  on conflict (id) do nothing;

  insert into public.sales_route_stops
    (id, organization_id, company_id, route_id, customer_id, sequence)
  values
    ('b2b00000-0000-4000-8000-000000000311', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000301', v_cli1, 1),
    ('b2b00000-0000-4000-8000-000000000312', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000301', v_cli2, 2),
    ('b2b00000-0000-4000-8000-000000000313', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000301', v_cli3, 3),
    ('b2b00000-0000-4000-8000-000000000314', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000302', v_cli4, 1),
    ('b2b00000-0000-4000-8000-000000000315', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000302', v_cli5, 2)
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------
  -- Visitas. La primera SIN registro de entrada a proposito: es la que deja ver
  -- que «dar por visitada» esta apagado, porque el CHECK de la base lo exige.
  -- ---------------------------------------------------------------------------
  insert into public.sales_visits
    (id, organization_id, company_id, sales_rep_id, customer_id, route_id,
     planned_at, checked_in_at, checked_out_at, outcome, notes)
  values
    ('b2b00000-0000-4000-8000-000000000401', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000102', v_cli1, 'b2b00000-0000-4000-8000-000000000301',
     (v_hoy + 1)::timestamptz + interval '9 hours', null, null, 'planned',
     'Sin entrada registrada: no se puede dar por visitada.'),
    ('b2b00000-0000-4000-8000-000000000402', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000102', v_cli2, 'b2b00000-0000-4000-8000-000000000301',
     v_hoy::timestamptz + interval '10 hours',
     v_hoy::timestamptz + interval '10 hours 12 minutes', null, 'planned',
     'Con entrada: ya se puede cerrar.'),
    ('b2b00000-0000-4000-8000-000000000403', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000103', v_cli4, 'b2b00000-0000-4000-8000-000000000302',
     (v_hoy - 2)::timestamptz + interval '11 hours',
     (v_hoy - 2)::timestamptz + interval '11 hours 5 minutes',
     (v_hoy - 2)::timestamptz + interval '11 hours 40 minutes', 'completed', null)
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------
  -- Metas: una de vendedor en IMPORTE (lleva moneda) y otra de territorio en
  -- UNIDADES (no la lleva). Es el CHECK `sales_goals_currency_when_amount`.
  -- ---------------------------------------------------------------------------
  insert into public.sales_goals
    (id, organization_id, company_id, sales_rep_id, territory_id, metric, currency,
     period_start, period_end, target_value)
  values
    ('b2b00000-0000-4000-8000-000000000501', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000102', null, 'amount', 'PEN',
     date_trunc('month', v_hoy)::date,
     (date_trunc('month', v_hoy) + interval '1 month - 1 day')::date, 50000.00),
    ('b2b00000-0000-4000-8000-000000000502', v_org, v_company,
     null, 'b2b00000-0000-4000-8000-000000000201', 'units', null,
     date_trunc('month', v_hoy)::date,
     (date_trunc('month', v_hoy) + interval '1 month - 1 day')::date, 1200)
  on conflict (id) do nothing;

  -- Comisiones: una en borrador (avanza) y una PAGADA (no ofrece nada, porque
  -- reabrirla seria dinero que ya salio).
  insert into public.commission_rules
    (id, organization_id, company_id, code, name, rate, is_active)
  values
    ('b2b00000-0000-4000-8000-000000000601', v_org, v_company,
     'COM-STD', 'Comision estandar 3%', 0.0300, true)
  on conflict (id) do nothing;

  insert into public.commission_statements
    (id, organization_id, company_id, sales_rep_id, rule_id, period_start, period_end,
     currency, base_amount, rate, amount, status, approved_at, paid_at)
  values
    ('b2b00000-0000-4000-8000-000000000611', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000102', 'b2b00000-0000-4000-8000-000000000601',
     (date_trunc('month', v_hoy) - interval '1 month')::date,
     (date_trunc('month', v_hoy) - interval '1 day')::date,
     'PEN', 42000.00, 0.0300, 1260.00, 'draft', null, null),
    ('b2b00000-0000-4000-8000-000000000612', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000103', 'b2b00000-0000-4000-8000-000000000601',
     (date_trunc('month', v_hoy) - interval '2 month')::date,
     (date_trunc('month', v_hoy) - interval '1 month 1 day')::date,
     'PEN', 18000.00, 0.0250, 450.00, 'paid',
     now() - interval '40 days', now() - interval '35 days')
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------
  -- Cobranza. Los cuatro tramos de antiguedad en una sola pantalla.
  -- ---------------------------------------------------------------------------
  insert into public.ar_documents
    (id, organization_id, company_id, customer_id, kind, document_number, currency,
     issued_at, due_at, amount, balance)
  values
    ('b2b00000-0000-4000-8000-000000000701', v_org, v_company, v_cli1, 'invoice',
     'F001-1001', 'PEN', v_hoy - 75, v_hoy - 45, 1180.00, 1180.00),
    ('b2b00000-0000-4000-8000-000000000702', v_org, v_company, v_cli1, 'invoice',
     'F001-1002', 'PEN', v_hoy - 42, v_hoy - 12, 590.00, 590.00),
    ('b2b00000-0000-4000-8000-000000000703', v_org, v_company, v_cli2, 'invoice',
     'F001-1003', 'PEN', v_hoy - 20, v_hoy + 10, 2360.00, 2360.00),
    ('b2b00000-0000-4000-8000-000000000704', v_org, v_company, v_cli3, 'invoice',
     'F001-1004', 'PEN', v_hoy - 130, v_hoy - 100, 800.00, 800.00)
  on conflict (id) do nothing;

  -- Un cobro YA aplicado. El saldo del documento 1002 lo baja a cero un TRIGGER,
  -- no este script: es lo que deja ver que el saldo lo mantiene la base.
  insert into public.ar_receipts
    (id, organization_id, company_id, customer_id, receipt_number, currency,
     received_at, amount, method, reference)
  values
    ('b2b00000-0000-4000-8000-000000000711', v_org, v_company, v_cli1,
     'REC-0001', 'PEN', v_hoy - 5, 590.00, 'Transferencia', 'OP-889231')
  on conflict (id) do nothing;

  insert into public.ar_applications
    (id, organization_id, company_id, receipt_id, document_id, amount)
  values
    ('b2b00000-0000-4000-8000-000000000721', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000711', 'b2b00000-0000-4000-8000-000000000702', 590.00)
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------
  -- Comprobantes. Uno aceptado, uno pendiente y uno RECHAZADO con su motivo:
  -- el motivo es lo unico accionable de una factura rechazada.
  -- ---------------------------------------------------------------------------
  insert into public.invoices
    (id, organization_id, company_id, store_id, order_id, series, number, status, currency,
     issued_at, customer_name, customer_tax_id, net_total, tax_total, gross_total, reject_reason)
  select 'b2b00000-0000-4000-8000-000000000801', v_org, v_company, v_store, o.id,
         'F001', '00012345', 'accepted', 'PEN', now() - interval '9 days',
         'Policlinico Andino SAC', '20512345678', 1000.00, 180.00, 1180.00, null
    from public.orders o where o.store_id = v_store order by o.created_at desc limit 1
  on conflict (id) do nothing;

  insert into public.invoices
    (id, organization_id, company_id, store_id, order_id, series, number, status, currency,
     issued_at, customer_name, customer_tax_id, net_total, tax_total, gross_total, reject_reason)
  select 'b2b00000-0000-4000-8000-000000000802', v_org, v_company, v_store, o.id,
         'F001', null, 'pending', 'PEN', now() - interval '2 days',
         'Marta Vargas', null, 500.00, 90.00, 590.00, null
    from public.orders o where o.store_id = v_store order by o.created_at desc limit 1 offset 1
  on conflict (id) do nothing;

  insert into public.invoices
    (id, organization_id, company_id, store_id, order_id, series, number, status, currency,
     issued_at, customer_name, customer_tax_id, net_total, tax_total, gross_total, reject_reason)
  select 'b2b00000-0000-4000-8000-000000000803', v_org, v_company, v_store, o.id,
         'F001', '00012344', 'rejected', 'PEN', now() - interval '15 days',
         'Diego Mendoza', '10456789012', 300.00, 54.00, 354.00,
         'RUC del receptor no existe en el padron'
    from public.orders o where o.store_id = v_store order by o.created_at desc limit 1 offset 2
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------
  -- Cotizaciones. La segunda VENCIO y sigue diciendo «enviada»: nadie paso a
  -- marcarla, y la pantalla la marca como caducada al pintar.
  -- ---------------------------------------------------------------------------
  insert into public.quotes
    (id, organization_id, company_id, store_id, customer_id, sales_rep_id, quote_number,
     status, currency, issued_at, valid_until, subtotal, tax_total, grand_total, notes)
  values
    ('b2b00000-0000-4000-8000-000000000901', v_org, v_company, v_store, v_cli4,
     'b2b00000-0000-4000-8000-000000000103', 'COT-2026-001', 'sent', 'PEN',
     v_hoy - 5, v_hoy + 10, 1500.00, 0, 1500.00, 'Precio valido solo dentro de la vigencia.'),
    ('b2b00000-0000-4000-8000-000000000902', v_org, v_company, v_store, v_cli5,
     'b2b00000-0000-4000-8000-000000000103', 'COT-2026-002', 'sent', 'PEN',
     v_hoy - 30, v_hoy - 3, 820.00, 0, 820.00, null),
    -- Nace en BORRADOR aunque la queramos aceptada: `quote_items_guard` prohibe
    -- tocar las lineas de una cotizacion cerrada, asi que se cierra despues de
    -- ponerlas. Es el mismo orden que sigue una cotizacion de verdad.
    ('b2b00000-0000-4000-8000-000000000903', v_org, v_company, v_store, v_cli1,
     'b2b00000-0000-4000-8000-000000000102', 'COT-2026-003', 'draft', 'PEN',
     v_hoy - 20, v_hoy + 5, 2400.00, 0, 2400.00, null)
  on conflict (id) do nothing;

  insert into public.quote_items
    (id, organization_id, company_id, quote_id, product_id, quantity, unit_price, line_total, position)
  values
    ('b2b00000-0000-4000-8000-000000000911', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000901', v_prod1, 10, 100.00, 1000.00, 0),
    ('b2b00000-0000-4000-8000-000000000912', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000901', v_prod2, 5, 100.00, 500.00, 1),
    ('b2b00000-0000-4000-8000-000000000913', v_org, v_company,
     'b2b00000-0000-4000-8000-000000000903', v_prod3, 24, 100.00, 2400.00, 0)
  on conflict (id) do nothing;

  -- Y ahora si se acepta. `quote_status_guard` admite draft -> accepted.
  update public.quotes set status = 'accepted'
   where id = 'b2b00000-0000-4000-8000-000000000903' and status = 'draft';

  -- ---------------------------------------------------------------------------
  -- Surtidos: una lista BLANCA y una NEGRA, que significan lo contrario con el
  -- mismo contenido.
  -- ---------------------------------------------------------------------------
  insert into public.assortments
    (id, organization_id, company_id, store_id, code, name, is_allow_list, is_active)
  values
    ('b2b00000-0000-4000-8000-000000001001', v_org, v_company, v_store,
     'MODERNO', 'Canal moderno', true, true),
    ('b2b00000-0000-4000-8000-000000001002', v_org, v_company, v_store,
     'TRADICIONAL', 'Canal tradicional', false, true)
  on conflict (id) do nothing;

  insert into public.assortment_items
    (id, organization_id, company_id, assortment_id, product_id)
  values
    ('b2b00000-0000-4000-8000-000000001011', v_org, v_company,
     'b2b00000-0000-4000-8000-000000001001', v_prod1),
    ('b2b00000-0000-4000-8000-000000001012', v_org, v_company,
     'b2b00000-0000-4000-8000-000000001001', v_prod2),
    ('b2b00000-0000-4000-8000-000000001013', v_org, v_company,
     'b2b00000-0000-4000-8000-000000001002', v_prod3)
  on conflict (id) do nothing;

  -- Una asignacion de ambito CLIENTE, que es el mas especifico y por tanto el
  -- que gana en `ebim.assortment_for_customer`.
  insert into public.assortment_assignments
    (id, organization_id, company_id, store_id, assortment_id, scope, customer_id, priority, is_active)
  values
    ('b2b00000-0000-4000-8000-000000001021', v_org, v_company, v_store,
     'b2b00000-0000-4000-8000-000000001001', 'customer', v_cli4, 0, true)
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------
  -- Reparto. Una hoja en armado y otra ya cerrada.
  -- ---------------------------------------------------------------------------
  insert into public.delivery_vehicles
    (id, organization_id, company_id, code, plate, description, capacity_kg, is_active)
  values
    ('b2b00000-0000-4000-8000-000000001101', v_org, v_company,
     'CAM-01', 'ABC-123', 'Camion mediano', 3500.00, true),
    ('b2b00000-0000-4000-8000-000000001102', v_org, v_company,
     'CAM-02', 'XYZ-789', 'Furgoneta', 1200.00, true)
  on conflict (id) do nothing;

  insert into public.delivery_plans
    (id, organization_id, company_id, store_id, vehicle_id, code, plan_date, status,
     driver_name, dispatched_at, closed_at)
  values
    ('b2b00000-0000-4000-8000-000000001111', v_org, v_company, v_store,
     'b2b00000-0000-4000-8000-000000001101', 'HR-0002', v_hoy, 'draft', 'Pedro Salas', null, null),
    ('b2b00000-0000-4000-8000-000000001112', v_org, v_company, v_store,
     'b2b00000-0000-4000-8000-000000001102', 'HR-0001', v_hoy - 1, 'closed', 'Ana Torres',
     (v_hoy - 1)::timestamptz + interval '8 hours', (v_hoy - 1)::timestamptz + interval '18 hours')
  on conflict (id) do nothing;

  -- Las paradas cuelgan de despachos que YA existen. `fulfillment_id` es unico
  -- en toda la tabla: un despacho va en UNA hoja y solo una.
  insert into public.delivery_plan_stops
    (id, organization_id, company_id, plan_id, fulfillment_id, sequence)
  select 'b2b00000-0000-4000-8000-000000001121', v_org, v_company,
         'b2b00000-0000-4000-8000-000000001111', f.id, 1
    from public.fulfillments f
   where f.store_id = v_store
     and not exists (select 1 from public.delivery_plan_stops s where s.fulfillment_id = f.id)
   order by f.created_at limit 1
  on conflict (id) do nothing;

  insert into public.delivery_plan_stops
    (id, organization_id, company_id, plan_id, fulfillment_id, sequence)
  select 'b2b00000-0000-4000-8000-000000001122', v_org, v_company,
         'b2b00000-0000-4000-8000-000000001111', f.id, 2
    from public.fulfillments f
   where f.store_id = v_store
     and not exists (select 1 from public.delivery_plan_stops s where s.fulfillment_id = f.id)
   order by f.created_at limit 1
  on conflict (id) do nothing;

  -- Una entrega YA firmada: su parada no vuelve a ofrecer el boton, porque la
  -- tabla es append-only y el segundo intento lo rechazaria un trigger.
  insert into public.proof_of_delivery
    (id, organization_id, company_id, fulfillment_id, stop_id, outcome, received_by, document_id)
  select 'b2b00000-0000-4000-8000-000000001131', v_org, v_company,
         s.fulfillment_id, s.id, 'delivered', 'Ana Recibe', '45678912'
    from public.delivery_plan_stops s
   where s.id = 'b2b00000-0000-4000-8000-000000001121'
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------
  -- Planificacion. Cada linea con SU motivo: es lo que permite discutir la
  -- cifra, y una cifra que no se discute no se corrige.
  -- ---------------------------------------------------------------------------
  insert into public.order_suggestions
    (id, organization_id, company_id, store_id, customer_id, sales_rep_id, status,
     model_code, generated_at)
  values
    ('b2b00000-0000-4000-8000-000000001201', v_org, v_company, v_store, v_cli1,
     'b2b00000-0000-4000-8000-000000000102', 'draft', 'historic_v1', now() - interval '1 day'),
    ('b2b00000-0000-4000-8000-000000001202', v_org, v_company, v_store, v_cli2,
     'b2b00000-0000-4000-8000-000000000102', 'accepted', 'historic_v1', now() - interval '20 days')
  on conflict (id) do nothing;

  insert into public.order_suggestion_items
    (id, organization_id, company_id, suggestion_id, product_id, suggested_quantity,
     reason, last_period_quantity, position)
  values
    ('b2b00000-0000-4000-8000-000000001211', v_org, v_company,
     'b2b00000-0000-4000-8000-000000001201', v_prod1, 12,
     'Compro 12 en los ultimos 30 dias', 12, 0),
    ('b2b00000-0000-4000-8000-000000001212', v_org, v_company,
     'b2b00000-0000-4000-8000-000000001201', v_prod2, 6,
     'Compro 6 en los ultimos 30 dias', 6, 1),
    ('b2b00000-0000-4000-8000-000000001213', v_org, v_company,
     'b2b00000-0000-4000-8000-000000001201', v_prod3, 24,
     'Compro 24 en los ultimos 30 dias', 24, 2)
  on conflict (id) do nothing;

  -- La confianza al lado de la cifra: 400 con 30% y 400 con 90% son decisiones
  -- distintas, y sin ese dato se leen igual. La tercera va sin confianza.
  insert into public.demand_forecasts
    (id, organization_id, company_id, store_id, product_id, territory_id,
     period_start, period_end, forecast_quantity, confidence, model_code)
  values
    ('b2b00000-0000-4000-8000-000000001301', v_org, v_company, v_store, v_prod1,
     'b2b00000-0000-4000-8000-000000000201',
     date_trunc('month', v_hoy)::date,
     (date_trunc('month', v_hoy) + interval '1 month - 1 day')::date, 420, 0.8200, 'naive_v1'),
    ('b2b00000-0000-4000-8000-000000001302', v_org, v_company, v_store, v_prod2,
     'b2b00000-0000-4000-8000-000000000203',
     date_trunc('month', v_hoy)::date,
     (date_trunc('month', v_hoy) + interval '1 month - 1 day')::date, 150, 0.5500, 'naive_v1'),
    ('b2b00000-0000-4000-8000-000000001303', v_org, v_company, v_store, v_prod3, null,
     date_trunc('month', v_hoy)::date,
     (date_trunc('month', v_hoy) + interval '1 month - 1 day')::date, 60, null, 'naive_v1')
  on conflict (id) do nothing;

  raise notice 'Datos de demostracion B2B sembrados para la tienda %.', v_store;
end $$;
