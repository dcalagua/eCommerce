# Estado del proyecto — eCommerce by EBIM

GUIDELINES_STATUS: VERIFIED
Fuentes: ver `docs/EBIM_GUIDELINES_TRACE.md` (11 documentos leídos en la raíz de Drive `EBIM-Plataforma`).
Última actualización: 2026-08-27

## Fase actual
**P02 — Supabase multitenant (COMPLETA).** 8 migraciones versionadas con las 9 tablas del modelo mínimo,
RLS default deny + forzada en todas, modelo de lectura pública para el storefront, Storage con aislamiento
por path y 4 Edge Functions sobre una capa compartida de auth/CORS/errores. Nada desplegado: no hay project
ref todavía. Siguiente: P03 (auth contra el hub y guards de rol en el backoffice).

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

## Pendientes / riesgos abiertos
- [ ] Confirmar con el operador el **project ref de Supabase** para eCommerce (aún no existe). Bloquea:
      aplicar las migraciones, `npm run db:types` y el despliegue de las 4 Edge Functions.
- [ ] Exponer **solo** el esquema `public` por PostgREST al crear el proyecto (`supabase/config.toml`):
      las funciones de `ebim` son de policy, no de API.
- [ ] Definir los secretos de las Edge Functions (`EBIM_PROVISIONING_KEY` ≥32 chars, `EBIM_ADMIN_ORIGINS`,
      `SUPABASE_SERVICE_ROLE_KEY`). La clave de aprovisionamiento se entrega por un canal que **no** sea el
      buzón de Drive ni el propio Drive (contrato §2.6: ambos los lee cualquiera con acceso a la carpeta).
- [ ] `bootstrap-tenant` se autoriza hoy con la clave de aprovisionamiento en cabecera, no con el JWT del
      hub: la verificación contra el JWKS llega en P03. Documentado, no olvidado.
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

## Checklist P00–P08
- [x] **P00 — Lineamientos:** Drive leído, CLAUDE.md + trace + state + architecture creados. VERIFIED.
- [x] **P01 — Frontend foundation:** Vite + React + TS + MUI, tokens de marca, layout storefront/admin,
      i18n, router, scripts `typecheck`/`lint`/`build`/`test`. VERIFIED (36 tests verdes).
- [x] **P02 — Supabase multitenant:** 8 migraciones (`tenants`, `tenant_members`, `stores`,
      `store_settings`, `categories`, `products`, `product_images`, `orders`, `order_items`), RLS default
      deny + forzada, vistas públicas, Storage por tenant, 4 Edge Functions. VERIFIED (115 tests nuevos
      sobre Postgres real). **Tipos generados pendientes**: requieren el project ref (`npm run db:types`).
- [ ] **P03 — Auth y admin:** verificación de JWT del hub, `platform-context` proxy, selector de sociedad,
      guards de rol + governance (super admin único).
- [ ] **P04 — Catálogo (backoffice):** productos, variantes, categorías, precios, stock, imágenes en Storage.
- [ ] **P05 — Storefront público:** resolución de tenant por dominio/slug, listado y ficha de producto,
      branding por tenant, SEO básico.
- [ ] **P06 — Carrito y checkout:** carrito persistente, cálculo de totales/impuestos, orden creada
      server-side (Edge Function), pagos como addon.
- [ ] **P07 — Pedidos y configuración:** gestión de pedidos en backoffice, estados, notificaciones,
      configuración por sociedad (branding, moneda, custom fields).
- [ ] **P08 — Quality gate:** typecheck + build + lint verdes, Vitest/Playwright, auditoría RLS y de
      secretos (sin `service_role` en el bundle), revisión de accesibilidad AA.

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
