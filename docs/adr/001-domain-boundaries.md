# ADR 001 — Fronteras de dominio, puertos y errores de aplicación

- **Estado:** aceptada
- **Fecha:** 2026-08-27
- **Fase:** P01-SaaS (productización)
- **Contexto previo:** [`SAAS_BASELINE.md`](../SAAS_BASELINE.md),
  [`SAAS_KEEP_REFACTOR_BUILD.md`](../SAAS_KEEP_REFACTOR_BUILD.md) (filas 18, 27, 38),
  [`SAAS_ROADMAP.md`](../SAAS_ROADMAP.md) §2

---

## Contexto

El repositorio llega a P01 con 17.600 líneas en `src/`, 28 migraciones y 872 tests verdes. La
auditoría de P00 dejó tres hechos que condicionan todo lo que viene después:

1. **«Capa de datos» y «Supabase» son hoy la misma cosa.** Ningún componente `.tsx` toca
   `supabase-js` —eso está bien— pero los servicios de `features/*/api*.ts` hablan PostgREST
   directamente. No hay ningún punto donde enchufar un ERP, y el pliego pide justamente eso.
2. **No existe ninguna interfaz de frontera.** El patrón adaptador solo vive como DATOS, en el
   catálogo `integration_providers` de la migración `20260827150000`. Hay un vocabulario canónico
   (`order.create`, `payment.authorize`, `stock.read`…) que la base conoce y el código no.
3. **La convención «tipos generados, no escritos a mano» no se cumplía**, y la evidencia estaba
   borrada: `database.types.ts` llevaba commiteado en 0 bytes desde `6e66080` (R11).

El riesgo de esta fase no es hacer poco. Es hacer una migración masiva y cosmética: mover 146
archivos a carpetas `domain/application/infrastructure/ui`, producir un diff enorme, no cambiar
ninguna propiedad del sistema y gastar el presupuesto de refactor que P03–P08 sí van a necesitar.

## Decisión

### 1. Las fronteras se declaran en código y se comprueban, no se dibujan

`src/domain/boundaries.ts` declara los **doce dominios de negocio** (catalog, pricing, customers,
inventory, checkout, orders, payments, promotions, content, fulfillment, analytics, integrations) y
las **cinco áreas de plataforma** (identity, tenancy, provisioning, configuration, shell), cada una
con su responsabilidad, sus rutas en `src/` y su estado real: `implemented`, `partial` o `declared`.

`src/architecture.test.ts` usa esa declaración para exigir que **todo archivo de `src/features/`
pertenezca a una frontera declarada**. Una carpeta nueva sin dominio rompe la suite. Un mapa de
arquitectura en prosa envejece en semanas porque nada falla cuando se incumple; esta versión falla.

Las áreas de plataforma están separadas de los doce dominios a propósito: identidad o multitenancy
no son módulos vendibles, son lo que sostiene a todos los demás, y confundirlos es cómo se acaba
con «identidad» en la lista de addons.

### 2. La convención por capas se aplica donde ya existía, no se impone donde no aporta

No se reorganizan los 146 archivos. La separación que P01 fija es la que ya estaba insinuada y
ahora es explícita y verificable:

| Capa | Dónde vive hoy | Regla comprobada |
|---|---|---|
| **domain** | `src/domain/` | no importa React, MUI, TanStack, Supabase ni `src/features`; solo Zod |
| **application** | `features/*/use*.ts`, hooks de TanStack Query | — |
| **infrastructure** | `features/*/api*.ts`, `shared/lib/supabase.ts`, `shared/lib/db-schema.ts` | único sitio que habla PostgREST |
| **ui** | `*.tsx` | ningún `.tsx` hace `.from()`, `.rpc()` ni `functions.invoke()` |

La divergencia respecto a `CLAUDE.md` (`src/storefront` + `src/admin` frente a `src/features/*`) se
mantiene por la razón que ya documentaba `architecture.md`: lo que la regla protege —rutas, layouts,
guards y cliente Supabase distintos— se cumple, y mover 146 archivos sería refactor cosmético.
`src/domain/` es una carpeta nueva y se declara aquí como divergencia consciente.

### 3. Un puerto existe cuando hay una segunda implementación **ya declarada**

Es la regla que evita la interfaz por función. «Declarada» significa que se puede señalar dónde, y
valen dos fuentes: una fila de `integration_providers` con la operación en `capabilities`, o dos
llamantes concretos hoy en `src/` haciendo lo mismo de dos maneras.

| Puerto | Segunda implementación declarada en | Fase que lo implementa |
|---|---|---|
| `PricingPort` | `price.read` (dos adaptadores de ERP) + listas de precio | P04 |
| `InventoryPort` | `stock.read` (dos adaptadores de ERP) + almacenes | P06 |
| `PaymentProvider` | tres pasarelas sembradas | P09 |
| `FulfillmentProvider` | `shipment.create` / `shipment.track` | P12 |
| `NotificationProvider` | `message.email` / `sms` / `whatsapp` | P07/P08 |
| `ErpProvider` | dos generaciones del mismo ERP, mismas operaciones | P14 |
| `InvoicingProvider` | `invoice.issue` / `invoice.read` | P14 |

**`SearchPort` NO se crea.** La búsqueda de hoy es un `ilike` de PostgREST en tres sitios, sobre
tablas y vistas distintas y devolviendo tipos distintos; un puerto tendría que inventar un modelo de
resultado que ninguna pantalla necesita y seguiría teniendo una sola implementación real. Lo que sí
había era duplicación de verdad —la construcción del filtro, escrita tres veces— y está unificada en
`shared/lib/search.ts` (`buildTextSearchFilter`). El disparador para crear el puerto: un índice o
motor de búsqueda propio (P11/P15), o un `catalog.search` en `integration_providers`.

**Ningún puerto recibe el tenant como parámetro.** Ni `organization_id` ni `company_id`: salen
siempre del JWT en el servidor. Un parámetro que se puede pasar se puede pasar mal, y la prueba de
arquitectura falla si aparece uno.

### 4. El vocabulario canónico es el de la base, y está atado a ella por un test

`src/domain/ports/operations.ts` declara `ProviderKind` y `ProviderOperation` con exactamente los
mismos valores que el enum `integration_kind`, el CHECK `integration_outbox_operation_fmt` y las
filas sembradas de `integration_providers`.

`supabase/tests/integration-contract.test.ts` compara las dos copias **contra Postgres real**: si
alguien siembra un proveedor en SQL con una operación que TypeScript no declara —o al revés— la
suite falla. Esto es lo que impide que los puertos de P01 sean interfaces muertas: hoy no tienen
adaptador, pero su vocabulario ya no puede desviarse de la base sin que se note.

Nota de vocabulario: la base llama `capabilities` a esto y `shared/lib/roles.ts` llama `Capability`
a los permisos de rol. Aquí se evita la palabra a propósito (`ProviderOperation`). El tercer eje —lo
que el tenant **contrató**— lo introduce P02 y es quien tiene que resolver el nombre.

### 5. El dominio no conoce a nadie por su nombre

Ni fabricante de ERP, ni banco, ni transportista, ni cliente. El dominio dice `order.create`; qué
llamada concreta es eso —una función remota en una generación del ERP, un servicio REST en la
siguiente— lo sabe únicamente el adaptador, y eso es literalmente la respuesta a «preparado para
migrar sin reimplementar» del pliego (4.1.3-b) y a «personalización por configuración, no por
modificación de código» (AA0004).

La prueba de arquitectura lo verifica sobre todo `src/`, **incluidos los comentarios**. La regla es
más estricta de lo necesario y es deliberado: un nombre propio en un comentario es el primer paso
para que aparezca en un `if`. El ejemplo con nombres —que `order.create` es
`BAPI_SALESORDER_CREATEFROMDAT2` en SAP R/3 y otra cosa en S/4HANA— vive en la migración
`20260827150000` y en este documento, que son documentación y no código.

Los nombres de cliente (`alicorp`, `casa-nordica`) solo pueden aparecer en fixtures de test, donde
son tienda de mentira y no configuración.

### 6. Los errores de aplicación tienen un discriminante, y el texto se lee en un solo sitio

Había **cinco clases de error idénticas** (`CatalogError`, `OrderError`, `CheckoutError`,
`SettingsError`, `BootstrapError`), cada una con `key: MessageKey` + `code: string` y ningún
antepasado común. Nada transversal —un reintento, una bitácora, un `ErrorBoundary`— podía preguntar
«¿esto fue un permiso o un duplicado?» sin conocer las cinco listas de códigos.

`src/domain/errors.ts` introduce `AppError` con `kind: AppErrorKind` (`config`, `unauthorized`,
`forbidden`, `not_found`, `conflict`, `invalid`, `rate_limited`, `unavailable`, `unknown`) y
`boundary`. Las cinco clases siguen existiendo —cada dominio traduce lo suyo, y «no encontrado» no
se le cuenta igual a un comprador anónimo que a un administrador de catálogo— pero heredan de
`UiError extends AppError` **sin que su firma cambie**: ningún llamante ni ningún test se tocó.

Dos consecuencias que sí son cambios de comportamiento:

- **Lo desconocido nunca es reintentable.** `classifyErrorCode` devuelve `unknown` para lo que no
  reconoce, e `isRetryable('unknown')` es `false`. Dar por transitorio un error que no se entiende
  es cómo se construye el bucle que machaca al servidor justo cuando peor está.
- **El mensaje crudo del servidor deja de llegar a la pantalla.** Había siete puntos que hacían
  `throw new Error(error.message)` —cinco de ellos en la vitrina pública, que ve un comprador
  anónimo—, así que un `message` de PostgREST con nombres de tabla, de columna y de policy dentro
  podía terminar pintado. La regla existía en el proyecto desde P02; lo que faltaba era cumplirla.
  Ahora se lanza el CÓDIGO y `ErrorState` pinta `code` en vez de `message` para un `AppError`.

La interpretación de texto queda confinada a tres módulos, y la prueba de arquitectura falla si
aparece un cuarto:

| Módulo | Por qué | Cuándo desaparece |
|---|---|---|
| `shared/lib/appError.ts` | lee `CODIGO: mensaje` de las funciones de la base y el SQLSTATE | nunca; es el borde |
| `shared/lib/edgeError.ts` | lee `{error:{code}}` de una Edge Function | nunca; es el borde |
| `features/auth/authApi.ts` | el SDK de Supabase Auth no da código estable para credenciales inválidas ni correo sin confirmar | P16, o cuando el SDK exponga `error.code` |

### 7. DTOs de frontera con Zod: se mantiene lo que ya había

Toda respuesta que entra desde la base o desde una Edge Function ya se validaba con Zod
(`productSchema`, `orderResultSchema`, `publicProductSchema`, `dashboardKpisSchema`, el propio
carrito de `localStorage`). No se cambia el mecanismo: se documenta como regla y `moneyText` sigue
siendo el códec de importe —decimal como TEXTO, nunca `number`, porque un `numeric` de Postgres se
vuelve float en el primer `JSON.parse`—. `src/domain/money.ts` declara la FORMA (`Money`,
`MoneyAmount`, `Quantity`); el códec sigue en `shared/lib/money.ts`, que es infraestructura de borde.

### 8. Supabase es persistencia, no vocabulario

Los nombres de tabla, vista, bucket y función viven en `shared/lib/db-schema.ts` —**no** en
`src/domain`, porque un nombre de tabla no es un concepto de negocio— y de ahí los reexporta cada
feature, así que ningún llamante cambió de import. Eso elimina tres duplicaciones reales
(`STORES_TABLE`, `PRODUCT_IMAGES_BUCKET`, `STORE_ASSETS_BUCKET`, cada una escrita dos veces).

Ese módulo es además **el consumidor de `database.types.ts`** (R11), que es la mitad que faltaba:
arreglar el generador no basta si nadie importa el archivo, porque volver a vaciarlo seguiría sin
romper nada. Ahora:

- `scripts/gen-db-types.mjs` sustituye a `supabase gen types … > archivo`. La redirección **trunca
  el destino antes de ejecutar el comando**: un fallo del CLI dejaba 0 bytes y un exit code que
  nadie miraba. El script genera a un temporal **junto al destino** (en Windows el temporal del
  usuario suele estar en otra unidad y `rename` entre volúmenes falla con `EXDEV`), valida que la
  salida no está vacía, que declara `export type Database` y que trae tablas, y solo entonces mueve.
  Un fallo deja el archivo anterior intacto y devuelve exit 1.
- El archivo se **regeneró**: 53.225 caracteres, 24 tablas, 5 vistas, 16 funciones, 11 enums.
- Cada constante de `db-schema.ts` lleva `satisfies TableName | ViewName | FunctionName`, así que un
  nombre que desaparezca de la base **deja de compilar**.
- `src/shared/lib/db-schema.test.ts` compara los enums escritos a mano (`APP_ROLES`,
  `PRODUCT_STATUSES`, `ORDER_STATUSES`, `PROVIDER_KINDS`) contra `Constants.public.Enums`. Los enums
  se seguirán escribiendo a mano porque de ellos cuelgan las máquinas de estado y las matrices de
  permisos; al menos ya no pueden desviarse en silencio.

## Alternativas descartadas

**Migración completa a `domain/application/infrastructure/ui` por feature.** Habría producido un
diff de 146 archivos sin cambiar una sola propiedad verificable del sistema, y habría quemado el
presupuesto de refactor que P03 (variantes), P06 (inventario) y P08 (snapshot fiscal) sí necesitan.
La convención se aplica donde ya existía la separación.

**Un framework DDD (agregados, repositorios, event sourcing).** El sistema no tiene todavía ni
clientes ni pagos ni promociones; los invariantes fuertes que hoy existen están en la BASE
—`ebim.can_access`, las FK compuestas, el trigger de transiciones, el CHECK de cuadre de importes—
y ahí es donde deben estar, porque una policy de Postgres no se puede saltar desde el navegador y un
agregado de TypeScript sí.

**Crear los siete puertos con un adaptador «actual» cada uno.** Era la forma rápida de que no
parecieran interfaces muertas, y habría sido peor: un `PricingPort` implementado hoy contra
`products.price` en el cliente contradiría el diseño de P04, donde el precio lo resuelve el
servidor. La autoridad de precio y de stock está en `create_order` y ahí se queda. Lo que sujeta los
puertos no es un adaptador de mentira, es el test de contrato contra Postgres.

**Renombrar `Capability` ahora.** El baseline lo señala (§5.3) y el KRB lo asigna a P02, que es
quien introduce el tercer eje —lo que el tenant contrató—. Renombrar antes de saber cómo se llama el
concepto nuevo es hacer el trabajo dos veces.

## Consecuencias

**A favor.** Hay siete contratos escritos que P04, P06, P07, P09, P12 y P14 pueden implementar sin
volver a discutir su forma. El vocabulario del dominio y el de la base no pueden separarse. Ningún
mensaje crudo de Postgres llega a la pantalla de un comprador. Las reglas de frontera fallan en CI
en vez de envejecer en un documento. R11 queda cerrado con generador, archivo y dos consumidores.

**En contra.** `src/domain` es una carpeta más que `CLAUDE.md` no menciona, y hay siete interfaces
sin implementación: si P04 descubre que `PriceQuote` no sirve, habrá que cambiarlo. Es un coste
asumido y pequeño —son tipos, no código— frente a que cada fase invente su propia forma.

**Lo que esto NO resuelve.** Los servicios siguen hablando PostgREST directamente: P01 declara la
frontera, no la implementa. El primer adaptador real —y la primera prueba de si estos contratos
están bien planteados— es el `order.create` de P14 sobre el outbox que ya existe.

## Verificación

`npm run typecheck`, `npm run lint`, `npm run test` (**611 tests / 44 archivos**), `npm run test:db`
(**308 / 16**) y `npm run build`, todos verdes. Antes de la fase: 569/40 y 303/15. Bundle de entrada
744,91 kB (221,15 kB gzip) frente a 742,10 kB; el dominio no entra en el bundle salvo la tabla de
clasificación de códigos, y los puertos —al ser solo tipos— no aparecen en `dist/`.
