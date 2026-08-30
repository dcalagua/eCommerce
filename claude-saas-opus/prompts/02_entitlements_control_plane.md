# P02 — Módulos, entitlements, feature flags y Control Plane de aplicación

## Objetivo

Permitir vender el mismo producto con planes y módulos diferentes sin forks ni condicionales por cliente.

## Importante

El repositorio EBIM puede depender del HUB para identidad, sociedades, billing y catálogo de addons. Si los contratos del HUB declaran esa autoridad, NO la dupliques localmente.

## Trabajo

1. Lee el contrato de Platform Context / entitlements definido por EBIM.
2. Implementa una capa `AppCapabilities` o equivalente que resuelva capacidades efectivas por organización/sociedad/store desde la fuente autorizada.
3. Define un registro local de capacidades técnicas del producto, no un catálogo comercial duplicado. Ejemplos:
   - catalog.advanced
   - pricing.lists
   - customers.b2b
   - inventory.multiwarehouse
   - payments
   - promotions
   - content.cms
   - fulfillment
   - analytics.advanced
   - integrations.enterprise
4. El UI y las rutas deben poder hacer gating por capability con fallback accesible y sin ocultar errores de autorización servidor.
5. El servidor debe validar nuevamente la capacidad para operaciones privilegiadas; el gating visual no es seguridad.
6. Feature flags técnicos y entitlements comerciales deben ser conceptos separados.
7. Agrega un área de diagnóstico para administradores autorizados con:
   - capacidades efectivas
   - origen de la configuración
   - store/company activa
   - versión/configuración relevante
   sin revelar secretos.
8. Si existe un verdadero Control Plane local permitido por el contrato, limítalo a operación del eCommerce: health, integraciones, jobs, uso técnico y soporte auditado. No dupliques billing/identidad del HUB.
9. Agrega tests de gating y de denegación servidor.
10. Documenta el modelo en `docs/adr/002-capabilities-entitlements.md`.

## Anti-patterns prohibidos

- `if (companyName === 'Alicorp')`
- flags hardcodeados por UUID de cliente
- roles solo en frontend
- replicar planes del HUB en tablas locales si el HUB es source of truth

## Definition of Done

PASS si un módulo puede activarse/desactivarse por configuración autorizada sin cambiar código y la seguridad no depende del UI.
