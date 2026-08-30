# P01 — Arquitectura modular, contratos de dominio y extensibilidad

## Objetivo

Fortalecer la arquitectura para que el SaaS pueda crecer por módulos sin convertir el repositorio en un monolito acoplado a Supabase, a un ERP o a un cliente.

## Lee primero

`CLAUDE.md`, `docs/STATE.md`, `docs/architecture.md`, `docs/SAAS_BASELINE.md`, `docs/SAAS_KEEP_REFACTOR_BUILD.md` y el framework de integraciones existente.

## Trabajo

1. Define límites de dominio explícitos sin reescribir todo el repo:
   - catalog
   - pricing
   - customers
   - inventory
   - cart/checkout
   - orders
   - payments
   - promotions
   - content
   - fulfillment
   - analytics
   - integrations
2. Adopta una convención simple por feature para separar:
   - `domain`
   - `application`
   - `infrastructure`
   - `ui`
   solo donde aporte valor. No hagas una migración masiva cosmética.
3. Crea contratos/ports únicamente cuando haya una frontera real, por ejemplo:
   - `PricingPort`
   - `InventoryPort`
   - `PaymentProvider`
   - `SearchPort`
   - `FulfillmentProvider`
   - `NotificationProvider`
   - `ErpProvider`
4. El dominio no debe conocer nombres concretos como SAP BAPI, Banco X, transportista X o cliente X.
5. Centraliza errores de aplicación en tipos discriminados; evita depender de textos de error para lógica.
6. Define DTOs de frontera validados con Zod donde entren datos externos.
7. Mantén Supabase como implementación de persistencia, no como vocabulario de negocio dentro de componentes visuales.
8. Documenta decisiones en `docs/adr/001-domain-boundaries.md` y actualiza `docs/architecture.md`.
9. Si hay código actual que viola fuertemente estas fronteras, refactoriza de manera incremental y respaldada por tests.

## Guardrails

- No introduzcas un framework DDD pesado.
- No agregues abstracciones de una sola implementación sin una frontera real.
- No reemplaces TanStack Query, MUI, React Hook Form o Zod sin una razón contractual.
- No cambies el contrato multitenant.

## Definition of Done

PASS si existe una arquitectura evolutiva clara, las fronteras críticas están representadas en código o ADRs, los tests actuales siguen verdes y no hubo un refactor masivo sin beneficio.
