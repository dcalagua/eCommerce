# P08 — OMS: pedidos, estados, fulfillment y snapshots inmutables

## Objetivo

Fortalecer Order Management para soportar crecimiento B2C/B2B y posteriores integraciones sin perder trazabilidad histórica.

## Trabajo

1. Revisa el modelo actual de orders/order_items y conserva compatibilidad.
2. Separa conceptos cuando sea necesario:
   - order_status
   - payment_status
   - fulfillment_status
   - source_channel
3. Mantén snapshots inmutables de:
   - nombre/SKU/variante/UoM
   - precio unitario
   - descuentos
   - impuestos
   - dirección
   - cliente relevante
4. Agrega external references desacopladas por provider/sistema.
5. Modela order timeline/event history inmutable.
6. Modela notes/tags internos si aportan operación real.
7. Define comandos de transición de estado y una máquina de estados explícita; no permitas saltos arbitrarios desde UI.
8. Los cambios críticos pasan por servidor y generan auditoría/evento.
9. Prepara:
   - pedidos programados
   - repeat order
   - import/bulk order
   como capacidades extensibles, sin implementar todo si excede el alcance.
10. Si existe B2B approval foundation, integra el concepto de orden pendiente de aprobación sin contaminar B2C.
11. Backoffice: listado paginado, búsqueda, tabs de estado, detalle legible, timeline y acciones con loading.
12. Exportación debe respetar tenant y permisos.
13. Tests de transiciones, snapshots, tenant isolation y acceso por token del comprador actual.

## Definition of Done

PASS si el historial de un pedido sigue siendo correcto aunque cambien producto, precio, impuestos o configuración después de comprar.
