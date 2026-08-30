# P12 — Fulfillment, logística, ventanas de entrega y devoluciones

## Objetivo

Crear un dominio logístico agnóstico de operador que pueda soportar despacho, retiro, tracking y returns asistidos.

## Modelo/contratos

Evalúa:

- fulfillments
- shipments
- shipment_items
- delivery_zones
- delivery_methods
- delivery_windows
- pickup_points
- tracking_events
- returns / return_requests
- return_items

Crea `FulfillmentProvider` o `ShippingProvider` solo en la frontera externa real.

## Reglas

1. Pedido y fulfillment son entidades relacionadas pero no idénticas.
2. Permite fulfillment parcial si la arquitectura no lo impide.
3. Coste y disponibilidad de método de entrega se resuelven servidor.
4. Selección de almacén debe apoyarse en InventoryPort y reglas configurables.
5. Tracking externo se normaliza a eventos canónicos.
6. Webhooks de operador son idempotentes y auditados.
7. Pickup/office delivery debe ser una estrategia, no un checkout separado.
8. Returns Fase base:
   - solicitud
   - motivos
   - aprobación/rechazo
   - estado
   - items/cantidades
   - evidencia opcional segura
   - integración financiera/ERP mediante puerto, no hardcode
9. No implementes una nota de crédito de un ERP específico dentro del core.
10. Backoffice: cola de fulfillment/returns, filtros simples, detalle, timeline y acciones autorizadas.
11. Tests de parcial, duplicate tracking event, return quantity, tenant A/B y transiciones.

## Definition of Done

PASS si se puede conectar un operador logístico nuevo mediante adapter y el ciclo de entrega/devolución conserva trazabilidad.
