# P06 — Inventario multi-almacén, ATP, movimientos y reservas

## Objetivo

Evolucionar `stock_qty` hacia un dominio de inventario capaz de operar múltiples almacenes/centros y evitar overselling.

## Modelo esperado

Evalúa:

- warehouses
- warehouse_locations si aporta valor
- inventory_levels
- inventory_movements
- inventory_reservations
- reservation_events o historial equivalente si es necesario

## Reglas críticas

1. El inventario se maneja por producto/variante y almacén.
2. Define al menos:
   - on_hand
   - reserved
   - available/ATP derivado de forma consistente
3. No permitas cantidades negativas salvo política explícita de backorder.
4. Los movimientos deben ser trazables e idempotentes por referencia de negocio cuando provienen de eventos externos.
5. Reservar stock debe ser transaccional y tolerante a concurrencia.
6. Checkout no debe hacer `SELECT stock` + `UPDATE stock` vulnerable a race conditions.
7. Define expiración/liberación de reservas si el flujo lo necesita.
8. Crea un `InventoryPort` para permitir fuente local, ERP o híbrida sin acoplar checkout.
9. Define estrategia de fallback/degradación si un ERP de stock está temporalmente caído; no inventes disponibilidad.
10. Mantén transición desde `products.stock_qty` sin romper pedidos existentes.
11. UI admin para stock por almacén, movimientos y alertas básicas.
12. Tests de concurrencia, reserva, liberación, tenant A/B, multiwarehouse y bundle si P03 lo soporta.
13. Índices para consultas por SKU/warehouse y disponibilidad.

## Definition of Done

PASS si dos checkouts concurrentes no pueden vender el mismo stock reservado y el core puede trabajar con uno o varios almacenes.
