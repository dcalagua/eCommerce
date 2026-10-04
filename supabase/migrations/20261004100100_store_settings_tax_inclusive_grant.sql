-- ===========================================================================
-- `tax_inclusive` se puede escribir desde Ajustes (2026-10-04)
--
-- El 2026-10-02 el interruptor «Los precios ya incluyen el impuesto» entró en
-- el formulario de Ajustes, que envía TODAS sus columnas en un solo UPDATE.
-- Pero `store_settings` tiene el UPDATE concedido COLUMNA POR COLUMNA desde
-- 20260828140200 y `tax_inclusive` —que ya existía, sin pantalla— no estaba en
-- la lista: el UPDATE entero fallaba con 42501 y Ajustes dejó de guardar
-- («Tu rol no puede cambiar la configuración de la tienda») en toda tienda.
--
-- No quedó fuera a propósito: aquella lista deja fuera lo que NO debe tocar el
-- comercio (verificación del dominio propio). Que los precios lleven o no el
-- impuesto es regla de negocio del comercio, como `tax_rate`, que sí está. La
-- fila sigue protegida por su RLS (solo owner/admin del tenant del JWT).
-- ===========================================================================

grant update (tax_inclusive) on public.store_settings to authenticated;
