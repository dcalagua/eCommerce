# P09 — Payments abstraction, intentos, refunds y conciliación base

## Objetivo

Crear un dominio de pagos agnóstico de banco/pasarela, listo para adapters locales o internacionales y compatible con PCI por delegación.

## Contrato

Define `PaymentProvider` o equivalente con operaciones canónicas según necesidad real:

- create/authorize
- capture
- cancel/void
- refund
- getStatus
- verifyWebhook

No todos los providers deben implementar todos los modos; expresa capabilities explícitamente.

## Modelo

Evalúa:

- payment_methods (config pública, no secretos)
- payment_intents / payment_attempts
- payments
- refunds
- payment_events
- reconciliation_records

## Reglas críticas

1. Nunca almacenar PAN/CVV ni datos completos de tarjeta.
2. Tokens del proveedor se tratan como secretos/sensibles y con exposición mínima.
3. Secretos de providers viven en vault/secrets, en DB solo referencias si el estándar actual lo establece.
4. Webhooks deben ser firmados/verificados e idempotentes.
5. Un callback repetido no duplica captura, refund ni transición de orden.
6. Payment status no se deriva de una redirección del browser.
7. Separar autorización/captura cuando el provider lo soporte.
8. Integrar con el framework de providers/inbox/outbox existente, no crear una segunda arquitectura paralela.
9. Preparar conciliación por external reference/settlement, sin hardcode de un banco concreto.
10. UI admin: estado, intentos, fallos, referencia, refund autorizado y trazabilidad, sin mostrar secretos.
11. Tests con FakePaymentProvider determinístico: success, decline, timeout, duplicate webhook, refund, tenant A/B.

## Definition of Done

PASS si el checkout puede usar un provider fake mediante contrato canónico y añadir un proveedor real no requiere modificar el dominio de pedidos.
