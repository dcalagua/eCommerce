# Trazabilidad de lineamientos EBIM

Raíz de lineamientos (**solo lectura**, Drive montado). La letra de unidad **varía por máquina**: en la
sesión original era `H:`, hoy es `G:`. No fijar la letra; resolver siempre por el acceso directo:

```
G:\Mi unidad\EBIM-Plataforma.lnk   →  <unidad>:\.shortcut-targets-by-id\18EpkGLYe5uFBNbzY0CkamAMxv9ycP9g4\EBIM-Plataforma
```

En PowerShell: `(New-Object -ComObject WScript.Shell).CreateShortcut("G:\Mi unidad\EBIM-Plataforma.lnk").TargetPath`.

Fecha de lectura: 2026-08-27 · Estado: **VERIFIED** (fuentes accesibles y leídas)
Relectura directa: 2026-08-27 (P00-SaaS) — contrato v1.15, `PROTOCOLO.md`, `BANDEJA.md` y
`EBIM-CREW-ROSTER.md` leídos desde la fuente, no por traza.

## Fuentes leídas

| # | Ruta exacta (relativa a la raíz) | Qué se extrajo |
|---|---|---|
| 1 | `EBIM-PLATAFORMA-INDEX.md` | Mapa documental, jerarquía de fuentes, regla de cambios breaking |
| 2 | `EBIM-CONTRATO-PLATAFORMA.md` §0,§1,§2,§3,§5,§6,§7,§8,§9,§10 | Principios, topología, claims JWT, jerarquía org→company, Context API, addons, convenciones, checklist |
| 3 | `EBIM-CONTRATO-PLATAFORMA.md` §4.4,§4.5,§4.6 | Apariencia por usuario, login único de suite, isotipo/lockup/favicon |
| 4 | `EBIM-CONTRATO-PLATAFORMA.md` §13 | Super Admin único y enforcement doble capa (UI + servidor) |
| 5 | `EBIM-DESIGN-BRIEF.md` | Marca (#5AA97F / #056769, DM Sans), dirección de diseño, mobile-first, WCAG AA, stack React+Vite+MUI+TS |
| 6 | `EBIM-PROMPT-AGENTES.md` | Snippet obligatorio de CLAUDE.md + protocolo de buzón por sesión |
| 7 | `Estado de Suite\EBIM-ESTADO-eSupplier.md` (partes 1.2–1.3) | Topología app↔hub, Edge Functions proxy, build `vite build` (tsc OOM), rama `dev` |
| 8 | `coordinacion\respondidos\2026-08-11-esupplier-030-operador-aplicar-hardening-rls-bitacora.md` | Hardening: anon sin acceso a audit_log, REVOKE EXECUTE en SECURITY DEFINER, riesgo de tenant declarado por el cliente |
| 9 | `agentes-backup\_user\skills\esupplier-dev.md` (cabeceras + sección git) | Convención de commits, commit local, `git commit -F` por BOM en PowerShell 5.1 |
| 10 | `agentes-backup\_user\agents\qas.md` · `skills\qas\SKILL.md` | Stack de testing: Vitest/Jest, Playwright, SAST/SCA/secret scanning |
| 11 | `coordinacion\BANDEJA.md` (índice) | Reglas UX vigentes: tabs centrados (gmao-025), buscador único (esupplier-022) |

## Reglas clave derivadas para este repo

1. **Contrato > este repo.** Ante conflicto entre código local y contrato, gana el contrato; se reporta la diferencia al buzón.
2. **Proyecto Supabase propio** para eCommerce; identidad, catálogo de addons y billing quedan en el hub.
3. **Claims del JWT** (`org_id`, `companies[]`, `active_company`, `apps[]`) son la única fuente de tenant. Nada del body/header/URL.
4. **`organization_id` + `company_id` (uuid del hub) en toda tabla** + RLS default deny. `company_code` no es clave.
5. **Sin forks de schema por cliente**: personalización = config en capas + custom_fields + addons.
6. **Addons y sociedades se leen del hub** vía Platform Context API (Edge Function proxy). Gating de módulos por addon.
7. **service_role solo en servidor**; en el front únicamente clave publicable. `SECURITY DEFINER` con guard + REVOKE a anon.
8. **Super Admin único** `dcalagua@ebim.pe`: guard 403 en servidor + rol no asignable en UI.
9. **Design system EBIM**: tokens (nunca colores hardcodeados), DM Sans, isotipo/lockup/favicon de suite, light+dark, WCAG AA, mobile-first.
10. **Color = del tenant**, usuario solo modo y densidad. Defaults `forest/light/equilibrada`.
11. **UX de suite**: tabs centrados con deep-link `#hash` en pantallas largas; buscador general en listados, sin paneles de filtros.
12. **Login con anatomía única de suite** (§4.5), referencia normativa el código de eSupplier.
13. **Verificación por fase**: typecheck + build + lint verdes; Vitest/Playwright; pruebas de aislamiento tenant.
14. **Git**: rama `dev`, commits locales convencionales, sin push/PR/deploy sin orden del operador.
15. **Buzón obligatorio**: leer `coordinacion\` cada sesión; eCommerce debe declarar sus canales de integración con la suite.

## Relectura directa para P02-SaaS (2026-08-27)

Se volvieron a leer desde la fuente, no por traza, las secciones que gobiernan entitlements:

| Sección | Qué se extrajo para P02 |
|---|---|
| §5 Platform Context API | Forma exacta de la respuesta (`organization`, `companies`, `addons`, `app_active`) y que es servicio-a-servicio. El parser del proxy acepta esa forma y solo esa |
| §6 Addons | Catálogo y activación viven en `platform.*`; la app pregunta `context.addons[active_company]`. Ninguna app define catálogo local |
| §7 Qué vive dónde | «Lectura de addons/config (**cache del context**)» es lo que vive en cada app. Es la línea que autoriza `tenant_entitlements` como cache y prohíbe replicar el catálogo |
| §4.3 Branding | **`white_label` es addon premium** por contrato. Por eso es la capacidad vendible que P02 gatea de verdad: no se inventó nada |
| §4.1 Config en 3 capas | `features` es el nombre del contrato para flags dentro de la config. Los flags técnicos locales van bajo el namespace de la app, no en las claves comunes |
| §13 Doble enforcement | Guard en servidor **y** en UI: es la forma de las dos superficies cerradas en policies |

## Relectura directa para P03-SaaS (2026-08-27)

El PIM toca modelo de datos, aislamiento y superficie de backoffice, así que se releyeron:

| Seccion | Que se extrajo para P03 |
|---|---|
| §0.2 Personalización = configuración | Ningún fork de schema por cliente. Marcas, familias, atributos y unidades son DATOS del tenant, no tablas por cliente; los atributos extensibles son la respuesta a AA0004 sin tocar código |
| §3 Jerarquía | `organization_id` + `company_id` en las once tablas nuevas, con los nombres exactos. `store_id` **solo** donde la entidad pertenece de verdad a una tienda: por eso el vocabulario del catálogo no lo lleva |
| §4.2 Eliminación segura | «desactivar conserva los datos; eliminar muestra el conteo de uso real antes de borrar». `product_deletion_usage` suma variantes y kits; el conteo de kits decide si el borrado puede ocurrir, porque la FK del componente es `restrict` |
| §8 UI de suite | Tabs centrados con deep-link `#hash` para la pantalla larga (`/app/pim`); un buscador general por pestaña, sin panel de filtros multi-campo |
| §13 Doble enforcement | Las policies del PIM son la autoridad; el gating de `catalog.advanced` en ruta y en pestañas es cortesía |

## Relectura directa para P05-SaaS (2026-08-27)

Clientes y cuentas B2B tocan identidad, jerarquía y acceso de un público EXTERNO al tenant, así que
se releyeron el contrato y la bandeja antes de tocar nada:

| Seccion | Que se extrajo para P05 |
|---|---|
| §2 Identidad | La identidad la emite el hub: `business_account_users.user_id` es el `sub` del JWT y **no** tiene FK a `auth.users`. Atar el portal al proveedor de identidad de hoy contradiría la definición de hecho de la fase |
| §2.6 / regla 6 del contrato de ejecución | El tenant y la cuenta se derivan del servidor. `my_business_accounts()` no acepta argumentos, y por eso no hay id de cuenta que el navegador pueda declarar |
| §3 Jerarquía | `organization_id` + `company_id` en las ocho tablas nuevas, nombres exactos. **Sin `store_id`**: el cliente es de la sociedad, como el segmento de P04 |
| §4.2 Eliminación segura | `customer_deletion_usage` cuenta lo que se lleva la cascada y también los pedidos, que **no** se borran. Desactivar es el botón primario |
| §8 UI de suite | Tabs centrados con deep-link `#hash` en `/app/customers`; un buscador general por listado |
| §13 Super Admin / actor de negocio | `@ebim.pe` no puede vincularse a una cuenta B2B: un CHECK en la base y una validación en el formulario. Un operador de la suite dentro de la cuenta de un cliente compraría en su nombre |

**Bandeja:** revisada al iniciar (`coordinacion\BANDEJA.md` y `pendientes\`). Siete mensajes
`to: [all]` siguen pendientes y son los mismos que P00 dejó anotados —se responden con el mensaje de
alta de la app y no antes—; **ninguno `to: ecommerce`** y ninguno afecta a esta fase.

## Hallazgo de la relectura directa (2026-08-27, P00-SaaS)

**`ecommerce` no figura en ninguna de las fuentes.** No está en el contrato v1.15 (cabecera «Apps»:
`gmao`, `eexpense`, `esupplier`, `echange`, `wms`, + `odoo` futuro), no es un `from`/`to` válido del
`PROTOCOLO.md`, no tiene una sola fila en `BANDEJA.md`, no aparece en `EBIM-CREW-ROSTER.md` y no existe
`Estado de Suite\EBIM-ESTADO-eCommerce.md`. La regla 15 de arriba sigue sin cumplirse, y hoy **no puede**
cumplirse: el alta la hace GMAO (owner del contrato) por decisión del operador. Detalle y secuencia en
`SAAS_BASELINE.md` (R12) y `SAAS_ROADMAP.md` §5.1.

## Nota
No se copió contenido extenso de las fuentes. Este repo solo referencia rutas; los documentos permanecen en Drive.
