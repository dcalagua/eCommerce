# Estado del proyecto — eCommerce by EBIM

GUIDELINES_STATUS: VERIFIED
Fuentes: ver `docs/EBIM_GUIDELINES_TRACE.md` (11 documentos leídos en la raíz de Drive `EBIM-Plataforma`).
Última actualización: 2026-08-27

## Fase actual
**P01 — Frontend foundation (COMPLETA).** App Vite + React + TS + MUI con tokens de marca de suite,
routing storefront/backoffice separados, i18n ES/EN, ErrorBoundary y estados de carga/error/vacío.
Sin backend conectado todavía: las pantallas degradan a estado vacío. Siguiente: P02 (Supabase multitenant).

## Decisiones tomadas
1. eCommerce entra a la suite EBIM como app propia: **proyecto Supabase propio**, identidad/addons en el hub.
2. Identidad: Third-Party Auth contra el JWKS del hub (Modo A) con `/sso` handoff (Modo B) como plan B.
3. Aislamiento por **RLS default deny** con `organization_id` + `company_id` (uuid del hub) en toda tabla.
4. **Storefront público y backoffice separados lógicamente** dentro del mismo repo/app (`src/storefront` vs
   `src/admin`), rutas y guards distintos, design system compartido.
5. Storefront resuelve tenant por dominio/slug contra vista pública de solo lectura; nunca por dato declarado por el cliente.
6. Imágenes en **Supabase Storage** con path por tenant `{org_id}/{company_id}/...` y policies por tenant.
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

## Pendientes / riesgos abiertos
- [ ] Confirmar con el operador el **project ref de Supabase** para eCommerce (aún no existe).
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
- [ ] **P02 — Supabase multitenant:** proyecto, migraciones base (`organizations`/`companies` espejo,
      catálogo, RLS default deny), tipos generados, tests de aislamiento tenant.
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

## Verificaciones de esta fase (P01)
- `npm run typecheck` (`tsc --noEmit`) → verde, sin errores.
- `npm run lint` (ESLint 9 flat config, `no-explicit-any` en error) → verde, 0 problemas.
- `npm run test` (Vitest 3 + Testing Library) → **36 tests / 7 archivos, todos verdes**.
- `npm run build` (`vite build`) → verde. Aviso de chunk >500 kB del vendor MUI: aceptado en P01,
  se atiende con `manualChunks` cuando el bundle deje de crecer por scaffolding.
- Auditoría de secretos sobre `dist/`: la única coincidencia de `service_role` es la **regex del propio
  guard** `assertNoServiceKey`; no hay claves de servicio en el bundle.
- Sin push, sin PR, sin deploy remoto (solo commits locales en `dev`).

### Pendientes técnicos que deja P01
- Hidratar `profiles.settings.appearance` al login (cross-device) — hoy solo persiste `localStorage`.
- Playwright (E2E) se incorpora cuando exista un flujo real (checkout, P06).
- Tests de aislamiento tenant: dependen de P02 (aún no hay tablas ni RLS que probar).
- `SectionTabs`, `SearchField` y estados están creados pero solo cableados a pantallas placeholder.
