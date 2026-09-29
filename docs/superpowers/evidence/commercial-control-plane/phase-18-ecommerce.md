# CCP fase 18 — eCommerce: D-14 (DEV/LOCAL) · appActive comercial y corte a MASTERADMIN_PRIMARY

- Worktree: `eCommerce/.worktrees/ebim-commercial-control-plane-v1`, rama `feature/ebim-commercial-control-plane-v1`, base `e82bd2e`.
- Decisión humana **D-14**, aprobada solo para DEV/LOCAL (2026-09-29). Reglas aplicadas: (1) pasar a MASTERADMIN_PRIMARY en DEV con paridad y seguridad en verde; (2) `appActive=false` retira lo comercial, no bloquea la operación; (4) tenants legados: adoptar solo con evidencia determinista, si no UNRESOLVED.
- Solo LOCAL: sin push, sin QAS/PRD, sin `supabase link`/`db push`/`functions deploy`/`secrets set`. Ningún secreto impreso (claves del X-07 generadas en memoria).

## Supabase CLI (antes de tocar el esquema)

`logs/EC18-00-supabase-cli.txt`: `supabase --version` → **2.116.0**; `supabase migration new --help` revisado. Dentro del sandbox el CLI falla con `EPERM` al escribir `~/.supabase/telemetry.json`; se ejecutó fuera del sandbox (solo `--version`/`--help`).
La migración se creó a mano con el prefijo `20261003100000`: `migration new` estampa la hora actual (2026-09-29…), que ordenaría ANTES de las migraciones ya existentes con fecha futura (`20261001…`, `20261002100000`) y no se aplicaría en el orden correcto. Mismo criterio que las fases 09 y 17.

## A · Regla 2: `appActive=false` retira lo comercial, no la operación

Verificado en el código: la última definición de `ebim.company_is_entitled` (`20260914180000_capability_guard_core.sql:112-168`) era `coalesce(app_active,true) AND exists(baseline OR …)` → con la app inactiva caían también las cinco baseline (`catalog`, `storefront`, `checkout`, `orders`, `analytics.basic`). `has_capability`, `assert_capability`, `effective_capabilities` y las policies la heredan.

- Migración nueva `supabase/migrations/20261003100000_app_active_commercial_only.sql`: redefine SOLO `ebim.company_is_entitled` (misma firma, SECURITY INVOKER, `search_path=''`) como `baseline OR (app_active AND (entitlement OR fallback legado) AND flag ≠ false)`.
- Resto de SQL con `app_active` revisado: `ebim.active_price_lists` (`20260827180100`, `20260914101000`) filtra por `app_active` pero gatea `pricing.lists`/`trade.quotes` (vendibles) → correcto, sin cambio. `platform_entitlements.known_codes` excluye lo baseline → `record_shadow_diffs` no ve diferencias nuevas. `observability_ops` solo informa `app_active`.
- Espejo TS `src/domain/capabilities.ts#resolveCapabilities`: con `!appActive` se descartan las vendibles (incluido el fallback legado) y se conserva lo baseline; un flag sigue sin apagar lo baseline. Comentario de `src/features/admin/navigation.tsx` actualizado (catálogo/pedidos siguen en el menú).
- Tests reescritos (no borrados): `src/domain/capabilities.test.ts` (2 casos), `supabase/tests/capabilities.test.ts` (describe «app_active: false retira lo comercial…», con white label e integraciones contratadas), `supabase/tests/platform-entitlements-db.test.ts` («appActive=false retira lo comercial y NO la operación»: baseline true, `promotions`/`ai.assist` false, y v2 activa los devuelve). El escenario de paridad SQL↔TS «app no contratada» (`capabilities.test.ts:238`) sigue verde con las dos mitades cambiadas.
- Test nuevo de confirmación (regla 4): `platform-entitlements-db.test.ts` «una sociedad legada (sin provisioning de MasterAdmin) decide y escribe igual en PRODUCT PRIMARY» — pasa ya en RED: confirma que `company_is_entitled` no mira el modo y `legacy_write_policy` devuelve `ALLOW` sin cpt.
- Docs: ADR-002 §3 + sección «Enmienda D-14 regla 2 (2026-09-29)», `docs/STATE.md`, `docs/B2B_GAP_ANALYSIS.md`.
- **Contradicción anotada, no editada**: `supabase/tests/fixtures/entitlements-v1/README.md` y `fixtures/06-app-inactive.json` (FIX-ENT-v1, con checksum) dicen «appActive=false → el SaaS bloquea el acceso operativo» y `reference-receiver.ts#isEntitled` niega lo baseline sin `appActive`. Los tests de contrato solo comparan respuestas HTTP PUT/GET (no cambian); la nota está en ADR-002.

### TDD

| | Comando | Resultado |
| --- | --- | --- |
| RED | `npx vitest run src/domain/capabilities.test.ts supabase/tests/capabilities.test.ts supabase/tests/platform-entitlements-db.test.ts` | 4 fallan / 90 pasan (`logs/EC18-01-red.txt`): `expected [] to deeply equal [ 'analytics.basic', 'catalog', … ]`, `expected 'catalog: false' to be 'catalog: true'` |
| GREEN | mismo comando tras la migración y el espejo TS | 94/94 (`logs/EC18-02-green.txt`) |

## B · X-07 (`masteradmin/.worktrees/ebim-commercial-control-plane-v1/scripts/ccp/ecommerce-pilot-e2e.mts`) — fase D14

Fase "D14" añadida AL FINAL, sin rollback:

| Check | Qué prueba |
| --- | --- |
| D14.0 | tenant legado con los ids de la semilla `miquimica` (entitlements `provisioning`, sin contexto) creado en PGlite; sin cpt |
| D14.1 | tenant de certificación: `platform_reconcile_entitlements` sin deriva, paridad caché↔snapshot = 0. `shadow_diffs` **no aplica**: fue a PRIMARY por tenant antes del primer push (0 filas, se deja constancia) |
| D14.2 | cohorte (2.º tenant mapeado, sin modo propio) en SHADOW por el producto: APPLIED, `shadow_diffs` = 0 (el snapshot reproduce su decisión legada `legacy_until_synced`) |
| D14.3 | `platform_set_entitlement_enforcement_mode('PRODUCT', …, D14_REASON)` SHADOW→DUAL_READ→PRIMARY, un paso por vez, motivo en `mode_events` |
| D14.4 | cohorte materializada por el modo del producto: PRIMARY, paridad 0, misma decisión |
| D14.5 | **negativo**: `sync_platform_context` con origen `hub` y `provisioning` para los dos tenants mapeados → `FUENTE_LEGADA_BLOQUEADA`; nada concedido |
| D14.6/7 | v4 `appActive=false`: comercial denegado (`pricing.lists`, `ai.assist`, consumo IA `DISABLED`); baseline (catalog, storefront, checkout, orders, analytics.basic) concedido |
| D14.8 | v5 `appActive=true`: lo comercial vuelve |
| D14.9 | GET final: `enforcementMode=PRIMARY`, `appliedVersion=5`, `appliedChecksum` = checksum de v5 |
| D14.10 | legado sin mapping: mismas decisiones bajo PRODUCT PRIMARY, `legacy_write_policy(hub)` = ALLOW |
| D14.11/12 | todos los mapeados en PRIMARY; paridad bloqueante total 0 |

`writeD14Evidence`: `product: 'ecommerce'`, `scope: 'PRODUCT'`, `legacyWrite: BLOCKED`, `legacyTenants`: `d0000000-0000-4000-8000-000000000001` (miquimica) **UNRESOLVED** — sin mapping determinista en MasterAdmin; sigue en su fuente legada; la clave estática H-ECO-1 de `platform-context` queda vigente solo para sociedades sin mapping. `billing: null`. Cualquier check fallido → `exitCode 1` (vía `check()`).

Ejecución (fuera del sandbox: el sandbox niega `listen` en 127.0.0.1 con `EPERM`):

```
ECOMMERCE_WT=<worktree eCommerce> CCP_EVIDENCE_DIR=<tmp> node --experimental-transform-types scripts/ccp/ecommerce-pilot-e2e.mts
```

- GREEN: **28/28 PASS, rc=0** (`logs/EC18-04-x07-green.txt`; JSON `logs/EC18-04-d14-ecommerce.json`).
- RED de control (misma corrida SIN la migración `20261003100000`): 27/28, rc=1, `FAIL · D14.7 … catalog=false storefront=false checkout=false orders=false analytics.basic=false` (`logs/EC18-03-x07-red-sin-migracion.txt`). Migración restaurada después.

**Desviación de entrega**: el agente estaba aislado en otro worktree de MasterAdmin y el arnés le bloqueó escribir en `masteradmin/.worktrees/ebim-commercial-control-plane-v1`. El cambio se ejecutó desde una copia (imports relativos reescritos a absolutos) y se entrega como parche exacto: `patches/masteradmin-x07-ecommerce-pilot-e2e-d14.patch` (aplica limpio sobre el archivo actual con `patch -p1`/`git apply`; sha256 del resultado `88322272b5a66d3f9f04399c60435760ee669c7c1ad478352c8dfd4586f4460a`). No se hizo commit en MasterAdmin.

## C · Gate eCommerce

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | OK (`logs/EC18-05-gate-typecheck.txt`) |
| `npm run lint` | OK (`logs/EC18-05-gate-lint.txt`) |
| `npm run -s test:db` | **3929/3929** (149 archivos) — +1 vs fase 17 (3928) (`logs/EC18-06-test-db.txt`) |
| `npm run build` | OK (`logs/EC18-05-gate-build.txt`) |
| `npm test` | 6578/6583 en sandbox; las 5 fallas son `scripts/qas-smoke.test.mjs` por `listen EPERM` del sandbox (5 ocurrencias en `logs/EC18-07-npm-test.txt`), preexistentes e idénticas a fases 09/17. Fuera del sandbox ese archivo da 9/9 (`logs/EC18-07-qas-smoke-unsandboxed.txt`) → efectivo **6583/6583** (+2 vs 6581 de fase 17) |
| `npm run scan:secrets` | SIN HALLAZGOS (`logs/EC18-08-scan-secrets.txt`) |

## Pendientes / riesgos

- Contrato FIX-ENT-v1 (README, fixture 06, `reference-receiver.ts`) sigue diciendo que `appActive=false` bloquea la operación: debe alinearlo el dueño del contrato (MasterAdmin) en la próxima versión.
- `miquimica` sigue UNRESOLVED y fuera del plano de control; H-ECO-1 sigue abierto para sociedades sin mapping.
- El seed de migración sigue en `SHADOW` (a propósito: las suites dependen de él); el PRIMARY de producto de D-14 es una transición en tiempo de ejecución por la RPC gobernada, no un cambio de esquema.
