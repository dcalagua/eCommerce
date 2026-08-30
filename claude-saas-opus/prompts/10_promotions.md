# P10 — Promotions Engine, cupones y gift cards

## Objetivo

Construir un motor de promociones configurable y explicable, separado del pricing base, evitando reglas hardcodeadas.

## Capacidades mínimas

Soporta de forma extensible:

- porcentaje
- monto fijo
- descuento por producto/categoría/marca
- volumen/escalas
- X por Y
- bundle/combos
- cupón
- vigencia
- canal
- segmento/cliente
- mínimo de compra
- límite de usos
- exclusión/combinabilidad
- prioridad

Gift cards pueden implementarse como submódulo si el modelo permite saldo, movimientos, expiración y trazabilidad de forma segura.

## Reglas

1. Pricing base primero; promociones después.
2. El cálculo final ocurre en servidor.
3. Debe existir breakdown de qué promociones aplicaron y cuánto descontó cada una.
4. Define reglas de stacking/combinación explícitas; no depende del orden accidental de consultas.
5. Cupones deben tener normalización segura y control de uso transaccional.
6. No permitas que el frontend marque una promoción como aplicada.
7. Cualquier límite por cliente/orden/canal debe validarse servidor.
8. Cambios en una promoción activa deben ser auditables.
9. Admin UI profesional con estado, vigencia, alcance, prioridad y simulación básica sobre un carrito de prueba si es viable.
10. Tests: overlapping, exclusión, prioridad, fecha, límites, volumen, cupón repetido, tenant A/B y rounding.

## Definition of Done

PASS si un comercio puede crear campañas comunes sin deploy y el resultado es determinístico, server-side y auditable.
