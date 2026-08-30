# ADR 017 — Dónde se hace cumplir una capacidad vendible, y por qué tres huecos se declaran en vez de cerrarse

- **Fecha**: 2026-08-30
- **Fase**: P17-SaaS (quality gate final y línea base releaseable)
- **Estado**: aceptado
- **Contexto normativo**: contrato EBIM §0.4 (todo activable desde Configuración), §5/§6 (el catálogo
  comercial es del hub), `CLAUDE.md` («addons/sociedades/config **se leen del hub**; gating de módulos
  por addon activo»)

---

## Contexto

La migración `20260827160000_capabilities_entitlements.sql` (P02-SaaS) dejó la regla escrita sin
ambigüedad, y el ADR 002 la razonó:

> `ebim.has_capability` — LA autoridad de gating. La de la UI es cortesía.

El motivo es el de siempre: `src/app/routes.tsx` envuelve cada pantalla en `gated(...)`, pero eso
decide qué se **pinta**. Un miembro legítimo del tenant que hable PostgREST con su propio token no
pasa por el router. Si la única puerta de un módulo es esa envoltura, el módulo está gateado en el
navegador y no en el producto.

El gate de P17 midió esa regla contra el esquema real —leyendo `pg_policies` y `pg_proc` del esquema
construido desde las 94 migraciones— y encontró que **es cierta para ocho de las once capacidades
vendibles implementadas, y falsa para tres**:

| Capacidad | Candado de servidor | Fase que la construyó |
|---|---|---|
| `pricing.lists`, `customers.b2b`, `inventory.multiwarehouse`, `promotions`, `content.cms`, `content.white_label`, `analytics.advanced`, `integrations.enterprise` | **sí** | P04, P05, P06, P10, P11, P13, P14 |
| `catalog.advanced` | no | P03 |
| `payments` | no | P09 |
| `fulfillment` | no | P12 |

No es un patrón: es deriva. P03 creó las once tablas del PIM **antes** de que P04 fijara la forma de
poner el candado en la policy, y P09 y P12 copiaron la estructura de P03 (migración de capacidad que
registra estado, conector de pruebas y vista) sin la parte que P04 había añadido.

### Qué es exactamente el riesgo, y qué no es

**No es** una fuga entre tenants ni una escalada de privilegio. RLS por `organization_id` y el guard
de rol siguen aplicando en las tres: el dato no sale de la organización de quien llama, y un `viewer`
sigue sin escribir. Las 112 policies de escritura del esquema referencian `organization_id`, sin
excepción.

**Es** un bypass de monetización: un tenant que no contrató el addon de pagos puede, llamando a la
API directamente con su token legítimo de administrador, crear medios de pago e intentos de cobro.

---

## Decisión

**Los tres huecos no se cierran en P17. Se convierten en una aserción de la suite.**

Se añade `supabase/tests/capability-enforcement.test.ts`, que:

1. Lee de `pg_policies` y `pg_proc` qué capacidades aparecen como tercer argumento de
   `ebim.has_capability` en el esquema construido desde las migraciones. La extracción mira **solo
   dentro del paréntesis de la llamada** y toma su última cadena: mirar la expresión entera confunde
   el nombre de un rol con el de una capacidad, porque una policy suele llevar
   `has_role(..., '{owner,admin,catalog}')` al lado. (Ese fue el primer resultado, y era falso.)
2. Exige que el conjunto de capacidades **vendibles e implementadas sin candado** sea *exactamente*
   `{catalog.advanced, payments, fulfillment}`, cada una con su motivo escrito en el propio archivo.
3. Exige que las ocho que **sí** lo tienen no lo pierdan.
4. Exige que **ninguna capacidad baseline** dependa de un entitlement.

## Por qué no se cierran ahora

Tres razones, en orden de peso.

**1 · Cerrarlo hoy apagaría los tres módulos para todos los tenants.** El candado se hace cumplir
contra `tenant_entitlements`, que se llena por `sync_platform_context` desde el hub. `ecommerce`
**no está dado de alta en el hub** con su catálogo de addons (riesgo R1, mitad abierta desde P00), de
modo que hoy nadie tiene entitlements y `has_capability` solo devuelve cierto para lo baseline. Poner
la policy sería cambiar un hueco comercial por una caída de producto. Las ocho que sí lo tienen ya
viven con esa consecuencia, y por eso la referencia no ayuda: heredaron el problema, no lo resolvieron.

**2 · Decidir qué se cobra aparte no es de este repositorio.** El catálogo comercial es del hub
(contrato §5/§6) y el principio 2 prohíbe la segunda fuente de verdad comercial. Que
`src/domain/capabilities.ts` declare `entitlement: 'ecommerce.payments'` es una **propuesta** de
empaquetado; hasta que el hub la acepte, hacerla cumplir sería que eCommerce decidiera solo — que es
justo lo que el principio 5 prohíbe.

**3 · P17 es un gate, no una fase de producto.** El encargo lo dice: nada de features salvo lo
necesario para pasar gates o cerrar inconsistencias de fases anteriores. Esto **es** una
inconsistencia de fases anteriores, pero cerrarla exige una migración que altera policies de
veintitantas tablas y tocar las fixtures de las suites de PIM, pagos y entregas —que hoy no conceden
el entitlement y se pondrían rojas en bloque—. Hacer eso en el mismo commit que declara la base
verificada quitaría valor a la declaración: el gate mediría un árbol que el propio gate acaba de
mover.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| **Añadir el candado ahora y conceder los tres entitlements por defecto en el aprovisionamiento** | Un candado que se abre solo no es un candado; y sembrar entitlements localmente es exactamente el catálogo comercial duplicado que el principio 2 prohíbe |
| **Añadir el candado y actualizar las fixtures** | Deja el producto apagado para cualquier tenant real hasta el alta en el hub, que es peor que el hueco. La suite quedaría verde con el producto roto: el peor resultado posible de un gate |
| **Reclasificar las tres como baseline** | Sería decidir el empaquetado comercial desde el repositorio. Además contradice al pliego, donde pagos y entregas son módulos diferenciados |
| **Dejarlo solo documentado, sin test** | Es lo que ya se hacía, y produjo tres huecos sin que nadie los viera durante nueve fases. Un documento no rompe la suite |
| **Un `assert_capability` llamado desde cada comando** | La migración 160000 ya escribió y retiró esa función, con motivo: el enforcement vive en las policies, y una función que nadie llama es interfaz muerta con permisos que mantener |

## Consecuencias

**Buenas.** El hueco deja de ser invisible: es un dato leído del esquema, no una nota. No puede
crecer —una capacidad vendible nueva sin candado y sin entrada declarada rompe el gate— y no puede
encogerse por accidente: las ocho que hoy tienen candado lo pierden con la suite en rojo. El día que
llegue el alta en el hub, cerrar los tres huecos es una migración y **vaciar una lista de tres
elementos**; el test dirá solo cuándo está terminado.

**Malas.** Durante el tiempo que dure el alta, un administrador de un tenant puede usar PIM, cobros y
entregas sin haberlos contratado. Está escrito en `SAAS_GAPS.md` §2.1 con esas palabras. Nadie debería
enterarse por una factura.

**Neutras.** El test añade ~2,5 s a `test:db`: construye la base una vez y hace dos consultas de
catálogo.

## Cómo se cierra

1. Alta de `ecommerce` en el hub con sus doce addons (`SAAS_GAPS.md` §4.1).
2. Migración nueva —las aplicadas son inmutables— que añada
   `ebim.has_capability(organization_id, company_id, '<code>')` a las policies de **escritura** de las
   tablas de PIM, pagos y entregas. Lectura no: apagar un addon no debe hacer desaparecer el dato que
   el tenant ya generó pagando.
3. Conceder el entitlement en las fixtures de `pim-catalog`, `payments`, `fulfillment` y `returns`,
   y añadir en cada una el caso «sin el addon, se deniega en la base» que ya tienen `capabilities`
   y `white-label`.
4. Vaciar `SIN_CANDADO_DE_SERVIDOR` en `capability-enforcement.test.ts`. La suite dirá si falta algo.

---

## Apéndice — el resto del gate P17

Por completitud, lo que P17 midió y **no** produjo decisión, porque salió como debía:

- Los siete gates obligatorios pasan (`SAAS_RELEASE_BASELINE.md` §1).
- 112 de 112 policies de escritura llevan alcance de tenant; las 17 de lectura sin alcance son la
  superficie pública de la vitrina más tres catálogos globales de solo lectura.
- `service_role` aparece en el bundle **una vez**: dentro del guard que lo prohíbe.
- Ningún uuid de cliente ni nombre propio en producción; ninguna migración modificada desde
  `23e7d7b` (P04); la carpeta de migraciones sigue siendo reproducible.
- Idempotencia con índice único y test de reintento en checkout, cobros, devoluciones, envíos,
  outbox, canje de tarjeta regalo y API de socio.

Lo que quedó abierto sin decisión posible desde el repositorio está en `SAAS_GAPS.md` §4, cada
entrada con responsable, dependencia y forma de verificar el cierre.
