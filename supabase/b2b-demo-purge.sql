-- =============================================================================
-- Retira los datos de demostracion B2B. Solo DEV.
--
--   node scripts/apply-demo-data.mjs --file supabase/b2b-demo-purge.sql
--
-- Borra por PREFIJO de UUID (`b2b00000-…`), que es lo unico que distingue lo
-- sembrado de lo real. Nada de `truncate`: estas tablas comparten esquema con
-- lo que un tenant escriba probando, y vaciarlas entero se llevaria por delante
-- lo que el operador acabe de crear a mano.
--
-- El orden es hijo -> padre porque las FK son `restrict` en varios sitios.
--
-- `proof_of_delivery` NO se puede borrar: `pod_is_immutable` rechaza el DELETE,
-- y esa es exactamente la propiedad que la hace valer como prueba. Si de verdad
-- hace falta quitarla en DEV, hay que deshabilitar el trigger a proposito:
--
--   alter table public.proof_of_delivery disable trigger proof_of_delivery_immutable;
--   delete from public.proof_of_delivery where id::text like 'b2b00000%';
--   alter table public.proof_of_delivery enable  trigger proof_of_delivery_immutable;
--
-- Se deja fuera del script a proposito: que cueste un paso extra es la señal de
-- que se esta rompiendo una garantia, no un descuido.
-- =============================================================================

delete from public.order_suggestion_items where id::text like 'b2b00000%';
delete from public.order_suggestions      where id::text like 'b2b00000%';
delete from public.demand_forecasts       where id::text like 'b2b00000%';

delete from public.delivery_plan_stops    where id::text like 'b2b00000%';
delete from public.delivery_plans         where id::text like 'b2b00000%';
delete from public.delivery_vehicles      where id::text like 'b2b00000%';

delete from public.assortment_assignments where id::text like 'b2b00000%';
delete from public.assortment_items       where id::text like 'b2b00000%';
delete from public.assortments            where id::text like 'b2b00000%';

-- Las lineas de una cotizacion cerrada tampoco se dejan tocar. Se reabre a
-- borrador primero, que es lo que `quote_status_guard` permite desde el estado
-- en el que las dejo el sembrado.
update public.quotes set status = 'draft'
 where id::text like 'b2b00000%' and status <> 'draft';
delete from public.quote_items            where id::text like 'b2b00000%';
delete from public.quotes                 where id::text like 'b2b00000%';

delete from public.invoices               where id::text like 'b2b00000%';
delete from public.ar_applications        where id::text like 'b2b00000%';
delete from public.ar_receipts            where id::text like 'b2b00000%';
delete from public.ar_documents           where id::text like 'b2b00000%';

delete from public.commission_statements  where id::text like 'b2b00000%';
delete from public.commission_rules       where id::text like 'b2b00000%';
delete from public.sales_goals            where id::text like 'b2b00000%';
delete from public.sales_visits           where id::text like 'b2b00000%';
delete from public.sales_route_stops      where id::text like 'b2b00000%';
delete from public.sales_routes           where id::text like 'b2b00000%';
delete from public.sales_rep_territories  where id::text like 'b2b00000%';
delete from public.sales_territories      where id::text like 'b2b00000%';
delete from public.sales_rep_customers    where id::text like 'b2b00000%';
delete from public.sales_reps             where id::text like 'b2b00000%';
