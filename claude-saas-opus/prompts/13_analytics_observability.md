# P13 — Analytics, auditoría y observabilidad operativa

## Objetivo

Hacer operable y medible el SaaS sin acoplar analítica comercial a logs técnicos ni exponer información entre tenants.

## Analytics comercial

Define eventos canónicos y/o agregaciones para:

- product_view
- search
- add_to_cart
- checkout_started
- checkout_completed
- cart_abandoned cuando sea inferible
- order_created
- order_completed
- promotion_used

No envíes PII innecesaria a analytics.

Crea KPIs reales y exportables:

- ventas
- pedidos
- ticket promedio
- conversión cuando la métrica tenga denominador confiable
- abandono cuando pueda calcularse correctamente
- productos más vendidos
- rendimiento por canal

No inventes métricas si faltan datos.

## Auditoría

1. Operaciones sensibles deben registrar actor, acción, entidad, timestamp, tenant/company y correlation id.
2. Auditoría debe ser append-only para usuarios normales.
3. No registres secretos ni tokens.
4. Soporte cross-tenant, si existe, requiere trazabilidad explícita y autorización fuerte.

## Observabilidad

Implementa una convención para:

- structured logs
- correlation_id / request_id
- métricas
- health checks
- integration queue depth
- failed checkout/payment/integration
- slow operations

No dependas de un vendor único: crea puntos de integración.

## Operación

Agrega una pantalla admin/operador para health relevante al tenant sin revelar datos de otros tenants.

## Tests

Audit append-only, tenant isolation, correlation propagation y eventos críticos sin PII/secretos.

## Definition of Done

PASS si un incidente de checkout/integración puede rastrearse end-to-end con correlation id y los KPIs mostrados tienen datos reales.
