# Estado del proyecto — eCommerce by EBIM

GUIDELINES_STATUS: VERIFIED
Fuentes: ver `docs/EBIM_GUIDELINES_TRACE.md` (11 documentos leídos en la raíz de Drive `EBIM-Plataforma`).
Última actualización: 2026-08-27

## Fase actual
**P00 — Lineamientos y estándares del repo.** Repo preparado con CLAUDE.md, trazabilidad, estado y
arquitectura inicial. Sin código de aplicación todavía: P01 (frontend foundation) es lo siguiente.

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
- [ ] **P01 — Frontend foundation:** Vite + React + TS + MUI, tokens de marca, layout storefront/admin,
      i18n, router, scripts `typecheck`/`lint`/`build`/`test`.
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

## Verificaciones de esta fase
- Carpeta de lineamientos accesible y leída (11 fuentes) → OK.
- Documentos creados dentro de límites de líneas (CLAUDE.md 92, trace 43, state, architecture) → OK.
- Repo git con commit inicial local, sin push/PR/deploy → OK.
