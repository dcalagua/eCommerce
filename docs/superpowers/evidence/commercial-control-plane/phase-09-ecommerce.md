# CCP fase 09 — Piloto eCommerce (receptor de entitlements de EBIM MasterAdmin)

- Worktree: `eCommerce/.worktrees/ebim-commercial-control-plane-v1`, rama `feature/ebim-commercial-control-plane-v1`, base `7da2ae4` (`git fetch` falla en el sandbox por SSH; refs en caché = fase 00).
- Solo LOCAL. Sin push (regla eCommerce: commits locales), sin QAS, nada contra `ehxlxbhtlmfgneiagdcj` ni ningún remoto.
- Contrato: FIX-ENT-v1 vendorizado en `supabase/tests/fixtures/entitlements-v1/`, fijado por `CHECKSUMS.sha256` y `FIX_ENT_V1_SHA256 = 7aab413a…65d5`.

## Commits

| Commit | Tarea |
| --- | --- |
| `99af03f` | EC9-01 pin FIX-ENT-v1 + JCS (11 vectores) |
| `c93e565` | EC9-02 migraciones `20261001090000` (enum `masteradmin`, aislada) y `20261001100000` (receptor + modos) |
| `b25c65e` | EC9-03 rutas `PUT/GET /tenants/{id}/entitlements`, `GET /entitlements/manifest` + manifiesto versionado |
| `a431368` | UI de diagnóstico: origen `masteradmin` |
| `51e2c31` | Piloto de punta a punta, offline, deriva, rollback |
| (este) | pgTAP + evidencia |

## Diseño en una línea por pieza

- Mapeo canónico **1:1** sin renombrar: los 25 `entitlement_code` de `app_capabilities` ya eran `ecommerce.*` en dot-notation. Se añade una sola asignación: `ecommerce.ai.credits` (medidor `ai.credits`). Baseline no se lista.
- Receptor en esquema privado `platform_entitlements` (NO en `platform_provisioning`: la suite protegida `platform-provisioning-db.test.ts` fija la lista exacta de tablas de ese esquema).
- Modos `LEGACY/SHADOW/DUAL_READ/PRIMARY` por producto y por tenant, un paso por vez. Por defecto **SHADOW** (estado de cierre de fase).
- En `DUAL_READ/PRIMARY` el snapshot se **materializa** en la caché existente vía `sync_platform_context` con origen `masteradmin`: el gate único (`company_is_entitled`, `has_capability`, `assert_capability`, policies, vistas como `active_price_lists`, trigger de marca blanca) no cambia; `legacy_until_synced` queda resuelto.
- Kill switches (`tenant_feature_flags`) siguen en `company_is_entitled`: solo restan, no apagan baseline.
- IA: capacidad `ecommerce.ai.*` + asignación `ecommerce.ai.credits` → `ai_quotas (active, mensual)`; `ai_consume_for` (hard gate con `FOR UPDATE`) intacto. Sin asignación: PRIMARY → 0; DUAL_READ → cuota legada (D-03). 1 acción = 1 crédito hasta fase 17.
- H-ECO-1: en PRIMARY `sync_platform_context` rechaza `hub`/`provisioning` (`FUENTE_LEGADA_BLOQUEADA`, 42501) → la clave estática de `platform-context` ya no concede. `masteradmin` solo con la marca de transacción del receptor (`FUENTE_RESERVADA`).
- Offline: el enforcement nunca llama a MasterAdmin; lo aplicado no caduca.
- Deriva: `platform_reconcile_entitlements` repara la caché desde el último snapshot (DUAL_READ/PRIMARY) o recalcula shadow diffs (SHADOW).
- Rollback: bajar de DUAL_READ a SHADOW restaura el estado legado respaldado antes de la primera materialización; el snapshot aplicado se conserva.

## Criterio de éxito del piloto

`supabase/tests/platform-entitlements-pilot.test.ts` (11/11) y E2E cruzado X-07 (15/15, script `masteradmin/scripts/ccp/ecommerce-pilot-e2e.mts`, emisor y cliente M2M reales de MasterAdmin contra el receptor real de eCommerce):

deseado de MasterAdmin → PUT 200 APPLIED → gate servidor (promotions sí / payments no / IA 2 créditos y corte) → GET misma versión y checksum → replay 200 `replayed:true` → stale 409 `STALE_SNAPSHOT` → conflicto 409 `VERSION_CONFLICT`. `fetch` bloqueado y nunca llamado.

## Gate

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` / `lint` / `build` | OK |
| `npx vitest run` | 6492/6497; las 5 fallas son `scripts/qas-smoke.test.mjs` por `listen EPERM` del sandbox (idénticas en la línea base); fuera del sandbox 9/9 → efectivo 6497/6497 (+106 vs base 6391) |
| `npm run check:edge` (deno) | sin errores |
| FIX-ENT-v1: 13 fixtures contra handler + RPC reales | 13/13 |
| `platform-entitlements-db` / `-contract` / `-pilot` / pin | 34 / 26 / 11 / 34 |
| INV-1: `git diff 7da2ae4` de `_shared/platformProvisioning/**`, suites de provisioning y su migración | vacío; `platform-provisioning/index.ts` solo despacho aditivo |
| INV-4 | ninguna migración toca precios (`plans`, `addons`, `price_*`) |
| secretos | `npm run scan:secrets` SIN HALLAZGOS en cada commit |
| pgTAP `supabase/tests/database/platform_entitlements.test.sql` | **NOT_EXECUTED** (ver bloqueo) |

## Bloqueo de entorno (pre-existente)

La cadena de migraciones de eCommerce no se reproduce desde cero en los stacks locales actuales de Supabase: `20260827090600_storage_buckets.sql` hace `alter table storage.objects …` y falla con `must be owner of table objects` (CLI 2.116.0, imágenes 15.8.1.085 y 17.6.1.165); con contenedor pelado falla por `storage.buckets.public`. Dos enfoques probados y detenidos (regla 2–3 intentos). Las mismas aserciones corren en PGlite con TODAS las migraciones. Contenedores/volúmenes desechables eliminados.

## Desviaciones

1. Tablas en `platform_entitlements` en vez de `platform_provisioning` (INV-1).
2. Rutas despachadas en `platform-provisioning/index.ts` antes del handler; `handler.ts`/`m2m.ts`/`repository.ts` de provisioning sin cambios.
3. Casos de enforcement en `platform-entitlements-db.test.ts` en vez de extender `capability-enforcement.test.ts`.
4. Concesión con `companyIds` explícitos de MasterAdmin → no se concede (fail-closed, `unmapped_scope_capabilities`); manifiesto declara todo `scopeLevel: TENANT` (1 tenant MA = 1 org + 1 sociedad en eCommerce).
5. Cuota IA por mes natural (`YYYYMM`) del medidor existente; el período del snapshot no se usa como clave.
6. `UNSUPPORTED_CONTRACT_VERSION` (422) y `UNSUPPORTED_MEDIA_TYPE` (415) añadidos a los errores del receptor.
7. `vite.config.ts`/`eslint.config.js` excluyen `.worktrees/**`; `tsconfig`/eslint excluyen el contrato vendorizado.

## Operador (no ejecutado; tras GATE C y D-14)

Secretos de la función `platform-provisioning`: `EBIM_MASTERADMIN_M2M_ENTITLEMENTS_WRITE_SCOPE=ecommerce:entitlements:write`, `…_READ_SCOPE=ecommerce:entitlements:read`, `EBIM_ENTITLEMENTS_ENVIRONMENT=<DEV|QAS>`. Modo: `select public.platform_set_entitlement_enforcement_mode('PRODUCT'|'<cpt>', '<modo>', '<motivo>')` con service_role.
