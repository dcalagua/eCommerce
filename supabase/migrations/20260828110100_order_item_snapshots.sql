-- =============================================================================
-- P08-SaaS · 2/7 — La linea del pedido termina de congelar lo que se vendio
--
-- `order_items` ya era un snapshot parcial desde P02: guarda `sku`, `name`,
-- `unit_price` y, desde P03, `uom_code` y `uom_factor`. Lo que faltaba es
-- justamente lo que el criterio de aceptacion de esta fase pregunta:
--
--  · **el impuesto de la linea**. Hasta hoy el pedido solo guardaba el
--    `tax_total` agregado. Si mañana el tenant cambia la tasa de una categoria
--    —o reasigna el producto a otra categoria fiscal— no hay forma de rehacer
--    el desglose del pedido de ayer: los importes cuadran, pero nadie puede
--    decir POR QUE. Con `tax_rate` y `tax_amount` en la linea, la factura se
--    reconstruye desde el pedido y no desde la configuracion actual.
--
--  · **el descuento de la linea**. P10 traera el motor de promociones; sin
--    columnas donde escribirlo, ese motor tendria que meter el descuento
--    dentro de `unit_price` y el pedido perderia la distincion entre «costaba
--    menos» y «se le aplico una promocion».
--
--  · **la variante**. `name` guarda «Producto · Talla M» concatenado, que se
--    lee pero no se consulta. `variant_label` y `variant_attributes` dejan la
--    combinacion consultable aunque la variante se borre del catalogo.
--
--  · **la receta del kit**. Un `kind = 'bundle'` no tiene existencia propia:
--    tiene componentes. Cambiar la receta despues de vender deja al pedido sin
--    forma de decir que se despacho, que es exactamente lo que P12 necesitara
--    para aceptar una devolucion.
--
-- ## Por que las columnas fiscales son NULLABLE y sin default
--
-- Porque `0` no es «no habia impuesto», es «el impuesto era cero», y las lineas
-- anteriores a esta migracion no registraron ni una cosa ni la otra. NULL dice
-- la verdad: no se sabe. `discount_amount` si nace `not null default 0`, y ahi
-- el cero SI es correcto — antes de P10 no existian los descuentos de linea.
-- =============================================================================

alter table public.order_items
  -- ---- Variante ----------------------------------------------------------
  add column variant_label      text,
  add column variant_attributes jsonb not null default '{}'::jsonb,
  -- ---- Impuesto (snapshot fiscal) ----------------------------------------
  add column tax_rate          numeric(6,4),
  add column tax_amount        numeric(14,2),
  add column tax_inclusive     boolean,
  add column tax_category_code text,
  -- ---- Descuento ---------------------------------------------------------
  add column discount_amount   numeric(14,2) not null default 0,
  -- Que descuentos se aplicaron y por que. Array de objetos; P10 lo llena.
  add column discount_snapshot jsonb not null default '[]'::jsonb,
  -- ---- Trazabilidad del precio -------------------------------------------
  -- `price_list_id` pierde el enlace cuando la lista se borra (P04). El CODIGO
  -- no: «lo puso la lista MAYORISTA» sigue siendo la respuesta util cuando
  -- alguien reclama tres meses despues.
  add column price_list_code text,
  -- ---- Kit ---------------------------------------------------------------
  add column components_snapshot jsonb not null default '[]'::jsonb,
  -- ---- El importe de la linea despues del descuento -----------------------
  -- GENERATED, igual que `line_total`: `line_total` sigue siendo el BRUTO
  -- (precio x cantidad) y no cambia de significado para ninguno de sus
  -- lectores; esta es lo mismo menos el descuento. Dos columnas generadas y
  -- ningun importe que el cliente pueda enviar.
  --
  -- El nombre NO es `net_amount` a proposito: en el vocabulario del motor de
  -- precios (P04) «neto» significa «sin impuesto», y con `tax_inclusive` las
  -- dos lecturas dan numeros distintos. La base imponible de la linea es
  -- `amount_after_discount - tax_amount` cuando el impuesto va incluido, y
  -- `amount_after_discount` cuando no; queda escrito aqui y no en un nombre
  -- que cada lector interpretaria a su manera.
  add column amount_after_discount numeric(14,2)
    generated always as (round(unit_price * quantity, 2) - discount_amount) stored;

alter table public.order_items
  add constraint order_items_tax_signs check (
    (tax_rate is null or (tax_rate >= 0 and tax_rate <= 1))
    and (tax_amount is null or tax_amount >= 0)
  ),
  add constraint order_items_discount_sign check (discount_amount >= 0),
  -- Un descuento mayor que la linea convertiria el pedido en un ingreso
  -- negativo sin que nadie lo decidiera.
  add constraint order_items_discount_bounded
    check (discount_amount <= round(unit_price * quantity, 2)),
  add constraint order_items_variant_label_len
    check (variant_label is null or char_length(btrim(variant_label)) between 1 and 200),
  add constraint order_items_tax_category_len
    check (tax_category_code is null or char_length(btrim(tax_category_code)) between 1 and 60),
  add constraint order_items_price_list_code_len
    check (price_list_code is null or char_length(btrim(price_list_code)) between 1 and 60),
  add constraint order_items_snapshot_shapes check (
    jsonb_typeof(variant_attributes) = 'object'
    and jsonb_typeof(discount_snapshot) = 'array'
    and jsonb_typeof(components_snapshot) = 'array'
  );

-- ---------------------------------------------------------------------------
-- ebim.assert_order_item_immutable — una linea vendida no se reescribe
--
-- `order_items` nunca tuvo GRANT de escritura para `authenticated` ni para
-- `anon`, asi que desde el navegador ya era imposible. Lo que este trigger
-- añade es la segunda linea, la que tambien detiene a `service_role`: el
-- snapshot es el fundamento del criterio de aceptacion y no puede depender de
-- que ninguna Edge Function futura se acuerde.
--
-- Lo unico editable de una linea es NADA. Corregir un pedido es cancelarlo y
-- volver a crearlo, que es lo que hace un comercio serio y lo que deja rastro.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_order_item_immutable()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  -- La excepcion son las FK con `on delete set null`: borrar el producto, la
  -- variante o la lista de precio ANULA el enlace y conserva el snapshot. Ese
  -- UPDATE lo hace Postgres, no una aplicacion, y es justo lo que queremos.
  if (new.product_id     is not distinct from old.product_id
      or new.product_id is null)
     and (new.variant_id is not distinct from old.variant_id
      or new.variant_id is null)
     and (new.price_list_id is not distinct from old.price_list_id
      or new.price_list_id is null)
     and (new.sku, new.name, new.unit_price, new.quantity, new.uom_code,
          new.uom_factor, new.variant_label, new.variant_attributes,
          new.tax_rate, new.tax_amount, new.tax_inclusive, new.tax_category_code,
          new.discount_amount, new.discount_snapshot, new.price_source,
          new.price_list_code, new.components_snapshot,
          new.order_id, new.store_id, new.organization_id, new.company_id)
         is not distinct from
         (old.sku, old.name, old.unit_price, old.quantity, old.uom_code,
          old.uom_factor, old.variant_label, old.variant_attributes,
          old.tax_rate, old.tax_amount, old.tax_inclusive, old.tax_category_code,
          old.discount_amount, old.discount_snapshot, old.price_source,
          old.price_list_code, old.components_snapshot,
          old.order_id, old.store_id, old.organization_id, old.company_id)
  then
    return new;
  end if;

  raise exception 'ORDER_ITEM_INMUTABLE: la linea de un pedido es un snapshot; corregir un pedido es cancelarlo y rehacerlo'
    using errcode = '23514';
end;
$fn$;

create trigger order_items_assert_immutable
  before update on public.order_items
  for each row execute function ebim.assert_order_item_immutable();

create index order_items_tax_rate_idx on public.order_items (order_id, tax_rate);

comment on column public.order_items.tax_rate is
  'SNAPSHOT de la tasa aplicada a esta linea. NULL = linea anterior a P08: no se registro. Cero significa "sin impuesto", que no es lo mismo.';
comment on column public.order_items.tax_amount is
  'SNAPSHOT del impuesto de la linea. Permite rehacer el desglose del pedido sin volver a mirar la configuracion fiscal actual.';
comment on column public.order_items.amount_after_discount is
  'GENERATED: line_total - discount_amount. line_total sigue siendo el bruto. Base imponible = esta menos tax_amount si tax_inclusive, y esta misma si no.';
comment on column public.order_items.price_list_code is
  'SNAPSHOT del codigo de la lista que fijo el precio. price_list_id pierde el enlace al borrarla; este texto no.';
comment on column public.order_items.components_snapshot is
  'Receta del kit EN EL MOMENTO de la venta. Un bundle no tiene existencia propia: sin esto, cambiar la receta borra lo que se despacho.';
comment on column public.order_items.variant_attributes is
  'Combinacion de atributos de la variante vendida (talla, color...). Consultable aunque la variante se borre del catalogo.';
