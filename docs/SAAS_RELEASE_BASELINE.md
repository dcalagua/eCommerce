# Línea base releaseable — eCommerce by EBIM

**P17-SaaS · Quality gate final · 2026-08-30.**
Base verificada sobre `a89a081` (cierre de P16) más el trabajo de esta fase.

Este documento responde a una sola pregunta: **¿se puede empezar a customizar para clientes sobre
esta base sin arrastrar deuda crítica invisible?** La respuesta es **sí**, y lo que sigue es la
evidencia, incluido lo que *no* está hecho.

Documentos hermanos:
- **`docs/SAAS_GAPS.md`** — lo que falta, clasificado y sin maquillar. **Léelo antes de prometer nada.**
- **`docs/SECURITY_BASELINE.md`** — control por control, con procedimiento verificable.
- **`docs/architecture.md`** — el mapa vivo. **`docs/adr/`** — las 17 decisiones y por qué.

---

## 1 · Resultado del gate

| Gate | Comando | Resultado |
|---|---|---|
| Tipos | `npm run typecheck` | **PASS**, 0 errores |
| Estilo y reglas | `npm run lint` | **PASS**, 0 problemas |
| Suite completa | `npm run test` | **PASS** — 2 495 casos en 109 archivos |
| Base de datos sobre Postgres real | `npm run test:db` | **PASS** — 1 636 casos en 52 archivos |
| Build de producción | `npm run build` | **PASS**, 1 365 módulos, `dist/_headers` y CSP generados |
| Presupuesto de bytes | `npm run bundle:report` | **PASS**, los cuatro recorridos por debajo del techo |
| Secretos | `npm run scan:secrets` | **PASS**, sin hallazgos (616 versionados + 123 del bundle) |
| Cadena de suministro | `npm audit` | 2 moderadas, 0 altas, 0 críticas — analizadas en `SAAS_GAPS.md` §4.7 |

> **Nota de método.** `test` y `test:db` **no se paralelizan en la misma máquina**: cada archivo de
> base aplica las 94 migraciones sobre PGlite y el `hookTimeout` se agota, marcando casos como
> saltados. Es contención de recursos, no un fallo del código. `test:db` es un **subconjunto** de
> `test`, no una suite aparte.

> **E2E.** No hay Playwright en el árbol. Los recorridos críticos corren con el **router real y un
> backend falso** dentro de Vitest. Cubren composición, guards, estados y navegación; no cubren lo que
> solo falla en un navegador de verdad (`SAAS_GAPS.md` §2.4).

---

## 2 · Módulos

Estado según lo que se puede **usar de punta a punta hoy**, no según lo que existe en la base.

### 2.1 Listos

| Módulo | Qué entrega | Dónde se prueba |
|---|---|---|
| **Catálogo** | Producto, categorías, imágenes con path por tenant, publicación | `catalog-admin` 20 · `catalog` 37 · `ProductsPage` 19 |
| **PIM (catálogo avanzado)** | Variantes con ejes, atributos, unidades de venta, kits, relaciones | `pim-catalog` 45 · `pim-orders` 28 · `pim` 26 |
| **Precios** | Listas por canal/segmento/cliente, escalas, vigencia, moneda, impuesto | `pricing-engine` 72 · `pricing-checkout` 38 · `pricing` 34 |
| **Clientes y B2B** | Ficha, contactos, direcciones, ids externos, cuentas, sucursales, reglas de aprobación | `customers` (base) 45 · `customers` (front) 23 |
| **Inventario** | Multi-almacén, ATP, movimientos trazables, reservas con caducidad | `inventory` (base) 75 · `inventory` (front) 18 |
| **Carrito y checkout** | Carrito persistente, fusión invitado→usuario, intención idempotente, pipeline de once etapas con compensación | `carts` 42 · `checkout-pipeline` 36 · `checkout-orchestrator` 38 · `checkout-order` 28 |
| **Pedidos (OMS)** | Cuatro ejes de estado, línea de tiempo, snapshots inmutables, comandos, consulta por token | `orders-oms` 52 · `orders-admin` 16 · `order-lookup` 13 · `orders` 35 |
| **Promociones** | Campañas con orden total y stacking explícito, cupones, tarjetas regalo con libro mayor | `promotions` 62 · `promotions-checkout` 23 · `gift-cards` 29 |
| **CMS y white-label** | Páginas y bloques con vigencia/canal/segmento, contenido **no-HTML**, tokens de marca, búsqueda con `pg_trgm` y sinónimos | `cms-content` 36 · `white-label` 30 · `catalog-search` 41 · `content` 43 |
| **Vitrina** | Portada, ficha, buscador, carrito, checkout, cuenta, seguimiento de pedido, SEO y `sitemap` | `storefront-ui` 31 · `storefront-public` 21 · `storefront-seo` 34 · `checkout-ui` 27 |
| **Analítica** | Nueve hechos canónicos **sin PII**, indicadores con denominador real, series, embudo, exportación | `analytics` 35 · `analytics-ui` 12 |
| **Observabilidad** | `correlation_id` como DEFAULT de ocho tablas, `audit_log` append-only, `ops_events`, traza por hilo | `observability` 26 · `observability-edge` 25 · `audit-log` 26 |
| **Integraciones** | Catálogo de proveedores, outbox/inbox, disyuntor por destino, webhooks firmados con reproducción, API de socio `/v1` con OpenAPI, monitor con reintento | `enterprise-api` 40 · `api-gateway` 51 · `webhooks` 28 · `integration-monitor` 20 · `integration-framework` 21 |
| **Identidad y tenancy** | Sesión, membresía activa, sociedad activa derivada del JWT, guards de rol | `rls-tenant-isolation` 35 · `workspace` 15 · `auth-flow` 6 |
| **Capacidades** | Registro de 18 módulos, entitlements del hub cacheados, flags técnicos que solo restan, `/app/diagnostics` | `capabilities` 36 · `capability-enforcement` 5 · `capabilities` (front) 12 |
| **Aprovisionamiento** | Alta de tenant con primera sociedad, tienda y administrador, autorizada por clave o por JWT del hub | `bootstrap-authorization` 22 |

### 2.2 Parciales — qué mitad existe

| Módulo | La mitad que **sí** está | La mitad que **no** |
|---|---|---|
| **Pagos** | Contrato canónico de pasarela, siete tablas con guardas PCI, comandos idempotentes, webhook con firma verificada, conciliación, adaptador `sandbox` determinista (`payments` 55 · `payments-provider` 31) | **Ningún adaptador real.** Sin captura en dos pasos en la UI. Secreto de webhook por despliegue y no por sociedad (`SAAS_GAPS.md` §4.3, §2.7, §3.6) |
| **Entregas y devoluciones** | Zonas, métodos, tarifas resueltas en servidor, ventanas, puntos de recojo, despacho parcial, seguimiento normalizado, devoluciones con reposición, adaptador `sandbox_carrier` (`fulfillment` 43 · `returns` 31 · `fulfillment-provider` 22) | **Ningún operador logístico real** conectado |
| **Canales** | Modelo completo, precios y contenido resuelven por canal, `orders.channel_id`, aislamiento probado (`channels` 12) | **Sin superficie de administración**: un tenant no puede crear un canal (`SAAS_GAPS.md` §2.2) |
| **Contexto de plataforma** | `platform-context` construido, parser probado, cache de entitlements, degradación honesta (`platform-context` 16) | **Nunca ejercitado contra un hub real**; sin el alta responde `HUB_NO_CONFIGURADO` (`SAAS_GAPS.md` §4.1) |

### 2.3 Declarado, sin implementar

**`orders.advanced`** — pedidos programados, repetición e importación masiva. La capacidad está
registrada **y las tablas no**, a propósito: permite dar de alta el addon en el hub sin esperar al
código. El ADR 008 escribe el disparador de cada una de las tres.

---

## 3 · Arquitectura

### 3.1 Las cuatro capas

```
src/domain/         → reglas y puertos. PURO: no importa React, ni Supabase, ni UI
src/features/<d>/   → un dominio = tipos + api (datos) + hooks + pantallas
src/shared/         → design system, i18n, seguridad, seo, utilidades
src/app/            → router, providers, guards, error boundaries

supabase/migrations/  → 94 archivos, orden por marca de tiempo, RLS en el mismo archivo
supabase/functions/   → 11 Edge Functions + `_shared` (lógica probada) + `_runtime` (Deno)
supabase/tests/       → 52 archivos contra Postgres REAL (PGlite), no simulado
```

**El mapa no es documentación: es código ejecutable.** `src/domain/boundaries.ts` declara doce
dominios de negocio y siete áreas de plataforma con su responsabilidad y sus rutas, y
`src/architecture.test.ts` (18 casos) rompe la suite si el código se sale del mapa. Las reglas que
hace cumplir, cada una protegiendo una propiedad concreta:

| Regla | Qué se pierde si se relaja |
|---|---|
| El dominio no importa infraestructura, UI ni features | La reutilización: un dominio que sabe de `PostgrestError` se reescribe, no se reutiliza |
| Ningún puerto recibe el tenant como parámetro | El contrato multitenant: un parámetro que se puede pasar se puede pasar mal |
| Ningún componente consulta la base ni crea cliente de Supabase | La revisión de seguridad: verificar el tenant obliga a leer 12 módulos de datos, no 60 pantallas |
| Nadie construye un `Error` con el `message` del servidor | Fuga (nombres de tabla y policy a la vitrina) y lógica (ramificar por texto) |
| `dangerouslySetInnerHTML` no existe en `src/` | El CMS entero: no hay «sanea antes de inyectar», hay «no existe el punto de inyección» |
| Ningún nombre de cliente ni de proveedor en producción | Que el mismo binario sirva a dos clientes (contrato §0.2) |
| Ningún uuid literal en producción | Lo mismo, en la versión que sobrevive a la regla anterior: `if (org === '3f2a…')` |
| Ningún plan comercial decide en el código | Dos fuentes de verdad comerciales, y la segunda siempre por detrás de la facturación |
| Toda carpeta de `features/` pertenece a una frontera declarada | Que el mapa siga siendo cierto dentro de un año |

### 3.2 Las tres decisiones estructurales que cuesta caro revertir

1. **Los dominios no se conocen entre sí por referencia inversa.** Un cobro apunta al pedido y el
   pedido **no** apunta al cobro; una entrega apunta al pedido y el pedido no apunta a la entrega.
   Conectar una pasarela o un transportista nuevo no toca el dominio de pedidos.
2. **El contenido enriquecido no es HTML.** Es un documento de cuatro tipos de nodo validado por un
   CHECK en Postgres y pintado nodo→componente. Por eso el XSS del CMS no es un riesgo que se
   mitiga, es una ruta que no existe.
3. **El dinero nunca es `number`.** Ni en la base (cero columnas de importe en float/real/money,
   comprobado en `schema-invariants`), ni en el contrato de pasarela (los importes viajan como texto
   decimal). `12.30` en coma flotante es `12.299999999999999`.

### 3.3 El pipeline de checkout

Once etapas con compensación explícita, en `supabase/functions/_shared/checkout/pipeline.ts`: si una
falla, se deshacen las anteriores en orden inverso, y **si la propia compensación falla, el error que
sale sigue siendo el original** (hay test para eso). El orquestador es puro y los puertos son
inyectables, así que las 38 pruebas de `checkout-orchestrator` corren sin base de datos.

---

## 4 · Seguridad

Detalle control por control en `docs/SECURITY_BASELINE.md`. Lo que P17 volvió a medir sobre el
esquema construido desde las migraciones:

| Propiedad | Medición | Resultado |
|---|---|---|
| **RLS universal** | Todas las tablas de `public` con RLS **activada y forzada**; ninguna sin policy; ninguna policy permisiva para `PUBLIC` | ✅ `schema-invariants` |
| **Escritura siempre con alcance de tenant** | **112 de 112** policies de escritura (`INSERT`/`UPDATE`/`ALL`) referencian `organization_id` | ✅ verificado en esta fase |
| **Lectura sin alcance de tenant** | 17 de 132 — **exactamente** la superficie pública de la vitrina (siempre colgando de una tienda `active`) más `currencies`, `integration_providers` y `app_capabilities`, que son catálogos globales de solo lectura | ✅ intencional y probado |
| **Jerarquía del contrato §3** | Toda tabla de negocio con `organization_id` + `company_id` NOT NULL, indexados por el par, sin ninguna variante de nombre (`tenant_id`, `org_id`…) | ✅ `schema-invariants` |
| **El tenant nunca del navegador** | Ningún Edge Function acepta `organization_id`/`company_id`/`store_id` del cuerpo (`assertNoTenantInPayload` + `rejectUnknownFields`); el storefront resuelve por slug **en el servidor** | ✅ `edge-shared`, `bootstrap-authorization` |
| **`service_role` fuera del bundle** | Única aparición en `dist/`: la regex del propio guard que lo prohíbe (`src/shared/lib/env.ts`) | ✅ `scan:secrets` |
| **`SECURITY DEFINER` sano** | Ninguna con `search_path` mutable; las operaciones de servidor sin EXECUTE para `anon` ni `authenticated` | ✅ `schema-invariants` |
| **Superficie anónima cerrada** | Lista cerrada de funciones ejecutables por `anon`, **cada una con su motivo escrito**; `anon` sin un solo GRANT de escritura, ni de tabla ni de columna | ✅ `security-baseline` |
| **Bitácora inviolable** | `audit_log` append-only por trigger, incluso para `service_role`; `anon` sin SELECT/UPDATE/DELETE | ✅ `audit-log` |
| **Sin PII en analítica** | Guardas `jsonb_is_pii_free` / `redact_pii` sobre los hechos | ✅ `analytics` |
| **Sin datos de tarjeta** | `ebim.jsonb_is_card_safe`; el contrato de pasarela mueve referencias, nunca PAN ni CVV | ✅ `payments` |
| **Redirección abierta** | Cerrada en las tres capas: CHECK en la base, `src/domain/href.ts` (42 casos) y `isInternalPath` antes de todo `<Link to>` | ✅ P16 |
| **Techos de tasa** | Checkout, analítica anónima, sondeo de cupones y carrito de invitado, todos **por tienda** y con contador que el cliente no puede escribir | ✅ `security-baseline`, `checkout-rate-limit`, `guest-cart-retention` |

**Lo que sigue abierto en seguridad**: copias de seguridad sin restauración probada (GAP declarado,
no PARTIAL) y los avisos de `react-router` — ambos en `SAAS_GAPS.md` §4.5 y §4.7.

**Autorización de módulos**: ocho capacidades vendibles se hacen cumplir en el servidor; **tres no**
(`catalog.advanced`, `payments`, `fulfillment`) y se gatean solo en la UI. No es fuga entre tenants;
es bypass de monetización, está medido, tiene test que impide que crezca, y el motivo por el que no
se cierra hoy está en `SAAS_GAPS.md` §2.1 y en el ADR 017.

---

## 5 · Rendimiento

Presupuesto **por recorrido**, no por chunk: lo que importa es lo que un comprador descarga antes de
ver algo. `npm run bundle:report` **falla el proceso** si se excede. Método y techos en
`docs/performance-budget.md`.

| Recorrido | Entrada | Ruta | Total gzip | Techo | |
|---|---|---|---|---|---|
| Vitrina · portada | 251,9 kB | 82,8 | **334,7 kB** | 400 | ✅ |
| Vitrina · ficha de producto | 251,9 kB | 57,2 | **309,1 kB** | 400 | ✅ |
| Vitrina · checkout | 251,9 kB | 78,5 | **330,4 kB** | 430 | ✅ |
| Backoffice · panel | 251,9 kB | 46,3 | **298,1 kB** | 430 | ✅ |

Cómo se consigue: proveedores en chunks estables (`vendor-react`, `vendor-router`, `vendor-supabase`,
`vendor-query`, `vendor-emotion`, `zod`), una ruta = un chunk perezoso, y el diccionario del idioma
**fuera** del bundle de entrada (`messages.en` son 114 kB que el 100 % de los usuarios en español no
descarga).

En la base: el par `(organization_id, company_id)` indexado en toda tabla de negocio, `pg_trgm` para
la búsqueda del catálogo, y el reparto de stock decidido **dentro de la sentencia que escribe**
(`ebim.take_units`) en vez de leer-y-luego-escribir.

**No medido**: Core Web Vitals reales, tiempo de respuesta de las Edge Functions bajo carga, y planes
de consulta con volumen de producción. Necesitan despliegue (`SAAS_GAPS.md` §4.4).

---

## 6 · Tests

**2 495 casos en 109 archivos**, de los cuales **1 636 en 52 archivos corren contra Postgres real**
(PGlite) aplicando las 94 migraciones tal cual están. Los dos números no se suman: `test:db` es el
subconjunto de base de `test`, y se ejecuta aparte solo para poder mirarlo por separado.

No se simulan policies. `SET ROLE anon|authenticated` + `request.jwt.claims`, que es exactamente el
mecanismo de Supabase: si una policy está mal escrita, aquí falla.

### 6.1 Los recorridos mínimos, y dónde se comprueba cada uno

| Recorrido | Dónde | Qué garantiza |
|---|---|---|
| Login → contexto de tenant → admin | `auth-flow` · `routes` · `workspace` | Sin sesión va al login; sin espacio va al alta; cerrar sesión vuelve al login; la sociedad sale del JWT |
| Catálogo simple y con variante | `catalog-admin` · `pim-catalog` · `pim-ui` | Crear con el tenant del **JWT**, no del formulario; la variante hereda del maestro; sin el addon el catálogo simple sigue funcionando |
| Precio por contexto | `pricing-engine` · `pricing-checkout` | El canal gana a la tienda; el segmento **no** se aplica al anónimo; **«el navegador no puede declarar un precio»** ni canal, ni segmento, ni cliente |
| Cliente y cuenta B2B | `customers` (base y front) | Sucursales, usuarios, reglas de aprobación; el contexto B2B se resuelve sin id del navegador |
| Inventario y reserva | `inventory` | ATP como única autoridad; reserva atómica e idempotente; el libro mayor es un índice único, no una comprobación |
| Vitrina → carrito → checkout → pedido | `storefront-ui` · `carts` · `checkout-pipeline` · `checkout-order` | Fusión invitado→usuario; **llamarla dos veces NO crea dos pedidos** ni publica los hechos dos veces; el precio se recalcula en el servidor |
| Pago con proveedor falso | `payments` · `payments-provider` | Éxito, rechazo, **tiempo agotado** como resultado propio, webhook reenviado que no cobra dos veces, devolución idempotente |
| Promoción | `promotions` · `promotions-checkout` · `gift-cards` | Orden total y stacking explícito; el canje es idempotente por referencia; la devolución repone saldo |
| Entrega y seguimiento | `fulfillment` · `returns` | Cotización **en el servidor**; despacho parcial; el pedido no sabe que existe un transportista |
| Integración fallida → monitor → reintento | `integration-monitor` · `webhooks` | La cola se ve, el detalle sale **saneado y deja testigo**, la cola es recuperable, el disyuntor es **por destino** |
| Acceso de otro tenant denegado | `rls-tenant-isolation` (35) | Insertar declarando el `organization_id` de B falla; una membresía revocada deja de ver; un tenant suspendido deja de ser accesible; sin claims no hay acceso a nada |

### 6.2 Las suites que protegen invariantes, no funcionalidad

Son las que valen más por línea, porque fallan cuando alguien rompe una **propiedad** en vez de un caso:

- `src/architecture.test.ts` (18) — las nueve fronteras de §3.1.
- `supabase/tests/schema-invariants.test.ts` (17) — RLS universal, jerarquía, dinero, `SECURITY
  DEFINER`, y **la reproducibilidad de la carpeta de migraciones: dos bases vírgenes dan el mismo esquema**.
- `supabase/tests/security-baseline.test.ts` (55) — superficie anónima cerrada, FK tenant-safe,
  techos de tasa, y los tres hallazgos de `esupplier-030` comprobados contra **esta** base.
- `supabase/tests/capability-enforcement.test.ts` (5, **nueva en P17**) — dónde se hace cumplir cada
  capacidad vendible, leído de `pg_policies` y `pg_proc`. La lista de las que hoy solo se gatean en la
  UI está declarada con su motivo y **no puede crecer**.
- `supabase/tests/rls-tenant-isolation.test.ts` (35) — aislamiento entre tenants, incluido Storage.

### 6.3 Migraciones

| Comprobación | Cómo | Estado |
|---|---|---|
| **Orden** | Nombres únicos y ordenables por marca de tiempo; se aplican con `sort()` | ✅ automático |
| **Reproducibilidad** | Dos bases vírgenes desde la carpeta producen el **mismo esquema** | ✅ automático |
| **RLS de nacimiento** | Cada migración que crea una tabla activa RLS **en el mismo archivo** | ✅ automático |
| **Sin secretos** | Ninguna migración contiene una clave de servicio literal | ✅ automático |
| **Índices** | El par `(organization_id, company_id)` indexado en cada tabla de negocio | ✅ automático |
| **FK tenant-safe** | Toda FK a una tabla de tenant lleva alcance, o su tabla lo lleva en otra FK | ✅ automático |
| **Inmutabilidad** | Convención, no candado. `git log --diff-filter=M -- supabase/migrations` da **una sola** modificación histórica (`23e7d7b`, P04, dos archivos, nada aplicado) y ninguna desde entonces | ⚠️ `SAAS_GAPS.md` §3.1 |

---

## 7 · Integraciones

### 7.1 La propiedad que las sostiene

**Los webhooks no son una segunda cola.** Son `integration_outbox` con `provider_code = 'webhook'` y
un `target` por endpoint, así que heredan idempotencia, backoff, cola muerta, disyuntor y monitor sin
escribir ninguno otra vez. Añadir un canal de salida nuevo no añade infraestructura.

### 7.2 Qué hay

| Pieza | Estado |
|---|---|
| Catálogo de proveedores (`integration_providers`) — datos, no tipos | ✅ |
| Outbox con clave de idempotencia única por tenant, backoff y cola muerta | ✅ |
| Inbox con deduplicación por mensaje del proveedor | ✅ |
| Disyuntor **por destino**, no por proveedor | ✅ |
| `integration-worker`: vacía la cola y firma los webhooks salientes | ✅ |
| Webhooks salientes: suscripciones a eventos, firma, reproducción | ✅ |
| API de socio `/v1`: `client_credentials`, permisos por operación, OpenAPI, idempotencia obligatoria en toda escritura | ✅ |
| Monitor: cola visible, detalle **saneado**, reintento y replay desde la UI | ✅ |
| Adaptadores de pago: contrato canónico + `sandbox` | ⚠️ ninguno real |
| Adaptadores de logística: contrato canónico + `sandbox_carrier` | ⚠️ ninguno real |
| Entrega a un endpoint de un tercero **de verdad** | ❌ nunca ocurrida |

### 7.3 Los adaptadores no contaminan el contrato canónico

Comprobado, y es una propiedad del diseño, no una casualidad:

- **Ninguna marca en un tipo.** No existe `type Provider = 'bcp' | …`. El nombre del proveedor vive
  en el `code` de una **fila**, así que dar de alta un banco no exige desplegar la app.
- **Las capacidades son datos.** Una pasarela que cobra en un paso declara `capture: false` y quien
  la usa lo sabe *antes* de llamarla, no por un `TypeError` a mitad de un cobro.
- **`timeout` es un resultado de primera clase**, no un `failed` con otro texto: un tiempo agotado no
  dice que no se cobró, dice que **no se sabe**, y de esa diferencia depende si se reintenta o se
  consulta el estado.
- **El vocabulario es del dominio**, no del proveedor: `authorized`, `captured`, `requires_action`,
  `refunded`. Un código propietario se traduce en el adaptador y muere ahí.
- `src/architecture.test.ts` mantiene los diez nombres de producto y de cliente prohibidos **fuera de
  `src/`**, comentarios incluidos.

---

## 8 · Cómo se extiende para un cliente nuevo

Esta es la sección que justifica el resto del documento. **La regla es una: personalización =
configuración + datos. Nunca un fork de esquema ni un proyecto por cliente** (contrato §0.2).

### 8.1 Los cuatro mecanismos legítimos, en orden de preferencia

| # | Mecanismo | Cuándo | Qué se toca |
|---|---|---|---|
| 1 | **Configuración del tenant** | Marca, impuestos, moneda, datos de tienda, dominio | `store_settings` desde la pantalla de Configuración. **Cero código** |
| 2 | **Datos del tenant** | Categorías, atributos, unidades, listas de precio, segmentos, canales, zonas, métodos de entrega, motivos de devolución, sinónimos de búsqueda, contenido | Filas. Todo el vocabulario comercial es de la sociedad, no del código |
| 3 | **Addon del hub** | El cliente contrata un módulo | Un entitlement en el hub. La app lo lee por `platform-context`, `ebim.has_capability` lo hace cumplir y la UI lo pinta. **Cero código** |
| 4 | **Adaptador nuevo** | ERP, pasarela, transportista o canal de notificación concretos | Una fila en `integration_providers` + un archivo en `_shared/<dominio>/` que implementa el contrato canónico + registrarlo en su `registry.ts`. **No se toca ningún dominio** |

### 8.2 Alta de un cliente, paso a paso

1. **En el hub**: crear la organización y su(s) sociedad(es); conceder `ecommerce` en `workspace_apps`;
   activar los addons contratados (§4.1 de `SAAS_GAPS.md` — hoy pendiente).
2. **En eCommerce**: `bootstrap-tenant` con el JWT del hub crea la sociedad, la tienda y el primer
   administrador. El `organization_id` y el `company_id` **son los del hub**; nunca se inventan.
3. **Configuración**: marca (`accent_color`, logo), moneda, categorías de impuesto, datos de contacto.
4. **Catálogo**: categorías y productos; si tiene el addon, el vocabulario de PIM.
5. **Comercial**: listas de precio y asignaciones, segmentos, canales, promociones.
6. **Operación**: almacenes y niveles, zonas y métodos de entrega, medios de pago.
7. **Contenido**: portada y páginas; la búsqueda se indexa sola.
8. **Integraciones**: credenciales de la API de socio con permisos **por operación**, endpoints de
   webhook y sus suscripciones.

### 8.3 Lo que **nunca** se hace, y qué lo impide

| Anti-patrón | Qué lo bloquea hoy |
|---|---|
| `if (organizationId === '3f2a…')` | `architecture.test.ts` — «ningún uuid literal en código de producción» |
| Nombrar al cliente o a su ERP en `src/` | `architecture.test.ts` — diez patrones prohibidos, comentarios incluidos |
| Un esquema, una tabla o una columna «solo para este cliente» | Revisión + `schema-invariants`: toda tabla de negocio nace con `organization_id`/`company_id`, RLS e índice |
| Una tabla local de planes comerciales | `architecture.test.ts` — «ningún nombre de plan comercial decide nada» |
| Confiar en el tenant que declara el navegador | `assertNoTenantInPayload` en el borde + las 112 policies de escritura con `organization_id` |
| Editar una migración ya aplicada | Convención + reproducibilidad automática. Las correcciones van en migración **nueva** |
| Gatear un módulo solo en la UI | `capability-enforcement.test.ts` — la lista de excepciones es cerrada y está declarada con motivo |
| `service_role` en el frontend | `src/shared/lib/env.ts` lanza en arranque + `npm run scan:secrets` sobre el bundle |

### 8.4 Cuando de verdad hace falta código

Si algo no cabe en los cuatro mecanismos, la respuesta correcta es **una capacidad nueva del
producto**, disponible para todos y activable por addon — no una rama por cliente. El camino:

1. Declararla en `src/domain/capabilities.ts` (con `entitlement` si es vendible) y en la frontera de
   `src/domain/boundaries.ts`.
2. Migración nueva: tablas con `organization_id`/`company_id`, RLS default deny **en el mismo
   archivo**, índice del par, FK tenant-safe. Si la capacidad es vendible, `ebim.has_capability` en
   las policies de escritura.
3. Test de aislamiento entre tenants para cada tabla nueva.
4. Pantalla con sus cuatro estados (`LoadingState`, `ErrorState`, `EmptyState`, `UnauthorizedState`)
   y la ruta envuelta en `gated(...)`.
5. ADR en `docs/adr/` si la decisión cuesta caro revertirla.

---

## 9 · Veredicto

**La base es releaseable como plataforma de customización.** Los siete gates pasan, el aislamiento
multitenant está probado contra Postgres real y no hay ningún bloqueo crítico oculto de integridad,
seguridad o multitenancy.

**Lo que impide vender hoy no está en el código**: el alta de `ecommerce` en el hub, el modo de
identidad, una pasarela contratada y un despliegue. Los cuatro están en `SAAS_GAPS.md` §4 con
responsable, dependencia y forma de verificar que se cerraron.

El único hueco de este repositorio que merece atención inmediata al empezar a vender addons es el de
§2.1 —tres capacidades gateadas solo en la UI—, y su cierre depende del alta en el hub, no de
escribir código aquí.
