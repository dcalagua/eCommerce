-- =============================================================================
-- P08-SaaS · 7/7 — Pedidos programados, repeticion e importacion masiva:
--                  la CAPACIDAD se registra, las tablas NO se inventan
--
-- El encargo pide «preparar» las tres como capacidades extensibles «sin
-- implementar todo si excede el alcance». Preparar, en este repositorio, tiene
-- un significado concreto y ya hay precedente: P06 declaro que
-- `warehouse_locations` y `reservation_events` **no se creaban**, y dejo escrito
-- el disparador de cada una. Crear hoy `order_schedules` y `order_batches`
-- vacias seria peor que no crearlas: dos tablas con RLS, indices y tests que
-- nadie escribe ni lee, y que el dia que exista el caso de uso real habra que
-- rehacer porque se diseñaron sin el.
--
-- Lo que SI se hace es dejar puestos los enganches que cuestan poco y que sin
-- ellos obligarian a migrar datos despues:
--
--  1. **`orders.source_channel` ya tiene los tres valores** —`scheduled`,
--     `repeat`, `import`— en su enum (migracion 110000). Ampliar un enum es
--     barato; reclasificar pedidos ya creados que nacieron todos como
--     `storefront` no lo es, porque la informacion no existe.
--
--  2. **`order_external_refs` ya sabe de donde vino cada pedido importado**
--     (migracion 110300): `system_code` + `ref_type = 'import_batch'` y el
--     identificador del lote. Una tabla de lotes propia no aporta nada mientras
--     el lote sea un identificador; aportara cuando tenga estado y errores por
--     fila, y ese es el momento de crearla.
--
--  3. **La idempotencia de una carga masiva ya existe**: `checkout_intents`
--     ancla una compra a una clave (P07). Una importacion de mil pedidos es mil
--     claves, no un mecanismo nuevo.
--
--  4. **La repeticion de un pedido no necesita esquema**: las lineas de un
--     pedido son un snapshot y `cart_replace_lines` (P07) acepta exactamente esa
--     forma. Lo que falta es la pantalla, no la tabla.
--
-- Lo que SI hace falta el dia que se implementen —y por eso la capacidad nace
-- ahora y no despues— es un sitio donde el hub diga si la sociedad las tiene
-- contratadas. Una capacidad que aparece el mismo dia que su codigo obliga a
-- desplegar las dos cosas a la vez; declararla antes permite que el operador
-- de alta el addon en el hub cuando quiera.
-- =============================================================================

insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state) values
  ('orders.advanced', 'orders', false, 'ecommerce.orders.advanced', 'declared')
on conflict (code) do nothing;

comment on table public.app_capabilities is
  'Registro TECNICO de lo que esta app sabe hacer. Global y sin tenant: el catalogo COMERCIAL (planes, precios) es del hub y no se replica.';
