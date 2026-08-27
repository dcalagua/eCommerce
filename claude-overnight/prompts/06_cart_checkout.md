Lee CLAUDE.md y docs/STATE.md. Ejecuta P06 siguiendo Drive.

Flujo: producto -> carrito -> checkout -> orden.

Carrito:
agregar/quitar, cantidad, subtotal, localStorage por store, Cart Drawer, impedir mezclar tiendas.

Checkout minimo:
nombre, email, telefono, direccion, referencia opcional.
No pasarela de pago aun.

Confirmacion llama create-order Edge Function. Servidor debe resolver store, validar productos/publicacion/cantidades, obtener precios actuales DB, recalcular subtotal/total, ignorar precios del cliente, insertar order + items transaccionalmente y generar order_number.
Estado inicial pending salvo estandar EBIM distinto.

Pantalla confirmacion, evitar doble submit y manejar errores.
Tests de calculo server-side y flujo + lint + typecheck + build. No deploy. Actualiza STATE.md. Commit: feat: add cart checkout and order creation
Salida <= 10 lineas.
