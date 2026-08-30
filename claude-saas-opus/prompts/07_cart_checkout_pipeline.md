# P07 — Carrito persistente y Checkout Pipeline configurable

## Objetivo

Convertir el checkout actual en un pipeline server-side confiable, idempotente y extensible sin romper la experiencia existente.

## Carrito

1. Invitado: carrito local + identificador seguro/token de carrito si se requiere persistencia servidor.
2. Usuario autenticado: carrito server-side o sincronizado que pueda recuperarse entre dispositivos.
3. Define merge seguro al iniciar sesión.
4. Un carrito no puede mezclar stores/channels incompatibles.
5. No persistir precios como autoridad; snapshots del carrito son informativos hasta recotizar.

## Checkout Pipeline

Implementa un orquestador claro con pasos equivalentes a:

1. resolve context
2. validate customer/account/channel
3. resolve prices
4. resolve promotions si ya existe P10 en una reejecución futura; si no, hook vacío estable
5. calculate taxes
6. validate/reserve inventory
7. validate delivery context
8. validate/authorize payment si hay provider; soporta modo sin pago todavía
9. create order
10. publish outbox events
11. notify asynchronously

## Reglas críticas

- cada intento tiene idempotency key;
- repetir la misma petición no crea dos órdenes;
- el servidor recalcula todo lo crítico;
- errores por etapa son tipados y auditables;
- cualquier compensación necesaria debe estar definida;
- no hagas llamadas externas dentro de transacciones DB largas si puede evitarse;
- usa outbox para efectos posteriores cuando corresponda;
- el frontend bloquea doble submit pero no confía en eso como seguridad.

## UX

- resumen previo completo;
- actualización de totales clara;
- mensajes de stock/precio cambiado;
- loading determinístico;
- recuperación después de refresh cuando sea seguro;
- accessible error focus.

## Tests

Idempotencia, cambio de precio, stock insuficiente, canal inválido, tenant isolation, retry, fallo en efecto externo y doble submit.

## Definition of Done

PASS si el checkout es una operación server-authoritative, idempotente y extensible mediante pasos/ports sin nombres de proveedores concretos.
