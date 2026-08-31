-- =============================================================================
-- Vaciado del tenant de DEMOSTRACION.
--
-- Para que existe: los fixtures (`seed.sql`, `demo-data.sql`) son idempotentes
-- por `on conflict (id) do nothing`, que es lo correcto para poder repetirlos
-- —pero significa que NO actualizan nada. Cambiar el cliente de la demo (de una
-- mueblería a una botica) es cambiar nombres, categorias y catalogo sobre filas
-- que ya existen, y para eso hay que vaciarlas primero.
--
-- SOLO toca la organizacion de demo `d0000000-…-000000000001`. El tenant B, que
-- es el que prueba el aislamiento entre inquilinos, no se menciona ni una vez:
-- si este script pudiera vaciarlo, seria el propio script el que enmascara una
-- fuga de RLS el dia que la haya.
--
-- **Lo que NO borra: la historia.** Pedidos, cobros y sus bitacoras se quedan
-- —`payment_events`, `analytics_events`, `audit_log` y compania son APPEND-ONLY
-- por trigger, y rechazan el borrado incluso a `service_role`—. Es la garantia
-- entera de esas tablas: una auditoria que se puede vaciar no vale como
-- auditoria. La consecuencia practica hay que saberla: los pedidos anteriores
-- siguen contando lo que se vendio entonces, y la analitica de ese periodo
-- sigue siendo la del cliente viejo.
--
-- Por lo mismo, todo lo que la historia todavia necesita —el cliente que hizo
-- un pedido, el metodo de pago con el que se cobro— se borra SOLO si ya no lo
-- referencia nadie (`not exists`). Asi el vaciado nunca falla a medias: lo que
-- sobrevive es exactamente lo que sostiene un pedido.
--
-- El orden es de la hoja a la raiz. Muchas de estas tablas caerian solas por
-- `on delete cascade`, pero se nombran igual: un borrado que depende de que
-- todas las claves ajenas esten bien declaradas es un borrado que falla el dia
-- que una no lo esta, y aqui el fallo seria a medias.
--
--   node scripts/apply-demo-data.mjs --file supabase/demo-purge.sql
-- =============================================================================

do $$
declare
  v_org uuid := 'd0000000-0000-4000-8000-000000000001';
begin

-- ----- Trafico y observabilidad -------------------------------------------
-- `analytics_events` y `audit_log` NO se tocan: son bitacoras APPEND-ONLY y un
-- trigger rechaza el borrado incluso a `service_role` (`ANALITICA_INMUTABLE`,
-- `BITACORA_INMUTABLE`). No es un olvido, es la garantia entera de esas tablas:
-- una auditoria que se puede vaciar no vale como auditoria.
delete from public.ops_events          where organization_id = v_org;
delete from public.domain_events       where organization_id = v_org;
delete from public.public_rate_events  where organization_id = v_org;

-- ----- Integraciones -------------------------------------------------------
delete from public.webhook_deliveries    where organization_id = v_org;
delete from public.webhook_subscriptions where organization_id = v_org;
delete from public.webhook_endpoints     where organization_id = v_org;
delete from public.integration_outbox    where organization_id = v_org;
delete from public.integration_inbox     where organization_id = v_org;
delete from public.integration_messages  where organization_id = v_org;
delete from public.integration_circuit   where organization_id = v_org;
delete from public.tenant_integrations   where organization_id = v_org;
delete from public.api_requests          where organization_id = v_org;
delete from public.api_idempotency       where organization_id = v_org;
delete from public.api_access_tokens     where organization_id = v_org;
delete from public.api_clients           where organization_id = v_org;

-- ----- Postventa: devoluciones y entregas ----------------------------------
-- Igual que arriba: `return_events` y `tracking_events` son append-only, y con
-- ellos se quedan la devolucion y el envio de los que cuelgan.
-- Devoluciones y envios se quedan enteros con su pedido: sus hechos son
-- append-only y una cabecera sin lineas seria peor que dejarla como esta.
delete from public.reconciliation_records where organization_id = v_org;

-- ----- Pedidos y cobros: NO SE BORRAN --------------------------------------
-- Un pedido cobrado arrastra `payment_events` y `payment_attempts`, que son
-- append-only con trigger; borrar el pedido dispararia el trigger en cascada y
-- el vaciado entero se quedaria a medias. Asi que la historia se queda.
--
-- Lo que eso significa en la demo, dicho claro: los pedidos anteriores al
-- cambio de cliente conservan las lineas del catalogo viejo —la analitica de
-- ese periodo sigue contando lo que se vendio entonces— y los productos a los
-- que apuntaban quedan en `null` (`order_items.product_id` es `on delete set
-- null`), que es justo para lo que se guarda el nombre y el SKU en la propia
-- linea. Para arrancar de verdad de cero hay que recrear el proyecto.
-- Los intentos de compra que NO acabaron en pedido no son historia de nadie:
-- se van con el catalogo al que apuntaban.
delete from public.checkout_attempts    where organization_id = v_org;
delete from public.checkout_intents     where organization_id = v_org and order_id is null;
delete from public.cart_items           where organization_id = v_org;
delete from public.carts                where organization_id = v_org;
delete from public.inventory_reservation_items where organization_id = v_org;
delete from public.inventory_reservations      where organization_id = v_org;

-- ----- Promociones ---------------------------------------------------------
delete from public.promotion_redemptions where organization_id = v_org;
delete from public.promotion_events      where organization_id = v_org;
delete from public.promotion_audiences   where organization_id = v_org;
delete from public.promotion_tiers       where organization_id = v_org;
delete from public.promotion_scopes      where organization_id = v_org;
delete from public.coupons               where organization_id = v_org;
delete from public.gift_card_transactions where organization_id = v_org;
delete from public.gift_cards            where organization_id = v_org;
delete from public.promotions p where p.organization_id = v_org
  and not exists (select 1 from public.promotion_redemptions r where r.promotion_id = p.id);

-- ----- Contenido -----------------------------------------------------------
delete from public.content_block_items where organization_id = v_org;
delete from public.content_blocks      where organization_id = v_org;
delete from public.content_pages       where organization_id = v_org;
delete from public.search_synonyms     where organization_id = v_org;

-- ----- Precios -------------------------------------------------------------
delete from public.price_change_events    where organization_id = v_org;
delete from public.price_list_items       where organization_id = v_org;
delete from public.price_list_assignments where organization_id = v_org;
delete from public.price_lists            where organization_id = v_org;

-- ----- Entregas: configuracion ---------------------------------------------
delete from public.delivery_windows  where organization_id = v_org;
delete from public.delivery_rates    where organization_id = v_org;
delete from public.pickup_points     where organization_id = v_org;
delete from public.delivery_zones    where organization_id = v_org;
delete from public.delivery_methods d where d.organization_id = v_org
  and not exists (select 1 from public.fulfillments f where f.delivery_method_id = d.id);
delete from public.return_reasons r where r.organization_id = v_org
  and not exists (select 1 from public.return_requests q where q.reason_code = r.code
                   and q.organization_id = r.organization_id);
delete from public.payment_methods m where m.organization_id = v_org
  and not exists (select 1 from public.payment_intents i where i.payment_method_id = m.id);

-- ----- Inventario ----------------------------------------------------------
delete from public.inventory_movements where organization_id = v_org;
delete from public.inventory_levels    where organization_id = v_org;
delete from public.store_warehouses    where organization_id = v_org;
delete from public.warehouses w where w.organization_id = v_org
  and not exists (select 1 from public.fulfillments f where f.warehouse_id = w.id)
  and not exists (select 1 from public.inventory_reservation_items r where r.warehouse_id = w.id);

-- ----- Clientes ------------------------------------------------------------
delete from public.approval_rules          where organization_id = v_org;
delete from public.business_locations      where organization_id = v_org;
delete from public.business_account_users  where organization_id = v_org;
delete from public.business_accounts       where organization_id = v_org;
delete from public.customer_external_ids   where organization_id = v_org;
delete from public.customer_contacts       where organization_id = v_org;
delete from public.customer_addresses      where organization_id = v_org;
-- Un pedido guarda el correo y el nombre del comprador en la propia fila, no
-- una clave ajena al cliente: la ficha se puede borrar sin tocar la historia.
delete from public.customers               where organization_id = v_org;
delete from public.customer_segments       where organization_id = v_org;

-- ----- Catalogo y PIM ------------------------------------------------------
delete from public.product_relations         where organization_id = v_org;
delete from public.bundle_items              where organization_id = v_org;
delete from public.product_channels          where organization_id = v_org;
delete from public.variant_attribute_values  where organization_id = v_org;
delete from public.product_attribute_values  where organization_id = v_org;
delete from public.product_uoms              where organization_id = v_org;
delete from public.product_variants          where organization_id = v_org;
-- Las filas de `product_images` se van con el producto; los objetos del bucket
-- quedan huerfanos A PROPOSITO: el sembrador de fotos los reutiliza y volver a
-- bajarlos de Commons seria media hora de limitador ajeno para lo mismo.
delete from public.product_images            where organization_id = v_org;
delete from public.products                  where organization_id = v_org;
delete from public.categories                where organization_id = v_org;
delete from public.attribute_values          where organization_id = v_org;
delete from public.attributes                where organization_id = v_org;
delete from public.units_of_measure          where organization_id = v_org;
delete from public.product_families          where organization_id = v_org;
delete from public.brands                    where organization_id = v_org;

-- ----- Impuestos y monedas -------------------------------------------------
delete from public.tax_rates          where organization_id = v_org;
delete from public.tax_categories     where organization_id = v_org;
delete from public.tenant_currencies  where organization_id = v_org;

-- ----- Identidad de la tienda ----------------------------------------------
-- Las tiendas y el tenant NO se borran: de ellos cuelga la pertenencia del
-- usuario que entra al backoffice, y borrarlos dejaria al operador de la demo
-- sin cuenta a la que volver. Se RENOMBRAN, que es lo que el cambio de cliente
-- pedia de verdad.
delete from public.store_settings where organization_id = v_org;

update public.stores
   set slug = 'miquimica', name = 'MiQuímica'
 where organization_id = v_org and slug = 'casa-nordica';

update public.stores
   set slug = 'botica-cerrada', name = 'Botica Cerrada'
 where organization_id = v_org and slug = 'taller-cerrado';

update public.tenants
   set slug = 'miquimica', name = 'MiQuímica', admin_email = 'admin@miquimica.demo'
 where organization_id = v_org;

end $$;
