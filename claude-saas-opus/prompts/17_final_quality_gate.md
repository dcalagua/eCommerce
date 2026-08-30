# P17 — Quality Gate final y baseline releaseable del SaaS

## Objetivo

Verificar todo el trabajo P00-P16 y dejar una base técnicamente defendible para iniciar customizaciones de clientes sin arrastrar deuda crítica invisible.

## No nuevas features

En esta fase NO agregues funcionalidades de producto salvo correcciones necesarias para pasar gates o cerrar inconsistencias creadas por fases anteriores.

## Verificaciones obligatorias

1. `npm run typecheck`
2. `npm run lint`
3. `npm run test`
4. `npm run test:db`
5. `npm run build`
6. Si existen E2E, ejecuta el conjunto crítico apropiado.
7. Revisa migraciones:
   - orden
   - inmutabilidad
   - reproducibilidad
   - RLS
   - indexes/FKs
8. Revisa que no exista `service_role` en bundle/frontend.
9. Busca secretos/tokens/passwords accidentales en archivos versionados.
10. Revisa que no existan hacks por nombre/UUID de cliente.
11. Revisa que módulos/capabilities no se autoricen solo desde UI.
12. Revisa que checkout/pricing/inventory/payment sean server-authoritative.
13. Revisa idempotencia en checkout, pagos, webhooks e integraciones.
14. Revisa tenant isolation en tablas nuevas.
15. Revisa loading/error/empty/unauthorized en pantallas nuevas.
16. Revisa accesibilidad básica y mobile en storefront/backoffice.
17. Revisa que adapters externos no contaminen contratos canónicos.

## Recorridos mínimos

- login / tenant context / admin
- catálogo simple y variante
- precios por contexto
- cliente/cuenta B2B
- inventario/reserva
- storefront -> cart -> checkout -> order
- pago con fake provider si existe
- promoción
- fulfillment/tracking base
- integración fallida -> monitor -> retry
- acceso de otro tenant denegado

## Entregables

Crea/actualiza:

- `docs/SAAS_RELEASE_BASELINE.md`
- `docs/SAAS_GAPS.md`
- `docs/STATE.md`

`SAAS_RELEASE_BASELINE.md` debe resumir:

- módulos listos
- módulos parciales
- arquitectura
- seguridad
- performance
- tests
- integraciones
- cómo extender para un nuevo cliente

`SAAS_GAPS.md` debe separar:

- bloqueante
- importante
- nice-to-have
- infraestructura/terceros

No maquilles pendientes.

## Definition of Done

PASS solo si todos los gates obligatorios pasan y no hay un bloqueo crítico de integridad, seguridad o multi-tenant oculto.
