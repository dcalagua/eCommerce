# Quality gate P08 — informe de corrida

Fecha: 2026-08-27 · Rama: `dev` · Base: `fc382f1` · Node v22.17.0 / npm 10.9.2
Sin deploy, sin push, sin PR (regla del repo).

## Resultado global: **PASS**

| Verificación | Comando | Resultado |
| --- | --- | --- |
| Install limpio | `npm ci` | PASS (exit 0, desde `package-lock.json`) |
| Lint | `npm run lint` | PASS (ESLint 9 flat, **0 problemas**) |
| Typecheck | `npm run typecheck` | PASS (`tsc --noEmit`, sin OOM) |
| Tests | `npm run test` | PASS (**493 tests / 34 archivos**) |
| Build de producción | `npm run build` | PASS (`vite build`, 4.1 s) |

Antes de esta corrida: 486 tests / 33 archivos. Los 7 nuevos son de gate, no de feature.

## Auditorías pedidas, una por una

### 1. Migraciones reproducibles e inmutabilidad de las aplicadas — PASS con hallazgo
- 14 migraciones. El banco de pruebas (`supabase/tests/harness.ts`) las aplica **tal cual**, en orden,
  sobre Postgres real (PGlite) en cada archivo de test: la reproducibilidad no se supone, se ejerce.
- **Nuevo test**: `la carpeta de migraciones es reproducible: dos bases virgenes dan el mismo esquema`
  compara la huella completa (columnas, tipos, nulabilidad, defaults, RLS, policies, funciones y su
  `security definer`) entre dos bases levantadas por separado. Una migración que dependa del reloj,
  de `random()` o del orden de lectura del directorio falla aquí y no en el primer `db push`.
- **Hallazgo (histórico, sin daño):** el commit `23e7d7b` (P04) **modificó dos migraciones ya
  commiteadas** — `20260827090300_catalog.sql` y `20260827090400_orders.sql` — para corregir tres FK
  compuestas `on delete set null`. No hay violación real de inmutabilidad porque **ninguna migración se
  ha aplicado a ninguna base**: no existe project ref todavía, así que la carpeta actual *es* la fuente
  de verdad y arranca limpia. Queda como **regla vinculante desde el primer `supabase db push`**: a
  partir de ahí los archivos se congelan y todo cambio va en una migración nueva. Anotado en riesgos.

### 2. RLS y aislamiento tenant A/B — PASS
`supabase/tests/rls-tenant-isolation.test.ts`, **35 tests** sobre Postgres real con `SET ROLE` y los
claims en `request.jwt.claims` (el mecanismo exacto de Supabase). Cubre: cada tenant solo ve su tienda,
su catálogo y sus pedidos; A no inserta declarando el `organization_id` de B; A no actualiza ni borra
filas de B (cero filas afectadas, no error silencioso); el JWT **no basta** sin membresía activa; una
membresía revocada y un tenant suspendido cierran el acceso; un token sin claims no ve nada; una
sociedad fuera de `companies[]` no da acceso; nadie escala a `owner` desde la app.
`schema-invariants.test.ts` complementa: RLS *enabled* **y** *forced* en toda tabla, ninguna tabla sin
policy, ninguna policy permisiva a `PUBLIC`, `organization_id`+`company_id` NOT NULL e indexados en toda
tabla de negocio, y cero variantes de nombre (`tenant_id`/`org_id`).

### 3. El público no modifica el catálogo — PASS (cobertura ampliada en esta corrida)
Antes había **una** aserción: `anon` no puede insertar en `products`. Ahora se comprueban las doce
puertas, una por una — `products` update de precio, update de stock, publicar un borrador ajeno y
delete; `categories` insert/update/delete; `stores` update/delete; `store_settings` update;
`product_images` insert/delete — y además que el catálogo **sigue exactamente igual** después de los
doce intentos. Se añade un test de que tampoco se escribe **a través de las vistas públicas**
(`public_products`, `public_stores`). Todas fallan con `permission denied`: no hay GRANT, así que no
hace falta confiar en que la policy esté bien escrita.

### 4. `service_role` ausente del frontend — PASS
Escaneo del bundle recién construido: las dos únicas apariciones de `service_role` / `sb_secret_` son
**literales de detección**, no credenciales — el prefijo que comprueba `@supabase/supabase-js` y la
regex del guard propio `assertNoServiceKey` (`src/shared/lib/env.ts`), que revienta el arranque si
alguna `VITE_*` huele a clave de servicio. Cero cadenas con forma de JWT (`eyJhbGciOi…`) en `dist/`.
`.env` está git-ignored, solo se versiona `.env.example` y no contiene valores reales.

### 5. Storage aislado — PASS
6 tests de path `{organization_id}/{store_id}/`: A escribe en el suyo, A **no** escribe en el de B, A no
ve los objetos de B, `anon` lee la imagen de un producto publicado pero no la de un borrador, `anon` no
sube nada, y los buckets **no son públicos** (la lectura pasa siempre por policy).

### 6. `create-order` recalcula precios en el servidor — PASS
`public.create_order` (migración 07) lee el precio de la fila, bloquea con `for update`, descuenta stock,
calcula `subtotal`, aplica `tax_rate` de `store_settings` y arma `grand_total` en la misma transacción.
El SQL **rechaza explícitamente** cualquier clave de precio que llegue en el JSON. La Edge Function
normaliza el carrito a `{product_id, quantity}` y tira 400 (`CAMPO_NO_PERMITIDO`) ante `price`,
`unit_price`, `subtotal`, `total`, `currency` o `discount`. Test de las dos mitades: el cuerpo que sale
del navegador no contiene la palabra `price`, y la confirmación pinta los importes del **servidor**.

### 7. Las Edge Functions no confían en el tenant del navegador — PASS
Las cuatro (`bootstrap-tenant`, `catalog-product`, `create-order`, `update-order-status`) llaman a
`assertNoTenantInPayload`: `organization_id`, `company_id`, `tenant_id` y variantes en el cuerpo se
**rechazan con 400**, no se ignoran. `catalog-product` y `update-order-status` derivan el tenant del JWT
y escriben con la sesión del usuario (sin `service_role`). `create-order` resuelve la tienda **por slug
en la base** (`create_order_for_slug`); `store_id` ya ni se acepta. `bootstrap-tenant` es la única
excepción legítima y está justificada: el tenant todavía no existe, así que en el camino de
aprovisionamiento los uuid vienen en el cuerpo tras validar la clave dedicada en cabecera; en el camino
de alta propia el tenant sale de claims con la **firma verificada** (`_runtime/verify.ts`).

### 8. Rutas, responsive y estados de carga/error/vacío — PASS
`src/app/routes.tsx` separa las tres áreas y `routes.test.tsx` lo verifica estructuralmente: `/app/*`
y `/onboarding` cuelgan del guard de sesión, `/login` y `/recuperar` quedan **fuera** (si no, no habría
forma de entrar), `/s/:storeSlug/*` no cuelga del guard, y ninguna ruta de vitrina cuelga del backoffice.
Las 19 pantallas usan `LoadingState` / `ErrorState` / `EmptyState` / `TableSkeleton` y respetan los
breakpoints MUI. `errorElement` en las tres raíces. A11y: los 17 `IconButton` llevan `aria-label`
traducido y las 6 imágenes llevan `alt`.

### 9. Sin secretos, mocks productivos ni TODO crítico — PASS
Cero `any`, cero `@ts-ignore`, cero `eslint-disable` en todo el repo. Ningún `TODO`/`FIXME` real: las
cinco coincidencias son la palabra española «todo» en comentarios. `src/test/supabaseMock.ts` no lo
importa ningún archivo de producción y no aparece en `dist/`. Ninguna URL de Supabase hardcodeada.
**Nuevo test** `src/shared/i18n/messages.test.ts`: ES y EN tienen exactamente las mismas 383 claves,
ninguna traducción vacía, y el inglés no es copia literal del español (`translate` cae al español
cuando falta una clave, así que una traducción olvidada no rompía nada y se colaba sin ruido).

## Recorridos mínimos — los cuatro cubiertos
| Recorrido | Dónde |
| --- | --- |
| login → onboarding → admin | `src/app/auth-flow.test.tsx` (router real, backend falso) |
| producto → imagen → publicar | `ProductsPage.test.tsx` + `ProductImagesPanel.test.tsx` |
| storefront → producto → carrito → checkout → order | `checkout-ui.test.tsx` (12 tests, flujo entero) |
| admin → ver orden | `OrdersPage.test.tsx` (detalle con líneas, entrega e historial) |

## Cambios de esta corrida (solo tests, ninguna feature)
- `supabase/tests/rls-tenant-isolation.test.ts` — +2 tests (12 escrituras del catálogo + vistas públicas).
- `supabase/tests/schema-invariants.test.ts` — +1 test (reproducibilidad por huella de esquema).
- `src/shared/i18n/messages.test.ts` — nuevo, +4 tests (paridad ES/EN).

## Riesgos y pendientes que deja el gate
1. **Sin project ref de Supabase.** Bloquea aplicar migraciones, `npm run db:types`, desplegar las 4
   Edge Functions y probar RLS contra el proyecto real. Todo el aislamiento está probado en PGlite con
   las migraciones reales — es fuerte, pero no sustituye una verificación contra el proyecto.
2. **Inmutabilidad de migraciones sin candado automático.** Hoy la regla es humana. Un guard por
   checksum tiene sentido en cuanto exista el primer `db push`; antes solo daría ruido.
3. **Playwright sigue sin instalarse.** Los cuatro recorridos corren con el router real y un backend
   falso, no en navegador. Faltan por tanto los fallos que solo da un navegador de verdad.
4. **Las Edge Functions no se typechequean.** `tsconfig.json` incluye `_shared` (TS plano), pero
   `_runtime/*` y los `index.ts` usan globales de Deno y quedan fuera. No hay Deno en esta máquina;
   cerrar esto pide `deno check` en el gate.
5. **Chunk de entrada de 738 kB (219 kB gzip).** El build avisa. Para una app mobile-first conviene
   partir vendors (`manualChunks`) — es cambio de configuración, no de producto, y no entraba aquí.
6. **Rate limiting de `create-order`** sigue abierto: el checkout anónimo no puede falsificar precios ni
   tenant, pero nada impide crear pedidos basura. Necesita el project ref para elegir mecanismo.
7. **Estructura**: CLAUDE.md nombra `src/storefront` y `src/admin` de primer nivel; el repo los tiene
   como `src/features/storefront` y `src/features/admin`. La separación lógica (rutas, layouts, guards,
   cliente anónimo dedicado) se cumple; mover carpetas ahora sería churn sin ganancia.

El resto del backlog (SEO, paginación, variantes, pagos, dominios, notificaciones) sigue en
`docs/STATE.md`, sin cambios en esta corrida.
