# P14 — API empresarial, webhooks e Integration Monitor

## Objetivo

Convertir el framework de integraciones existente en una superficie enterprise mantenible, documentada y observable.

## Primero

Reutiliza el framework actual de:

- provider registry
- tenant integrations
- inbox/outbox
- idempotency
- retries/backoff/jitter
- dead-letter
- circuit breaker

No construyas otro sistema paralelo.

## API empresarial

Distingue contratos:

- Browser API
- Public Storefront API
- Partner/Enterprise API

Para la API enterprise prepara:

- versionado
- HTTPS assumptions documentadas
- OAuth 2.0 / mecanismo autorizado por la plataforma
- scopes/permissions
- rate limiting
- idempotency keys
- correlation IDs
- OpenAPI generado o mantenible
- errores canónicos

No expongas Supabase como contrato empresarial directo si eso acopla a clientes externos.

## Webhooks

- subscriptions por tenant/evento
- secret/signature por endpoint usando referencia segura
- delivery attempts
- retry/backoff
- dead-letter
- replay autorizado
- idempotency/event id

## Integration Monitor

Construye un backoffice profesional para:

- provider health
- mensajes pendientes
- processing
- failed/dead-letter
- última ejecución
- attempts
- next retry
- correlation id
- circuit state
- detalle sanitizado
- manual retry/replay con permiso y auditoría

No mostrar secretos ni payloads sensibles completos.

## Enterprise readiness

Mantén nombres canónicos como `order.create`, `stock.read`, `invoice.get`, etc. Los nombres BAPI/API del proveedor viven únicamente dentro de adapters.

## Tests

OAuth/scope boundary donde pueda probarse localmente, webhook signatures, replay, tenant isolation, redaction, duplicate event y monitor permissions.

## Definition of Done

PASS si añadir SAP/ERP/pago/logística/mensajería como providers no requiere modificar el core y la operación de fallos es visible y recuperable.
