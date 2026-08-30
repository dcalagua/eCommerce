# Huecos abiertos del SaaS — eCommerce by EBIM

**Cierre de P17-SaaS · 2026-08-30 · sobre `a89a081` + el trabajo de esta fase.**

Este documento es el inventario honesto de lo que **no** está hecho. No maquilla nada: si algo
existe a medias, dice qué mitad existe y cuál no; si algo depende de una decisión humana o de un
tercero, dice de quién y de qué.

**Criterio de clasificación**, para que la etiqueta signifique lo mismo en las cuatro secciones:

| Nivel | Qué significa exactamente |
|---|---|
| **BLOQUEANTE** | Impide poner el producto delante de un cliente. Rompe integridad, seguridad o aislamiento multitenant, o deja un flujo de venta sin terminar |
| **IMPORTANTE** | El producto funciona, pero hay una propiedad prometida que no se cumple en todas sus capas, o una superficie que falta y se va a echar en falta en el primer cliente |
| **NICE-TO-HAVE** | Mejora real y acotada. Nadie se queda bloqueado por ella |
| **INFRAESTRUCTURA / TERCEROS** | No se puede cerrar desde este repositorio. Depende del hub EBIM, del operador, de un proveedor contratado o de un despliegue |

Cada entrada lleva **evidencia** (dónde se comprueba lo que se afirma) y **qué la cierra**.

---

## 1 · BLOQUEANTE

**Ninguno.**

Esto no es una casilla marcada por optimismo; es el resultado de las comprobaciones de §5 de
`SAAS_RELEASE_BASELINE.md`. En concreto, los cuatro sitios donde un bloqueante habría aparecido:

| Dónde se buscó | Qué se midió | Resultado |
|---|---|---|
| Aislamiento multitenant | Las **112 policies de escritura** de `public` referencian `organization_id`; las 17 de lectura sin alcance de tenant son exactamente la superficie pública de la vitrina y los tres catálogos globales de solo lectura | Sin hueco |
| Integridad del dinero | Ninguna columna de importe en coma flotante; la suma de líneas cuadra con el total por CHECK; el precio, el impuesto, el descuento y el porte los resuelve el servidor | Sin hueco |
| Secretos | `npm run scan:secrets` sobre 616 archivos versionados y 123 del bundle: sin hallazgos. `service_role` aparece en el bundle **una sola vez**, dentro del propio guard que lo prohíbe (`src/shared/lib/env.ts`) | Sin hueco |
| Idempotencia del cobro | Clave única en `checkout_intents`, `payment_intents`, `payment_attempts`, `refunds`, `shipments`, `integration_outbox` y `api_idempotency`, con test de reintento en cada uno | Sin hueco |

---

## 2 · IMPORTANTE

### 2.1 Tres capacidades vendibles se gatean **solo en la UI**

La migración 160000 lo dejó escrito: «`ebim.has_capability` — LA autoridad de gating. La de la UI es
cortesía». Hoy eso es cierto para ocho capacidades y **falso para tres**.

| Capacidad | Candado de servidor | Qué pasa hoy si el addon no está contratado |
|---|---|---|
| `catalog.advanced` (PIM) | **No** | Las once tablas de PIM llevan RLS por tenant y por rol. Un miembro con rol `catalog` que hable PostgREST directo escribe variantes, atributos, unidades y kits sin el addon |
| `payments` | **No** | Igual con las siete tablas del dominio de cobro. `120200` registra el estado y la vista, no un candado |
| `fulfillment` | **No** | Igual con la oferta, el despacho y las devoluciones. `150700` registra estado, conector de pruebas y vista |

**Qué NO es esto.** No es una fuga entre tenants ni una escalada de privilegio: el dato sigue dentro
de la organización de quien llama, y RLS y rol siguen aplicando. Es un **bypass de monetización**, y
por eso está en «importante» y no en «bloqueante».

**Por qué no se cierra en P17 y sí se convierte en dato.** El candado se hace cumplir contra
`tenant_entitlements`, que hoy está vacío para todo el mundo porque **`ecommerce` no está dado de
alta en el hub** con su catálogo de addons (§4.1). Encender el candado antes que el alta apagaría
PIM, cobros y entregas para **todos** los tenants, incluido el que ya los usa: sería cambiar un
hueco comercial por una caída de producto. La decisión de qué se cobra aparte tampoco es de este
repositorio — el catálogo comercial es del hub (contrato §5/§6).

Lo que sí se hizo: el hueco es ahora una **aserción**. `supabase/tests/capability-enforcement.test.ts`
lee `pg_policies` y `pg_proc` del esquema construido, calcula qué capacidades vendibles tienen candado
y exige que la lista de las que no lo tienen sea **exactamente** estas tres, con su motivo escrito.
Una capacidad vendible nueva sin candado rompe la suite; y las ocho que hoy sí lo tienen no lo pueden
perder en un refactor. Decisión y alternativas en `docs/adr/017-quality-gate-p17.md`.

**Cierra**: alta de `ecommerce` en el hub (§4.1) + una migración que añada `ebim.has_capability` a las
policies de escritura de esos tres dominios + actualizar las fixtures de test que hoy no conceden el
entitlement.

### 2.2 Los canales no tienen superficie de administración (R2, abierto desde P00)

`channels`, `product_channels` y `orders.channel_id` están completos y probados
(`supabase/tests/channels.test.ts`, 12 casos), el motor de precios resuelve por canal y el CMS
segmenta por canal. **Un tenant no puede crear ni administrar un canal**: no hay ruta, ni pantalla, ni
módulo de datos. `grep -rn "from('channels')" src/` devuelve cero.

Consecuencia práctica: la dimensión de venta más citada del pliego solo se puede tocar por SQL. Toda
tienda funciona hoy sobre su canal por defecto.

**Cierra**: una sección de canales en Configuración (CRUD + catálogo restringido + regla de sesión).
No necesita migración: el modelo ya está.

### 2.3 La accesibilidad está verificada en la vitrina y **no** en el backoffice

`src/features/storefront/storefront-a11y-seo.test.tsx` comprueba lo que importa en la parte pública:
salto al contenido como primer enfocable, `<main>` enfocable por programa pero fuera del orden de
tabulación, el buscador como landmark propio y **exactamente un `<h1>`**. En el backoffice no hay
equivalente: las suites de UI se escriben con `getByRole` —que exige nombres accesibles y por tanto
arrastra mucha a11y de facto— pero **nada comprueba** landmarks, orden de foco, ni el contraste de los tokens
en modo oscuro. No hay `axe` ni `jest-axe` en el árbol de dependencias.

**Cierra**: una suite de landmarks y foco por layout (`AdminLayout`), y un comprobador de contraste
sobre los tokens de tema en los dos modos.

### 2.4 Sin E2E en navegador de verdad (abierto desde P08)

Los recorridos críticos corren con el **router real y un backend falso** dentro de Vitest/jsdom
(`src/app/auth-flow.test.tsx`, `checkout-ui.test.tsx`, `storefront-ui.test.tsx`…). Eso cubre
composición, guards, estados y navegación; **no** cubre lo que solo falla en un navegador: layout
real, `prefers-reduced-motion`, foco entre documentos, Storage y CORS de verdad, o el
comportamiento del bundle partido bajo red lenta.

Se decidió así a propósito en el gate de P08 —añadir Playwright y sus navegadores era instalar
dependencia, no verificar— y la decisión sigue siendo defendible, pero el hueco es real y hay que
llamarlo por su nombre.

**Cierra**: Playwright con los cinco recorridos de §6 de `SAAS_RELEASE_BASELINE.md`, contra el
proyecto Supabase enlazado. Depende del despliegue (§4.4).

### 2.5 Las Edge Functions no pasan por ningún type-check

`tsconfig.json` incluye `supabase/functions/_shared` (TypeScript plano y sí se comprueba), pero
`_runtime/*` y los **once** `index.ts` usan globales de Deno y quedan fuera de `tsc`. Lo que hoy los
protege son sus tests de contrato (`edge-shared.test.ts` 72 casos, `api-gateway.test.ts` 51,
`edge-security-headers.test.ts` 22, `observability-edge.test.ts` 25), que ejercitan la lógica pero no
comprueban los tipos del archivo de entrada.

**Cierra**: `deno check supabase/functions/**/index.ts` añadido al gate. Requiere Deno en la máquina
de la corrida, que hoy no está.

### 2.6 `database.types.ts` está desfasado respecto a las migraciones

Los tipos generados llegan hasta las migraciones aplicadas en el proyecto enlazado; las de P02
(160000), las siete de pagos, y todo lo de P10-P16 **no** están dentro, así que `db-schema.ts` no
puede poner el `satisfies` sobre esas tablas, vistas y RPC. La red que lo sustituye es real y es más
fuerte de lo que parece —`supabase/tests/*.test.ts` comprueba cada nombre contra el esquema
construido desde las migraciones— pero un nombre mal escrito en el front no lo caza el compilador.

**Cierra**: `supabase db push` del proyecto enlazado + `npm run db:types` + añadir los `satisfies`.

### 2.7 El secreto del webhook de pagos es **por despliegue**, no por sociedad

`payments-webhook` resuelve el secreto en `EBIM_PAYMENT_WEBHOOK_SECRET_<CONECTOR>`: uno por conector
y por entorno. Lo correcto es uno por sociedad, y `tenant_integrations.secret_ref` ya existe para eso.
Lo que falta no es código: es que **la URL de callback identifique al tenant**, y esa forma de URL
depende de qué pasarela se contrate. La pasarela no puede declarar el tenant —sería un tenant
declarado por un tercero, que el contrato prohíbe—.

**Cierra**: decidir pasarela (§4.3). Cuando se decida, lo único que cambia es de dónde sale `secret`
en `payments-webhook/index.ts`.

### 2.8 `CLAUDE.md` describe una estructura de `src/` que no es la del repo

La regla normativa dice `src/storefront` + `src/admin`; el repo tiene `src/features/<dominio>` con
la separación storefront/backoffice hecha por **rutas, layouts y guards**, que es lo que la regla
protege. La divergencia está declarada en `docs/architecture.md` y en el ADR 001, y respeta el
principio; pero el texto normativo debería decir lo que el repositorio hace, o el repositorio
cambiar. Un lineamiento que se incumple con permiso deja de ser un lineamiento.

**Cierra**: decisión del operador — reescribir el párrafo de `CLAUDE.md` o mover las carpetas.

---

## 3 · NICE-TO-HAVE

| # | Hueco | Nota |
|---|---|---|
| 3.1 | **Candado de inmutabilidad de migraciones por checksum** | Hoy es una convención con una excepción histórica documentada (`23e7d7b`, P04, dos archivos, sin nada aplicado). `git log --diff-filter=M -- supabase/migrations` confirma que **no ha vuelto a pasar**. Un guard por checksum tiene sentido desde el primer `db push` al proyecto de producción |
| 3.2 | **`useCatalogSearch` quedó sin llamadores** (P15) | En `features/storefront/hooks.ts`. No estorba, pero emite el mismo evento `search` que `useCatalogPages`: si vuelve a usarse sin mirar, la analítica cuenta dos veces |
| 3.3 | **Alt text de imágenes sin campo en el backoffice** | La vitrina ya SIRVE el `alt` y cae al nombre del producto cuando es null; P04 lo guarda siempre null. Falta la caja de texto en el panel de imágenes |
| 3.4 | **Miniatura en el listado de productos** | El bucket es privado; enseñarlas obliga a firmar N URLs por página. Se hace cuando el listado tenga paginación |
| 3.5 | **Paginación del catálogo público** | Hoy se pide la página entera. Con `max_rows = 1000` de PostgREST no revienta, pero una tienda grande manda demasiado al móvil |
| 3.6 | **Captura en dos pasos sin botón** | El modelo la soporta entera (`capture_mode`, estado `authorized`, operación `payment.capture`); el backoffice no tiene la acción. Entra con la pasarela real, no antes |
| 3.7 | **El extracto de conciliación se pega, no se sube** | Fichero → bucket + política por tenant + antivirus. El parseo ya está aislado en la pantalla; el comando de la base no cambia |
| 3.8 | **Selector de sociedad sin nombres** | Muestra el uuid corto + rol porque `platform-context` todavía no alimenta el nombre. Se cablea cuando el hub responda |
| 3.9 | **Apariencia solo en `localStorage`** | Falta la mitad cross-device (`profiles.settings.appearance` del contrato §4.4). Requiere tabla de perfil, que este proyecto no tiene |
| 3.10 | **Seed de demo sin imágenes** | `supabase/seed.sql` no inserta `product_images` porque el objeto de Storage no existe en un `db reset`; la demo se ve con el marcador neutral |
| 3.11 | **Jerarquía de categorías sin selector de padre** | Por UI el árbol no crece más de un nivel. El límite duro en la base se pone cuando exista la pantalla de árbol |
| 3.12 | **Resolución del storefront por DOMINIO** | `stores.domain` existe y la vista lo expone; la vitrina solo resuelve por slug. El camino por dominio necesita despliegue y DNS |

---

## 4 · INFRAESTRUCTURA / TERCEROS

Nada de esta sección se puede cerrar escribiendo código en este repositorio.

### 4.1 Alta de `ecommerce` en el hub EBIM — **la dependencia que más cosas desbloquea**

| | |
|---|---|
| **Qué falta** | Filas en `apps` y `workspace_apps`, y el catálogo de addons propios de eCommerce: los **doce** `ecommerce.*` vendibles de las dieciocho capacidades que declara `src/domain/capabilities.ts` (las otras seis son baseline y no se venden) |
| **Responsable** | GMAO, owner del contrato de plataforma |
| **Qué bloquea** | El candado de servidor de las tres capacidades de §2.1; la retirada del camino de aprovisionamiento por clave (`source: 'provisioning'`); los nombres de sociedad del selector; el fin del `HUB_NO_CONFIGURADO` de `platform-context` |
| **Cómo se verifica** | `platform-context` deja de responder `HUB_NO_CONFIGURADO` y `public.effective_capabilities()` devuelve entitlements con `source = 'hub'` |

### 4.2 Modo de identidad (A vs B) sin decidir — R6

| | |
|---|---|
| **Qué falta** | Elegir Third-Party Auth contra el JWKS del hub (Modo A) o handoff `/sso?token=` (Modo B). La función `sso` **no existe**; `ebim.demo_access_token_hook` sigue siendo el emisor de claims de DEV/QAS |
| **Responsable** | Operador |
| **Qué bloquea** | Retirar el hook de demo; SSO real entre apps de la suite |
| **Cómo se verifica** | Un usuario del hub entra al backoffice de eCommerce sin credencial local y su JWT trae `org_id`, `companies[]`, `active_company` y `apps[]` firmados por el hub |

### 4.3 Ninguna pasarela de pago REAL

| | |
|---|---|
| **Qué hay** | El contrato canónico completo (`_shared/payments/provider.ts`), el adaptador `sandbox` determinista, y 55 + 31 casos que recorren éxito, rechazo, tiempo agotado, webhook repetido y devolución **por el mismo camino que produciría producción** |
| **Qué falta** | Un adaptador contra una pasarela contratada: una firma de verdad, un formato de webhook de verdad, un código de rechazo de verdad |
| **Responsable** | Operador (contratación) |
| **Cómo se verifica** | Un cobro real autorizado y capturado, y su webhook verificado, contra el entorno de pruebas del proveedor |

### 4.4 Proyecto Supabase de producción sin desplegar

| | |
|---|---|
| **Qué hay** | El proyecto DEV/QAS `ehxlxbhtlmfgneiagdcj` enlazado; en P09 se dejaron aplicadas las migraciones de las primeras fases. Ninguna fase posterior ha vuelto a hacer `db push`: el número exacto de aplicadas hay que leerlo del proyecto, no de este documento |
| **Qué falta** | `db push` de las 94 migraciones de la carpeta contra un proyecto de producción, secretos de las Edge Functions (`EBIM_PROVISIONING_KEY` ≥32 chars, `EBIM_ADMIN_ORIGINS`, `EBIM_STOREFRONT_ORIGINS`, `SUPABASE_SERVICE_ROLE_KEY`, los `EBIM_*_WEBHOOK_SECRET_*`), despliegue de las once funciones y DNS |
| **Nota de seguridad** | La clave de aprovisionamiento se entrega por un canal que **no** sea el buzón de Drive ni el propio Drive: contrato §2.6, ambos los lee cualquiera con acceso a la carpeta |
| **Qué bloquea** | E2E en navegador (§2.4), tipos generados (§2.6), resolución por dominio (§3.12) |

### 4.5 Copias de seguridad: **GAP declarado, no PARTIAL**

`docs/SECURITY_BASELINE.md` §9 lo clasifica como GAP con una razón concreta: existe la política del
plan de Supabase, pero **nadie ha ejecutado todavía una restauración**. Una copia que no se ha
restaurado nunca no es una copia, es una intención.

**Cómo se cierra**: un simulacro de restauración documentado, con tiempo medido y verificación de que
el esquema restaurado pasa `supabase/tests/schema-invariants.test.ts`.

### 4.6 El outbox nunca ha entregado a un sistema externo real — R3, reducido

Ya no es «outbox sin consumidor»: `supabase/functions/integration-worker` existe, vacía la cola,
firma los webhooks salientes, respeta el disyuntor por destino y tiene monitor con reintento y
reproducción (`integration-monitor.test.ts`, `webhooks.test.ts`). Lo que sigue sin ocurrir es una
entrega a un **endpoint de un tercero de verdad**. Es el mismo tipo de riesgo que §4.3.

### 4.7 Los dos avisos de `npm audit`

Dos moderadas, ambas de `react-router@6.30.6`, analizadas una a una en `SECURITY_BASELINE.md` §7.2:

- **GHSA-337j-9hxr-rhxg** (`deserializeErrors()` en hidratación SSR) — **no aplica**: es una SPA con
  `createBrowserRouter`; no hay `createStaticHandler`, `StaticRouterProvider`, `renderToString` ni
  `@remix-run/server-runtime` en el árbol.
- **GHSA-wrjc-x8rr-h8h6** (redirección abierta por barra invertida) — **sí aplicaba** y está
  **mitigado en el repositorio**, en las tres capas y sin depender de la versión de la librería: la
  base no admite guardar la cadena (`ebim.is_safe_href`), el dominio la rechaza (`src/domain/href.ts`,
  42 casos) y ningún destino llega a `<Link to>` sin pasar por `isInternalPath`.

El arreglo por versión es un salto mayor a `react-router@7`, que es trabajo de migración, no de gate.

### 4.8 Higiene de coordinación con la suite

| Qué falta | Responsable |
|---|---|
| Aviso en `coordinacion\pendientes\` declarando la entrada de eCommerce a la suite y sus canales de integración (contrato §0.5) | Operador — la carpeta de lineamientos es de **solo lectura** para este repositorio |
| Definir el crew de 5 roles de eCommerce (regla gmao-027) antes de coordinar con las otras apps | Operador |
| Decidir el momento gatillo de la vitrina cruzada (§6.1) hacia eSupplier/eExpense | Operador |
| Replicar los activos de identidad de suite (`EbimMark`, `favicon.svg`) desde los compartidos | Operador |
| Confirmar que el comprador final del storefront es identidad **local** al proyecto (patrón §2.5, como los proveedores de eSupplier). Supuesto actual: sí | Operador |
| Mascota de suite `Bebim.jpg` (gmao-032): no aplica todavía — no hay asistente ni chat con IA en ninguna pantalla | — |

---

## 5 · Lo que se cerró y ya no está en esta lista

Para que la lista signifique algo, conviene decir qué salió de ella. Riesgos abiertos por la auditoría
P00-SaaS que **están cerrados con evidencia**:

| Riesgo | Cerrado en | Evidencia |
|---|---|---|
| R1 — sin entitlements ni capacidades | P02 | Registro de módulos (hoy 18: 6 baseline + 12 vendibles), `ebim.has_capability` en las policies, `/app/diagnostics`. Quedan la mitad del hub (§4.1) y tres candados (§2.1) |
| R4 — checkout no idempotente frente a la red | P07 | `checkout_intents` con clave única por tienda; «llamarla dos veces NO crea dos pedidos» |
| R5 — sin impuesto ni descuento por línea | P08 | La suma de las líneas es EXACTAMENTE el `tax_total` del pedido, con reparto por resto mayor |
| R7 — sin `audit_log` transversal | P13 | `audit_log` append-only, `ebim.audit_row` sobre once tablas sensibles, 26 casos |
| R9 — bundle de un solo chunk | P15 | Entrada compartida 283,38 → **251,9 kB gzip**; presupuesto **por recorrido** que falla el proceso si se excede |
| R10 — lineamientos no montados | P00 | La unidad es `G:`; contrato releído en P00 y P02 |
| Rate limiting de `create-order` | P10 | Migraciones 130200-130300 y `checkout-rate-limit.test.ts` |
| Exponer solo el esquema `public` por PostgREST | P09 | Verificado contra el proyecto: `db_schema = public`; `ebim.*` por REST devuelve 404 |
| `bootstrap-tenant` autorizado solo por clave | P03 | Admite además el JWT del hub con firma verificada |
| Redirector abierto ALMACENADO por barra invertida | P16 | Cerrado en las tres capas, con regresión automática en las tres |
| Carrito de invitado que nadie recogía | P16 | `20260830100300_guest_cart_retention.sql` y `guest-cart-retention.test.ts` |
| `shipping_total` siempre 0 | P12 | `create_order` cotiza la entrega (migración 150600) |

---

*Mantenimiento: este documento se revisa en cada fase que cierre o abra un hueco. Si una entrada se
cierra, se mueve a §5 con su evidencia; no se borra.*
