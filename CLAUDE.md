# eCommerce by EBIM — reglas del repo

App SaaS multitenant de la suite EBIM (GMAO · eExpense · eSupplier · eChange · WMS · eCommerce).

## Plataforma EBIM — LEER SIEMPRE (fuente de verdad, manda sobre este archivo y sobre el código)
Ruta local montada: `<unidad>:\.shortcut-targets-by-id\18EpkGLYe5uFBNbzY0CkamAMxv9ycP9g4\EBIM-Plataforma\`
La **letra de unidad varía por máquina** (fue `H:`, hoy es `G:`). Si la ruta falla, no concluir que no hay
contrato: resolver el acceso directo `<Drive>:\Mi unidad\EBIM-Plataforma.lnk` → `TargetPath`.
Antes de tocar identidad/auth, multitenant, sociedades, personalización, addons o arquitectura, lee:
- `EBIM-CONTRATO-PLATAFORMA.md` (contrato/interfaces)
- `EBIM-DISENO-HUB-IDENTIDAD.md` (DDL hub, effective_config, platform-context, sso-issue, RLS)
- `EBIM-DESIGN-BRIEF.md` (marca y design system)
Coordinación: revisar `coordinacion\BANDEJA.md` y `coordinacion\pendientes\` al iniciar sesión; atender
mensajes `to: ecommerce` o `to: all`, responder firmando `[ecommerce]` + fecha, mover a `respondidos\`.
Cambios a claims (§2), jerarquía (§3) o Platform Context API (§5) son **breaking**: propuesta al buzón
antes de codificar. Solo GMAO (owner) edita el contrato.

## Principios no negociables (contrato §0)
1. Separa DATOS, unifica IDENTIDAD: eCommerce tiene su propio proyecto Supabase; identidad/catálogo/billing viven en el hub.
2. Personalización = configuración + datos. NUNCA forks de schema ni un proyecto por cliente.
3. Compartido por defecto, dedicado por excepción.
4. Todo activable desde Configuración (addons, flags, branding) por cuenta/sociedad.
5. Ninguna app decide en el vacío: se registra en el hub, atiende el buzón y declara sus canales de integración.

## Multitenant y seguridad (bloqueante)
- Jerarquía: `organization` (cuenta) → `company` (sociedad) → datos. **Toda** tabla de negocio lleva
  `organization_id` + `company_id` (uuid del hub, nombres exactos, sin variantes).
- RLS activada en toda tabla, **default deny**: `org_id = jwt.org_id AND company_id = ANY(jwt.companies)`.
- `organization_id`/`company_id` **siempre del JWT**, nunca del body, header, query ni localStorage.
  Nada de tenant hardcodeado ni de "tenant que el cliente declara".
- `company_code`/`erp_code` es atributo, **no** clave: la sociedad se identifica por `company_id` (uuid).
- `service_role` **jamás** en el frontend ni en el bundle. Solo en Edge Functions / server.
- `SECURITY DEFINER` solo con autorización explícita dentro de la función y `REVOKE EXECUTE` a
  `anon`/`authenticated`/`public` cuando el llamador legítimo es servidor (lección esupplier-030).
- Bitácora/audit: escritura solo vía función `SECURITY DEFINER` validada; `anon` sin SELECT/UPDATE/DELETE.
- Super Admin ÚNICO de suite: `dcalagua@ebim.pe`. Rol operador **no asignable** desde UI y con guard 403
  en servidor aunque venga forzado en el body. `@ebim.pe` nunca como actor de negocio de un tenant.
- Secretos solo en `.env` (git-ignored). En el front solo claves publicables (`VITE_SUPABASE_URL`, anon/publishable key).

## Storefront público vs backoffice
- Separación lógica obligatoria: `storefront` (público, catálogo/carrito/checkout) y `admin` (backoffice del
  tenant) son áreas distintas con sus propias rutas, layouts y guards; comparten design system y tipos.
- El storefront resuelve el tenant por dominio/slug de URL contra una vista pública (solo datos publicables),
  nunca por parámetro confiable del cliente. Comprador anónimo → RLS de solo lectura sobre lo publicado.
- Backoffice exige sesión + membership + `active_company`. Ninguna consulta del backoffice sin filtro de tenant.

## Stack
- React + TypeScript + Vite + **MUI**. i18n ES/EN. Mobile-first responsive real. WCAG AA.
- Supabase: Postgres (RLS), Auth, Edge Functions (Deno), Storage.
- Imágenes de producto en **Supabase Storage**, bucket con path por tenant (`{org_id}/{company_id}/...`) y
  policies por tenant; lectura pública solo para el bucket del storefront.
- Identidad: Third-Party Auth contra el JWKS del hub (Modo A) o handoff `/sso?token=` (Modo B).
  Claims: `sub`, `email`, `org_id`, `companies[]`, `active_company`, `apps[]`.
- Addons/sociedades/config **se leen del hub** vía Platform Context API (Edge Function proxy); no se
  define catálogo local. Gating de módulos por addon activo.

## UI/UX de suite (obligatorio)
- Marca EBIM: verde `#5AA97F`, teal `#056769`, tipografía **DM Sans**, lockup `<Producto> by EBIM`,
  isotipo `EbimMark` SVG inline + favicon compartido, animación "gira y para" respetando `prefers-reduced-motion`.
- Theming por **tokens**, nunca colores hardcodeados. Light + dark. White-label por sociedad.
- El **color/acento es 100% del tenant** (`accent_color` de Branding). El usuario elige solo modo
  (claro/oscuro) y densidad — sin selector de paleta.
- Densidad: `comoda 40/52/12/14 · equilibrada 36/44/9/12 · compacta 32/38/6/10` (`--control-h/--row-h/--pad-y/--pad-x`).
- Default de suite: `forest` + `light` + `equilibrada`. Persistencia: `localStorage` (anti-flash) +
  `profiles.settings.appearance` (cross-device, hidratar al login).
- Contraste: `accent` para fills; `accent-deep` para texto (nunca `accent` puro como color de texto).
- Pantallas largas/densas → **tabs centrados** reusables (`SectionTabs`) con deep-link `#hash` y barra de Guardar persistente.
- Listados → **un buscador general** (`TextField`) + tabs de estado + Exportar. **No** paneles de filtros multi-campo.
- Login: anatomía única de suite (§4.5); referencia normativa = código de login de eSupplier.

## Convenciones de código
- TypeScript estricto; sin `any` en fronteras de datos. Tipos de BD generados, no escritos a mano.
- Estructura: `src/app` (router/providers), `src/features/<dominio>`, `src/shared` (ui kit, hooks, lib),
  `src/storefront`, `src/admin`; `supabase/migrations`, `supabase/functions`.
- Migraciones versionadas en `supabase/migrations`; toda tabla nueva nace con RLS + policies en la misma migración.
- Edge Functions: validan el JWT y derivan el tenant del token; `_shared/roles.ts` para guards de rol.

## Testing y verificación (antes de declarar una fase completa)
- `npm run typecheck` (`tsc --noEmit`) + `npm run build` (`vite build`) verdes. Si `tsc --noEmit` da OOM,
  usar `vite build` y decirlo explícitamente (precedente eSupplier).
- `npm run lint` verde. Unit/integración con **Vitest**; E2E con **Playwright** cuando exista UI de flujo.
- Tests de aislamiento tenant obligatorios para cada tabla nueva: un tenant no ve ni escribe datos de otro.
- Nunca borrar o saltar tests para pasar el gate. Reportar fallos tal cual.

## Git
- Rama de trabajo: `dev`. Commits **locales** por avance; **no push, no PR, no deploy** sin orden explícita del operador.
- Mensajes convencionales: `feat: | fix: | chore: | docs: | refactor:` en español.
- PowerShell 5.1: el heredoc de Bash no sirve para `git commit`; usar `git commit -F <archivo>` (UTF-8 sin BOM)
  o here-string `@'...'@`. "Exit code 255" tras commit suele ser falso positivo: validar con `git log`.
- No tocar archivos fuera del repo; la carpeta de lineamientos es **solo lectura**.

## Estado
Fase y pendientes en `docs/STATE.md`. Trazabilidad de lineamientos en `docs/EBIM_GUIDELINES_TRACE.md`.
Arquitectura en `docs/architecture.md`.
