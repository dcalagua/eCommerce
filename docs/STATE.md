# Estado del proyecto — eCommerce by EBIM

GUIDELINES_STATUS: VERIFIED
Fuentes: ver `docs/EBIM_GUIDELINES_TRACE.md` (11 documentos leídos en la raíz de Drive `EBIM-Plataforma`).
Última actualización: 2026-08-27 (P04)

## Fase actual
**P04 — Administración de catálogo (COMPLETA para el alcance encargado).** Productos con listado MUI,
buscador general, tabs de estado, alta/edición en panel lateral con validación Zod, publicar/despublicar,
archivar y **eliminación segura con conteo real de uso** (contrato §4.2); categorías con CRUD mínimo y la
misma eliminación segura; imágenes múltiples en el bucket privado `product-images` con principal, orden,
borrado y validación de MIME/tamaño, todo con la clave publicable y bajo RLS. Migración 10
(`catalog_admin`) con las tres operaciones que el navegador no puede hacer bien por su cuenta.
**Variantes de producto NO entran aquí**: no estaban en el encargo de esta fase y no existe tabla; queda
anotado en pendientes. Nada desplegado: sigue sin project ref. Siguiente: P05 (storefront público).

## Fase anterior
**P03 — Auth, contexto de tenant y shell administrativo (COMPLETA).** Sesión única de app con recuperación
al refrescar, login/logout/recuperación de contraseña, `/app/*` protegido por dos guards encadenados
(sesión → tenant), `TenantProvider` que deriva la jerarquía del JWT y el resto por RLS, alta de espacio de
sí mismo vía `bootstrap-tenant` con el token del hub VERIFICADO, y backoffice MUI responsive con sidebar/
drawer, breadcrumb, selector de sociedad, selector de tienda y panel de KPIs reales. Nada desplegado:
sigue sin project ref. Siguiente: P04 (catálogo en el backoffice).

## Decisiones tomadas
1. eCommerce entra a la suite EBIM como app propia: **proyecto Supabase propio**, identidad/addons en el hub.
2. Identidad: Third-Party Auth contra el JWKS del hub (Modo A) con `/sso` handoff (Modo B) como plan B.
3. Aislamiento por **RLS default deny** con `organization_id` + `company_id` (uuid del hub) en toda tabla.
4. **Storefront público y backoffice separados lógicamente** dentro del mismo repo/app (`src/storefront` vs
   `src/admin`), rutas y guards distintos, design system compartido.
5. Storefront resuelve tenant por dominio/slug contra vista pública de solo lectura; nunca por dato declarado por el cliente.
6. Imágenes en **Supabase Storage** con path por tenant y policies por tenant. **Ajustado en P02** al layout
   `{organization_id}/{store_id}/...`: la tienda pertenece a una sociedad, así que particionar por tienda es
   más fino que por `company_id` y no pierde aislamiento. Un CHECK en `product_images` obliga al prefijo.
7. Stack: React + TypeScript + Vite + MUI, i18n ES/EN, theming por tokens (color 100% del tenant).
8. Addons, sociedades y config efectiva se leen del hub vía Edge Function proxy `platform-context`.
9. Git: rama de trabajo `dev`, commits locales convencionales; sin push/PR/deploy sin orden del operador.
10. Verificación por fase: typecheck + build + lint + Vitest (+ Playwright cuando haya flujo E2E) + tests de aislamiento tenant.
11. **Tokens de marca replicados 1:1** del handoff de design system de eExpense/eSupplier
    (`coordinacion/respondidos/2026-06-28-esupplier-014`) y el isotipo `EbimMark` del asset de suite
    (`2026-06-28-eexpense-015`). No se inventó branding: modo (`data-theme`) y acento (`data-accent`)
    ortogonales, densidad por `data-density`, favicon compartido.
12. **Rutas base fijadas por el operador (P01):** backoffice en `/app/*` y storefront en `/s/:storeSlug/*`
    (sustituye el borrador `/admin` + `/` de `architecture.md`).
13. Sin i18next: diccionario ES/EN tipado propio en `src/shared/i18n` (claves validadas por `MessageKey`).
14. **P02 — nomenclatura de tenant.** El encargo pedía `tenant_id`; el contrato §3 exige `organization_id`
    + `company_id` con «nombres exactos, sin variantes» y manda sobre el encargo. Se implementa con esos
    nombres: `organization_id` **es** el tenant_id del encargo, y `stores` añade la dimensión `store_id`
    propia de eCommerce. La tabla `tenants` existe igual (espejo local, PK = `organization_id` del hub),
    patrón que el contrato §3.2 reconoce explícitamente para apps con tabla de tenants propia.
    Un test de esquema falla si aparece una columna `tenant_id`/`org_id` en cualquier tabla.
15. **P02 — roles de app**: `owner/admin/catalog/orders/viewer` (enum `public.app_role`). Son dimensión
    propia de eCommerce, no roles del hub — mismo patrón que `work_profile` de eSupplier (contrato §2.5).
16. **P02 — RLS = claims + membresía.** El predicado `ebim.can_access` exige `org_id`/`companies[]` del JWT
    **y** membresía activa en `tenant_members` con tenant activo. Un JWT con el `org_id` de otro tenant no
    ve nada. El rol se comprueba con `ebim.has_role` en cada policy de escritura.
17. **P02 — lo público es `to anon` y punto.** Las policies públicas no se dan a `authenticated` (dejaría a
    un usuario del tenant A leer columnas internas del catálogo de B). El storefront usa un cliente
    Supabase **anónimo** dedicado (`getStorefrontClient`), aunque el visitante tenga sesión de backoffice.
18. **P02 — buckets privados con lectura por policy.** `product-images` y `store-assets` con `public=false`:
    `anon` lee un objeto solo si su producto está publicado / su tienda activa. Un bucket público daría
    lectura a cualquier ruta del bucket, incluidos los borradores.
19. **P02 — el dinero sale como string.** `numeric` en la base y `::text` en el JSON de `create_order`:
    un número JSON se convertiría en float en el primer `JSON.parse` del navegador.
20. **P02 — alta de tenant y alta de pedido son operaciones de servidor.** Únicos dos usos de `service_role`,
    siempre delegando en una función SECURITY DEFINER de la base con `EXECUTE` revocado a `anon`/`authenticated`.
21. **P03 — `bootstrap-tenant` tiene dos credenciales, no dos funciones.** El operador sigue entrando con la
    clave de aprovisionamiento (y ahí los uuid vienen en el cuerpo, porque el tenant aún no existe); el
    usuario que crea su propio espacio entra con su JWT del hub y el tenant sale de los claims. Un
    `organization_id` en el cuerpo de ese segundo camino se rechaza con 400, no se ignora.
22. **P03 — el token del alta se verifica de verdad.** El camino de alta de sí mismo termina llamando a
    `service_role`, que salta RLS: leer los claims sin comprobar la firma dejaría crear un espacio a nombre
    de cualquiera. `_runtime/verify.ts` valida el token contra el servidor de auth (que en Modo A lo valida
    contra el JWKS del hub) y exige que el `sub` verificado coincida con el del payload.
23. **P03 — sin `org_id` en el token NO es un usuario nuevo.** Es un token que no sirve para esta app, así
    que el estado es `unauthorized` (con cerrar sesión como salida) y no `onboarding`. Mandarlo al alta le
    haría crear un espacio que su hub no reconoce.
24. **P03 — la sociedad activa no se persiste en el navegador.** Es parte de la jerarquía del token
    (contrato §3); guardarla en `localStorage` la haría sobrevivir a un cambio de permisos en el hub. El
    selector vive en memoria y solo ofrece sociedades con membresía devuelta por RLS.
25. **P03 — sin switcher de tenant.** El contrato §2.2 modela un usuario = un `org_id`, y `gmao-038`
    (multi-tenant por persona) sigue **pendiente de decisión del operador**. eCommerce implementa el
    selector de **sociedad** que el contrato sí prevé, y muestra el nombre del espacio en el sidebar —que es
    lo que GMAO recomendó mientras tanto—, pero no inventa un cambio de cuenta.
26. **P03 — los KPIs se calculan en la base con `SECURITY INVOKER`.** `public.dashboard_kpis` cuenta bajo la
    RLS del que pregunta. Un panel que agrega es el sitio más fácil para filtrar datos entre tenants sin que
    se note (nadie ve filas ajenas, solo un total más alto), y una función DEFINER aquí sería justo eso.
27. **P03 — el panel no inventa cifras.** Si los pedidos visibles mezclan monedas, o no hay ninguno, la base
    devuelve `sales`/`currency` en null y la pantalla muestra un guion. Un cero en un panel se lee como dato.
28. **P03 — el espacio y su primera tienda comparten slug.** Son tablas con unicidad propia, y pedirle dos
    direcciones a quien está dando de alta su negocio es pedirle que decida algo que todavía no sabe.
29. **P04 — el panel lateral no contradice los lineamientos.** La regla de tabs centrados es para pantallas
    largas y densas; el alta de producto son ocho campos. Lo que sí se respeta del mismo bloque es la barra
    de Guardar persistente, aquí `sticky` al pie del drawer. El listado sigue detrás, así que la búsqueda y
    la pestaña de estado están donde estaban al cerrar.
30. **P04 — «eliminación segura» es el estándar §4.2 del contrato, no una invención.** Dice literalmente:
    «desactivar conserva los datos; eliminar muestra el conteo de uso real antes de borrar». Se implementa
    igual para producto (archivar / conteo de líneas de pedido e imágenes) y para categoría (desactivar /
    conteo de productos e hijas). El conteo sale de una función `SECURITY INVOKER`, así que son las cifras
    del tenant que pregunta y no un texto genérico de «esto podría afectar a otros registros».
31. **P04 — la columna se llama `stock`, no `stock_qty`.** El encargo pedía `stock_qty`; la columna existe
    desde P02 y la conocen las policies, `create_order` y los tests de aislamiento. Renombrarla sería tocar
    seis archivos para no ganar nada. Mismo criterio que la decisión 14 con `tenant_id`.
32. **P04 — imagen principal y orden se resuelven en la base.** `product_images` tiene un índice único
    parcial que prohíbe dos principales por producto: «quitar la anterior» y «poner la nueva» desde el
    navegador se comen un 409 a mitad de camino. `set_primary_product_image` y `reorder_product_images` lo
    hacen en una operación, son `SECURITY INVOKER` y **fallan a propósito** cuando la RLS deja el UPDATE en
    cero filas — un guardado que no guardó nada es peor que un error.
33. **P04 — la ruta de imagen añade el producto: `{organization_id}/{store_id}/{product_id}/{uuid}.{ext}`.**
    Los dos primeros segmentos son los que exige el CHECK de P02 y los que leen las funciones de Storage
    para autorizar; el tercero es lo que pedía el encargo. El nombre es un uuid nuevo y **la extensión sale
    del MIME, no del nombre del archivo**: un `.jpg` que en realidad es HTML no se convierte en imagen por
    llamarse así.
34. **P04 — el precio sale de la base como texto (`price::text` en el `select`).** Es la decisión 19
    aplicada al catálogo: un `numeric` en JSON se vuelve float en el primer `JSON.parse`. El formulario lo
    manda como string decimal a la Edge Function, que ya lo validaba así.
35. **P04 — Supabase vive en `features/catalog/api/`, nunca en un componente.** Las pantallas piden a los
    hooks y los hooks a los servicios. Alta y edición de producto van por la Edge Function `catalog-product`
    (que actúa con el JWT del usuario, sin `service_role`); categorías, imágenes y borrados van directos a
    la tabla bajo las policies que P02 ya definió. Ninguna consulta lleva filtro de tenant: lo pone la RLS.
36. **P04 — primero la fila, después el objeto de Storage.** Al revés, si el DELETE fallara por permisos,
    las fotos ya estarían perdidas y el producto seguiría en el catálogo apuntando a rutas muertas. Lo peor
    que puede pasar en este orden es dejar objetos huérfanos, que no rompen ninguna pantalla.
37. **P04 — mientras el espacio de trabajo se resuelve NO se dice «no tienes tiendas».** Mismo criterio que
    la sesión en P03: no afirmar algo que todavía no se sabe. Las pantallas de catálogo muestran esqueleto
    durante `status === 'loading'`.

## Pendientes / riesgos abiertos
- [ ] Confirmar con el operador el **project ref de Supabase** para eCommerce (aún no existe). Bloquea:
      aplicar las migraciones, `npm run db:types` y el despliegue de las 4 Edge Functions.
- [ ] Exponer **solo** el esquema `public` por PostgREST al crear el proyecto (`supabase/config.toml`):
      las funciones de `ebim` son de policy, no de API.
- [ ] Definir los secretos de las Edge Functions (`EBIM_PROVISIONING_KEY` ≥32 chars, `EBIM_ADMIN_ORIGINS`,
      `SUPABASE_SERVICE_ROLE_KEY`). La clave de aprovisionamiento se entrega por un canal que **no** sea el
      buzón de Drive ni el propio Drive (contrato §2.6: ambos los lee cualquiera con acceso a la carpeta).
- [x] ~~`bootstrap-tenant` se autoriza solo con la clave de aprovisionamiento~~ → **cerrado en P03**: admite
      además el JWT del hub con la firma verificada (`_runtime/verify.ts`) para el alta de sí mismo.
- [ ] `platform-context` todavía no alimenta el **nombre de las sociedades**: el selector de sociedad
      muestra el uuid corto + rol. Se cablea cuando exista el project ref y el proxy responda (P04).
- [ ] Persistir la apariencia en `profiles.settings.appearance` (hidratación cross-device al login): hoy
      solo `localStorage`. Requiere tabla de perfil, que no existe en este proyecto todavía.
- [ ] Playwright: el flujo login → alta → panel está cubierto con el router real y un backend falso
      (`src/app/auth-flow.test.tsx`), pero no en navegador real. Se aborda en el quality gate (P08).
- [ ] Rate limiting de `create-order` (checkout anónimo servido con `service_role`) — se aborda en P06.
- [ ] `shipping_total` y `discount_total` quedan en 0: las reglas de envío/descuento son de P06. Las
      columnas existen y el CHECK de cuadre del total ya las contempla.
- [ ] Alta de `ecommerce` en el hub: `apps`, `workspace_apps`, catálogo de addons propios (requiere GMAO, owner del contrato).
- [ ] Crear aviso en `coordinacion\pendientes\` declarando entrada de eCommerce a la suite y sus canales de
      integración (§0.5 del contrato) — no se hizo en esta fase por alcance (solo lectura de Drive).
- [ ] Definir crew de 5 roles (regla gmao-027) para eCommerce antes de coordinar con las otras apps.
- [ ] Decidir momento gatillo de vitrina cruzada (§6.1) hacia eSupplier/eExpense.
- [ ] Replicar assets de identidad de suite (`EbimMark`, `favicon.svg`) desde los activos compartidos.
- [ ] Confirmar si el comprador final del storefront es identidad **local** al proyecto eCommerce
      (patrón §2.5, como los proveedores de eSupplier) — supuesto actual: sí, no va al hub.
- [ ] **Variantes de producto** (talla/color/…): el checklist original de P04 las mencionaba, el encargo de
      la fase no. No existe tabla `product_variants` ni UI. Decidir con el operador si entran antes del
      storefront (P05 las mostraría) o si el modelo se queda en producto simple.
- [ ] **Miniatura en el listado de productos**: hoy las imágenes solo se ven al editar. El bucket es
      privado, así que enseñarlas en la tabla obliga a firmar N URLs por página; se hace cuando el listado
      tenga paginación, que tampoco tiene todavía.
- [x] ~~`categories` admite jerarquía sin límite de profundidad~~ → **acotado en P04**: el CRUD mínimo no
      ofrece selector de padre, así que por UI el árbol no puede crecer más de un nivel. El límite duro en
      la base se pone cuando exista la pantalla de árbol.
- [ ] **Alt text de las imágenes**: la columna `alt` existe y hoy se guarda en null (la vista cae al texto
      genérico «Imagen del producto»). Es un requisito real de WCAG AA; entra con la ficha del storefront.

## Checklist P00–P08
- [x] **P00 — Lineamientos:** Drive leído, CLAUDE.md + trace + state + architecture creados. VERIFIED.
- [x] **P01 — Frontend foundation:** Vite + React + TS + MUI, tokens de marca, layout storefront/admin,
      i18n, router, scripts `typecheck`/`lint`/`build`/`test`. VERIFIED (36 tests verdes).
- [x] **P02 — Supabase multitenant:** 8 migraciones (`tenants`, `tenant_members`, `stores`,
      `store_settings`, `categories`, `products`, `product_images`, `orders`, `order_items`), RLS default
      deny + forzada, vistas públicas, Storage por tenant, 4 Edge Functions. VERIFIED (115 tests nuevos
      sobre Postgres real). **Tipos generados pendientes**: requieren el project ref (`npm run db:types`).
- [x] **P03 — Auth y admin:** sesión única con recuperación, login/logout/recuperación de clave, guards
      `/app/*` (sesión → tenant), `TenantProvider` sin tenant cableado, alta de espacio de sí mismo con JWT
      verificado, shell MUI responsive (sidebar/drawer, header, breadcrumb, selectores) y panel de KPIs
      reales. VERIFIED (75 tests nuevos).
- [x] **P04 — Catálogo (backoffice):** productos (listado, buscador, tabs de estado, alta/edición en drawer
      con Zod, publicar/despublicar, archivar, eliminación segura), categorías con CRUD mínimo, precios,
      stock e imágenes múltiples en Storage con principal y orden. VERIFIED (93 tests nuevos).
      **Variantes de producto quedan fuera**: no estaban en el encargo de la fase (ver pendientes).
- [ ] **P05 — Storefront público:** resolución de tenant por dominio/slug, listado y ficha de producto,
      branding por tenant, SEO básico.
- [ ] **P06 — Carrito y checkout:** carrito persistente, cálculo de totales/impuestos, orden creada
      server-side (Edge Function), pagos como addon.
- [ ] **P07 — Pedidos y configuración:** gestión de pedidos en backoffice, estados, notificaciones,
      configuración por sociedad (branding, moneda, custom fields).
- [ ] **P08 — Quality gate:** typecheck + build + lint verdes, Vitest/Playwright, auditoría RLS y de
      secretos (sin `service_role` en el bundle), revisión de accesibilidad AA.

## Verificaciones de esta fase (P04)
- `npm run typecheck` (`tsc --noEmit`) → verde.
- `npm run lint` (ESLint 9 flat config) → verde, **0 problemas** (0 errores, 0 avisos).
- `npm run test` (Vitest 3) → **319 tests / 23 archivos, todos verdes** (226 de P01–P03 + 93 nuevos).
- `npm run build` (`vite build`) → verde. Se mantiene el aviso de chunk >500 kB del vendor MUI (P01).
- Auditoría de secretos sobre `dist/`: las únicas coincidencias de `service_role`/`sb_secret_` siguen
  siendo la regex del guard `assertNoServiceKey` y el chequeo de prefijo del propio SDK. Sin claves de
  servicio: el navegador sube a Storage con la clave publicable y la sesión del usuario.
- Sin push, sin PR, **sin deploy remoto**: sigue sin existir project ref.

### Qué se construyó
- **Servicios** (`features/catalog/api/`): `products.ts`, `categories.ts`, `images.ts`, `errors.ts` y
  `client.ts`. Es la única puerta a Supabase del catálogo; ningún componente importa el SDK.
- **Hooks** (`useProducts`, `useCategories`, `useProductImages`): consultas y mutaciones de React Query,
  con invalidación de todo el catálogo *y* de los KPIs del panel, que cuentan las mismas tablas.
- **Productos** (`ProductsPage` + `ProductDrawer`): tabla MUI con SKU, nombre, categoría, precio, stock y
  estado; un buscador general, tabs de estado y Exportar a CSV; menú de fila con editar, publicar,
  despublicar, archivar y eliminar. El alta/edición es un `Drawer` derecho con los ocho campos del encargo,
  validación Zod cuyos mensajes son **claves de i18n** (el mismo esquema sirve en ES y EN) y barra de
  guardar persistente. Un error del servidor **no cierra el panel**: lo que el usuario escribió se queda.
- **Imágenes** (`ProductImagesPanel`): subida múltiple, principal, mover antes/después, quitar, validación
  de MIME y tamaño (5 MB) y miniaturas por **URL firmada** — el bucket es privado (decisión P02 #18).
- **Categorías** (`CategoriesPage` + `CategoryDrawer`): listado, alta, edición, activar/desactivar y
  eliminación segura. Sin selector de padre a propósito (ver pendientes).
- **UI de suite reusable**: `TableSkeleton`/`GridSkeleton`, `FormDrawer`, `ConfirmDeleteDialog` (el estándar
  §4.2 hecho componente) y `FeedbackProvider` + `useFeedback` para los avisos efímeros.
- **Migración 10** `20260827091100_catalog_admin.sql`: trigger de primera imagen principal, ascenso al
  borrar la principal, `set_primary_product_image`, `reorder_product_images`, `product_deletion_usage` y
  `category_deletion_usage`. Todas `SECURITY INVOKER`, `search_path` fijo y `EXECUTE` revocado a `anon`.

### Un defecto de P02 que este trabajo destapó
Las tres claves foráneas compuestas con `on delete set null` (`products.category_id`,
`order_items.product_id` y `categories.parent_id`) ponían a null **toda** la clave, incluido `store_id`,
que es NOT NULL. En la práctica: **borrar una categoría con productos, o un producto con líneas de pedido,
fallaba con un error de constraint** — justo las dos operaciones que P04 estrena. Se corrigió con la lista
de columnas de Postgres 15+ (`on delete set null (category_id)`), editando las migraciones de P02 porque
ninguna está aplicada todavía. Los dos tests que lo destaparon siguen en el banco.

### Tests nuevos (93)
- `supabase/tests/catalog-admin.test.ts` (20) — sobre Postgres real: la primera imagen queda principal;
  cambiar la principal deja exactamente una; volver a marcar la misma no falla; un rol `viewer` recibe
  `SIN_PERMISO` en vez de un no-op silencioso; para el tenant vecino la imagen no existe; `anon` no ejecuta
  ninguna de las cuatro funciones; el reorden se aplica entero y rechaza listas parciales, repetidas o
  vacías; el conteo de uso es el real y el tenant vecino no lo obtiene ni forzando el `org_id` en el JWT;
  borrar la categoría deja los productos sin categoría en vez de borrarlos; borrar la principal asciende la
  siguiente; y borrar el producto se lleva sus imágenes dejando la línea de pedido con su snapshot.
- `src/features/catalog/catalog.test.ts` (38) — funciones puras: el dinero nunca se guarda como `number`;
  el formulario rechaza precio con coma, con moneda pegada o con tres decimales, y stock negativo o
  decimal; el slug usa el mismo formato que la Edge Function; los mensajes son claves de i18n; validación
  de imagen por MIME y tamaño; la ruta empieza por `{org}/{store}/{product}/` y la extensión sale del MIME;
  dos subidas no comparten nombre; `moveImage` nunca pierde elementos; el buscador neutraliza los
  separadores del filtro `or` de PostgREST; los errores de RLS se explican como falta de permiso y lo
  desconocido **no filtra el mensaje de Postgres**; y el CSV neutraliza las celdas que Excel ejecutaría.
- `src/features/catalog/ProductsPage.test.tsx` (18) — contra el árbol real con un backend falso: la tabla,
  el esqueleto mientras se resuelve el espacio, el estado vacío, el gating por rol, un solo buscador, las
  cuatro pestañas; **el alta manda `create` sin ninguno de los nueve campos de tenant** que el contrato
  prohíbe; el slug se sugiere del nombre; un precio inválido se detiene en el cliente; publicar manda solo
  el estado; y el diálogo de borrado enseña el conteo real y ofrece archivar.
- `src/features/catalog/CategoriesPage.test.tsx` (7) — el alta escribe el tenant que el JWT resolvió, un
  slug inválido no llega a escribir nada, desactivar conserva la fila, y el diálogo cuenta productos e hijas.
- `src/features/catalog/ProductImagesPanel.test.tsx` (11) — sin producto guardado no hay dónde subir; el
  objeto y la fila apuntan a la misma ruta bajo `{org}/{store}/{product}/`; varias a la vez se colocan en
  orden; el `accept` declara solo los cuatro formatos y, si un archivo se cuela igual, la validación propia
  lo para antes de tocar Storage; el tamaño se corta en 5 MB; marcar principal deja una sola; reordenar
  manda la lista completa; y quitar borra la fila **y** el objeto de Storage.
- `src/app/routes.test.tsx` — actualizado: el backoffice tiene ahora cinco secciones.

### Nota de coordinación
No se escribió en Drive (la carpeta es de solo lectura para este repo). El aviso de alta de eCommerce en la
suite y la definición de crew siguen pendientes desde P02/P03.

## Verificaciones de esta fase (P03)
- `npm run typecheck` (`tsc --noEmit`) → verde.
- `npm run lint` (ESLint 9 flat config) → verde, **0 problemas** (0 errores, 0 avisos).
- `npm run test` (Vitest 3) → **226 tests / 18 archivos, todos verdes** (151 de P01+P02 + 75 nuevos).
- `npm run build` (`vite build`) → verde. Se mantiene el aviso de chunk >500 kB del vendor MUI (P01).
- Auditoría de secretos sobre `dist/`: las únicas coincidencias de `service_role`/`sb_secret_` siguen
  siendo la regex del guard `assertNoServiceKey` y el chequeo de prefijo del propio SDK. Sin claves de servicio.
- Sin push, sin PR, **sin deploy remoto**: sigue sin existir project ref.

### Qué se construyó
- **Sesión** (`features/auth`): `SessionProvider` con una única suscripción a Supabase Auth; `getSession()`
  recupera la sesión persistida, y mientras esa lectura está en curso el estado es `loading` y no
  `anonymous` —dar por anónimo a quien sí tiene sesión lo expulsaría al login en cada F5—. La sesión de
  `PASSWORD_RECOVERY` es un estado propio: sirve para poner la clave nueva y no abre el backoffice.
- **Login / recuperación** (`AuthShell`): la anatomía de suite (§4.5, `esupplier-031`) se extrajo a un
  componente y ahora la comparten login, `/recuperar` y `/nueva-clave` — que es justo lo que pide el punto 7
  de la regla. El correo de recuperación responde igual exista o no la cuenta: lo contrario es un
  enumerador de usuarios del cliente.
- **Contexto de tenant** (`features/tenant`): `resolveTenantSelection` es una función pura con las reglas
  de resolución (claims → membresías → sociedad → tienda) y `TenantProvider` solo la alimenta. Ninguna de
  las tres consultas (`tenants`, `tenant_members`, `stores`) lleva filtro de tenant: lo pone la RLS.
- **Alta mínima** (`features/onboarding`): tres campos —nombre del negocio, dirección de la tienda, moneda—
  y ni uno más. Quién eres, a qué cuenta perteneces y con qué correo NO se preguntan: salen del token. El
  correo de administrador que exige `echange-005`/§3.2 es el de la propia sesión.
- **Shell administrativo**: sidebar fijo en escritorio y `Drawer` en móvil, topbar con breadcrumb derivado
  de la navegación, selector de sociedad (solo si hay más de una), selector de tienda (autoselección con
  una sola, preparado para varias), menú de cuenta con rol y cierre de sesión, y el nombre del espacio
  siempre visible en el sidebar.
- **Panel**: `public.dashboard_kpis` (migración 09) devuelve productos, publicados, pedidos y ventas.

### Estados cubiertos, uno por uno
| Estado | Dónde | Qué se ve |
|---|---|---|
| Cargando | sesión, workspace, KPIs | `LoadingState` con `role="status"` |
| Error | workspace, KPIs, sesión | `ErrorState` con reintento y el detalle técnico aparte del mensaje humano |
| Vacío | tenant sin tiendas, panel sin catálogo | `EmptyState` con acción, no un cero suelto |
| Sin permiso | token sin `org_id`, Configuración sin rol | `UnauthorizedState` (nuevo) con salida clara |
| Sin espacio | usuario nuevo | redirección a `/onboarding` |

### Tests nuevos (75)
- `src/features/tenant/workspace.test.ts` (15) — resolución de tenant: sin claims → `unauthorized`; sin
  membresía → `onboarding`; autoselección con una sociedad/tienda; `active_company` del JWT con varias;
  membresía viva para una sociedad que el token ya no otorga; tenant de otra organización; selectores que
  solo admiten lo que la RLS devolvió.
- `supabase/tests/bootstrap-authorization.test.ts` (22) — las dos credenciales del alta: la clave manda
  sobre la sesión, sin credencial es 401, el camino de usuario rechaza `organization_id`/`company_id`/
  `tenant_id`/`org_id`/`owner_user_id`/`admin_email` en el cuerpo, `@ebim.pe` no puede crearse un tenant,
  y una moneda mal escrita falla en vez de degradarse a PEN en silencio.
- `supabase/tests/dashboard-kpis.test.ts` (8) — sobre Postgres real: cada tenant cuenta lo suyo, pedir la
  tienda del otro por id devuelve ceros, un JWT con el `org_id` ajeno no cuenta nada, las ventas excluyen
  anulados, el dinero sale como texto, con monedas mezcladas devuelve null, y `anon` no puede ejecutarla.
- `src/app/auth-flow.test.tsx` (6) — el flujo completo contra el router real: `/app` sin sesión manda al
  login; login → alta → panel; quien ya tiene espacio va directo; ventas en guion cuando no hay cifra;
  token sin jerarquía → `unauthorized`; cerrar sesión vuelve al login.
- `src/shared/lib/roles.test.ts` (6) — la matriz de capacidades del front y la del borde son copias
  separadas (bundle vs Deno) y este test es lo que impide que se separen.
- `src/features/onboarding/bootstrapTenant.test.ts` (8) y `src/features/auth/authApi.test.ts` (7).
- `src/app/routes.test.tsx` (+3) — actualizado: ahora afirma que `/app` y `/onboarding` cuelgan del guard y que
  login, recuperación y storefront quedan fuera.

### Un defecto de P01 que este trabajo destapó
Las pantallas de Productos y Pedidos consultaban columnas que **no existen** en las migraciones de P02:
`products.image_url`, `orders.number`, `orders.total`, `orders.created_at`. Venían de los tipos de dominio
que P01 escribió antes de que existiera el esquema, y nadie lo notó porque sin project ref ninguna consulta
llegó a correr. Como el panel cuenta esas mismas tablas, se corrigieron aquí: los tipos ahora usan
`order_number`, `grand_total`, `placed_at` y `stock`, y las dos pantallas se acotan a la tienda activa.

### Coordinación (buzón leído, sin escribir en Drive)
Se leyó `coordinacion\BANDEJA.md` y los pendientes relevantes. Cómo queda P03 frente a ellos:
- `esupplier-031` (anatomía única de login) — **cumplido y extendido**: la anatomía es ahora un componente
  compartido por las tres pantallas de auth, como pide su punto 7.
- `echange-005` (correo de administrador obligatorio al crear tenant) — **cumplido en la base** desde P02;
  P03 no añade una vía que lo esquive: el alta de sí mismo toma el correo del token y falla sin él.
- `gmao-038` (multi-tenant por persona) — **sin implementar a propósito**, está pendiente de decisión del
  operador. Se adoptó su recomendación provisional: mostrar el nombre del espacio en el que estás.
La carpeta de Drive se mantiene de **solo lectura** (regla del repo), así que sigue pendiente el aviso de
alta de eCommerce en la suite, ya anotado en P02.

## Verificaciones de esta fase (P02)
- `npm run typecheck` (`tsc --noEmit`) → verde. Ahora incluye `supabase/functions/_shared` y `supabase/tests`.
- `npm run lint` (ESLint 9 flat config, `no-explicit-any` en error) → verde, 0 problemas.
- `npm run test` (Vitest 3) → **151 tests / 11 archivos, todos verdes** (36 de P01 + 115 nuevos de P02).
- `npm run build` (`vite build`) → verde. Se mantiene el aviso de chunk >500 kB del vendor MUI (P01).
- Auditoría de secretos sobre `dist/`: las únicas coincidencias de `service_role`/`sb_secret_` son la regex
  del guard `assertNoServiceKey` y el chequeo de prefijo del propio SDK de Supabase. Sin claves de servicio.
- Sin push, sin PR, **sin deploy remoto**: no existe project ref y ninguna migración se ha aplicado.

### Cómo se probó el aislamiento sin proyecto remoto
Las pruebas de RLS corren sobre **Postgres real** con `@electric-sql/pglite` (Postgres 18 en WASM).
`supabase/tests/harness.ts` recrea lo que las migraciones dan por hecho porque Supabase ya lo trae (roles
`anon`/`authenticated`/`service_role`, `auth.jwt()`, esquema `storage`), aplica **las migraciones tal cual**
y consulta con `SET ROLE` + `request.jwt.claims`. No se simula ninguna policy: si una está mal escrita,
el test falla.

- `rls-tenant-isolation.test.ts` (33) — tenant A vs tenant B vs público: lectura, escritura, borrado,
  pedidos, membresías, JWT forjado con el `org_id` ajeno, membresía revocada, tenant suspendido, gating por
  rol, columnas publicables, y aislamiento de Storage por path.
- `server-operations.test.ts` (25) — alta atómica de tenant (incluye `ADMIN_EMAIL_REQUERIDO` y que un slug
  de tienda inválido no deje tenant huérfano), recálculo de totales, stock, moneda, máquina de estados.
- `schema-invariants.test.ts` (15) — RLS activada y forzada en todas, ninguna tabla sin policy, ninguna
  policy para PUBLIC, `organization_id`+`company_id` NOT NULL e indexados, PK uuid, cero columnas
  float/real/money, `search_path` fijo en toda función SECURITY DEFINER, y que `anon`/`authenticated` no
  puedan ejecutar las operaciones de servidor.
- `edge-shared.test.ts` (42) — capa compartida de las Edge Functions: rechazo (no silencio) de un tenant
  declarado en el cuerpo, guard `@ebim.pe`, clave de aprovisionamiento, carrito sin precios, CORS por
  origen, y traducción de errores sin filtrar internos de Postgres.

### Dos fallos reales que encontraron estas pruebas
1. `ebim.safe_uuid` quedaba con `REVOKE ... FROM public` y sin `GRANT`: toda policy que derivaba el tenant
   del JWT fallaba con «permission denied for function safe_uuid». En un proyecto remoto se habría visto
   como un backoffice que no muestra absolutamente nada.
2. La vista `public_products` ordenaba la imagen principal por `created_at`, columna fuera del GRANT por
   columna de `anon`: el catálogo público reventaba con «permission denied for table product_images».

Ambos se corrigieron editando las migraciones **porque ninguna está aplicada todavía**. A partir del primer
`db push`, la regla es la del encargo: migración aplicada es inmutable y toda corrección es una migración nueva.

### Pendientes técnicos que deja P02
- Tipos de BD generados (`npm run db:types`): bloqueado por el project ref. **No se escriben a mano**
  (convención del repo), así que las pantallas siguen con los tipos de dominio de P01 hasta entonces.
- Las Edge Functions no tienen test de integración HTTP (haría falta el runtime de Deno o el stack local);
  lo que sí queda cubierto es toda su lógica de decisión, extraída a propósito a `_shared`.
- `logo_url`/`favicon_url` son URL absolutas (interfaz homologada del contrato §4.3); resolver un objeto
  subido a `store-assets` hasta una URL es trabajo de P04, cuando exista la pantalla de subida.
- El comprador del storefront no puede consultar su propio pedido: eso pide un token de seguimiento (P06),
  no una policy de `anon` sobre `orders`.
- `categories` admite jerarquía (`parent_id` amarrado a la misma tienda) pero no hay límite de profundidad;
  se acota en P04 cuando exista el árbol en pantalla.
