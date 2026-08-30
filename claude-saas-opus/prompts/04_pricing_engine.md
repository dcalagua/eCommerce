# P04 — Pricing Engine, listas de precios y condiciones comerciales

## Objetivo

Eliminar la dependencia conceptual de un único `products.price` y crear un motor de precios server-side configurable para B2C/B2B/canales privados.

## Capacidades

Diseña según el modelo existente:

- price_lists
- price_list_items
- asignación por canal
- asignación por segmento
- asignación por cliente/cuenta B2B
- vigencia desde/hasta
- moneda
- cantidad mínima / escalas
- prioridad
- precio de referencia
- precio negociado

## Reglas críticas

1. El browser nunca decide el precio final.
2. Crea un contrato `PricingPort` o servicio de aplicación canónico.
3. Define una función/servicio determinístico `resolvePrice(context)` con contexto explícito:
   - tenant/company/store
   - channel
   - customer/account si existe
   - product/variant
   - quantity
   - date/time
   - currency
4. Define precedencia documentada cuando varias listas aplican.
5. Detecta solapamientos inválidos o ambiguos en administración.
6. No mezcles promociones todavía; pricing base y promotions son capas diferentes.
7. Conserva fallback compatible al precio legado durante la transición, con tests que demuestren cuándo se usa.
8. Checkout y carrito deben poder solicitar cotización de precio al servidor y recibir breakdown explicable.
9. Agrega auditoría de cambios de precio cuando corresponda.
10. UI de administración: listas, vigencias, asignaciones, importación preparada para CSV/Excel si no la implementas completa aún.
11. Índices y consultas deben escalar a miles de SKUs y múltiples listas sin N+1.
12. Tests: precedencia, vigencia, volumen, moneda, tenant A/B, canal, fallback y conflictos.

## Definition of Done

PASS si el precio mostrado/recalculado puede diferir por canal/cliente/segmento sin hardcode y checkout usa el mismo motor server-side.
