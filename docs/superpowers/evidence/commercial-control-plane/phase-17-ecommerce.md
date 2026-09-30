# CCP fase 17 — eCommerce: medición de uso (outbox `ebim.usage/v1` hacia EBIM MasterAdmin)

- Worktree: `eCommerce/.worktrees/ebim-commercial-control-plane-v1`, rama `feature/ebim-commercial-control-plane-v1`, base `e1ab64f` (fase 09 cerrada).
- Solo LOCAL. Sin push, sin QAS/PRD, sin `supabase link`/`db push`/deploy/secretos remotos.
- Contrato: FIX-USG-v1 vendorizado en `supabase/tests/fixtures/usage-v1/` (todo el directorio menos `*.test.ts`), fijado por `CHECKSUMS.sha256` y `FIX_USG_V1_SHA256 = 9f77d3cd692a52287d1af20b766d3a6024d3f4485de664460de035245ba7d6e1` (`supabase/tests/usage-fixtures-pin.test.ts`). Archivos vendorizados sin editar.

## Punteros del plan §12.2 verificados en el código

| Puntero | Realidad |
| --- | --- |
| `ebim.ai_record` (`20260921120000_ai_core.sql` ~462/521) | Confirmado. `ebim.ai_record` (JWT + ticket) y `public.ai_record_for_store` (service_role) delegan en `ebim.ai_record_for`, que inserta UNA fila en `public.ai_interactions`, también en fallo (`status='error'`, `error_kind`). |
| `_shared/aiCore.ts` | Confirmado; el orden real está en `_shared/aiPipeline.ts` (`ejecutarIA`): registra siempre tras consumir cuota, también al fallar. |
| `platform_provisioning.usage_outbox` | **Desviación**: `platform_usage.usage_outbox` (INV-1, ver abajo). |
| sender en `integration-worker` o función nueva | Función nueva `usage-outbox-worker`, mismo patrón que `integration-worker` (`EBIM_WORKER_KEY` en cabecera, tiempo constante). |

## Diseño

- **Origen, misma transacción**: trigger `AFTER INSERT` en `public.ai_interactions` → `platform_usage.enqueue_ai_interaction()` (DEFINER, `search_path=''`). Es el camino menos invasivo: `ai_record*` y sus tests no cambian (`ai-core-db` 24/24, `ai-metering` 29/29). Si la traza se deshace, el evento también (probado).
- **Mapeo**: `meterCode = ecommerce.ai.calls`, `unit = call`, `quantity = 1` (1 traza = 1 llamada cobrada localmente, porque la traza solo existe tras consumir cuota). `capabilityCode` = `app_capabilities.entitlement_code` de `ebim.ai_capability_for(feature)` (códigos de fase 09, p. ej. `ecommerce.ai.content`, `ecommerce.ai.insights`). Cuotas locales intactas (sin peso 1; D-03 no aprobado).
- **`internal`**: solo `provider`/`model`/`inputTokens`/`outputTokens`/`cacheTokens`/`latencyMs`; un contador en 0 se **omite** (la traza guarda 0 por defecto y no distingue «0» de «no vino»; el contrato prohíbe inventar 0). `model='desconocido'` (marcador del pipeline cuando el transporte lanzó) se omite. `provider='anthropic'` solo si el modelo es `claude-*`. Nunca prompt/respuesta.
- **Tenant**: del mapping de provisioning ACTIVE (`platform_provisioning.requests`), leído en el trigger. Sin mapping → `PENDING` + `last_error_code='TENANT_NOT_MAPPED'`, `control_plane_tenant_id` nulo; el reclamo lo excluye y `mark` lo ignora (nunca SENT/DEAD; CHECK en la tabla).
- **Inmutable**: trigger `BEFORE UPDATE/DELETE` + `BEFORE TRUNCATE` → `USAGE_FACT_IMMUTABLE` (42501) si cambia cualquier columna de hecho, si se borra, o si la fila ya es `SENT`/`DEAD`. `quantity >= 0` por CHECK. `occurred_at` truncado a ms (lo que viaja es exactamente lo guardado).
- **Privacidad**: esquema `platform_usage` sin USAGE para nadie; tabla con RLS forzada y cero grants (incluido service_role). RPC `public.platform_usage_outbox_claim(p_limit int=500, p_lease_seconds int=300) → jsonb` y `public.platform_usage_outbox_mark(p_results jsonb) → jsonb` DEFINER, `search_path=''`, EXECUTE solo service_role.
- **Reclamo**: `FOR UPDATE SKIP LOCKED`, lease = `next_attempt_at := now() + lease` (30..900 s), límite 1..5000, orden estable, solo `PENDING` con tenant y vencidos.
- **Marcas**: `SENT` (ACCEPTED/DUPLICATE) → `sent_at`; `DEAD` + código (REJECTED); `RETRY` → `attempts+1`, `next_attempt_at = now() + min(30·2^(attempts−1), 21600) s`. Una entrada malformada rechaza toda la llamada (`USAGE_MARK_INVALID`, 22023).
- **Emisor** (núcleo puro, DI): `supabase/functions/_shared/usageOutbox/sender.ts` (+ `contract.ts`). Sin `jsr:`/`npm:`/`Deno`; carga con `node` a secas (strip-types) y con Vitest/tsx. Apagado por defecto: si `USAGE_OUTBOX_SENDER_ENABLED !== 'true'` no reclama ni firma ni llama. Encendido con configuración incompleta → `MISCONFIGURED` (solo nombres de variables), sin reclamar. Mapea → lotes ≤500/≤256 KB → JWT ES256 **nuevo por lote e intento** (`iss=ecommerce.ebim`, `aud=masteradmin.ebim`, `scope=usage:ingest`, TTL 120 s ≤ 300, jti = UUID nuevo) → POST (`redirect: manual`, timeout 15 s) → clasificación por posición (paridad con los vectores vendorizados y con `reference-sender.ts`) → `mark` tras cada lote. Fila no enviable → `DEAD` con su código; sin tenant → `RETRY TENANT_NOT_MAPPED` (nunca se descarta).
- **Edge Function** `usage-outbox-worker`: solo POST, `x-ebim-worker-key` vs `EBIM_WORKER_KEY` (≥32, tiempo constante), `verify_jwt=false` en `config.toml` (patrón `notifications-dispatch`), 503 si falla la base. Ningún cron en migraciones.

### Firmas exportadas (ruta estable)

```ts
// supabase/functions/_shared/usageOutbox/sender.ts
export function buildUsageEvent(row: UsageOutboxRow, ctx?: BuildUsageEventContext): UsageEvent
export async function runUsageOutboxSender(deps: UsageOutboxSenderDeps): Promise<UsageOutboxSenderReport>
// deps: { env(name), claim(limit), mark(results), fetchImpl, nowMs?, randomUUID?, claimLimit?, timeoutMs?, tokenTtlSeconds? }
// report: { status: 'DISABLED'|'MISCONFIGURED'|'OK', missing?, claimed, batches, sent, dead, retry }
```

## Variables de entorno (solo nombres; nada configurado)

`USAGE_OUTBOX_SENDER_ENABLED` (`'true'` para encender), `MASTERADMIN_USAGE_INGEST_URL` (https; http solo localhost), `ECOMMERCE_USAGE_PRIVATE_KEY` (PKCS#8 PEM P-256; acepta `\n` literales), `EBIM_USAGE_ENVIRONMENT` (`DEV|QAS|DEMO|PRD`), `EBIM_WORKER_KEY` (existente).

## TDD

- RED: `logs/EC17-01-red.txt` (24 de 25 fallan: módulos y RPC inexistentes).
- GREEN: pin 14/14, sender 42/42, db 25/25, pgTAP-en-PGlite 1/1 (39 aserciones), rollback 1/1.

## Gate

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` / `lint` / `build` / `check:edge` | OK (`logs/EC17-08-gate-*.txt`) |
| `npm test` | 6576/6581; las 5 fallas son `scripts/qas-smoke.test.mjs` por `listen EPERM` del sandbox (idénticas a la línea base de fase 09) → efectivo 6581/6581 (+84 vs 6497) |
| `npm run test:db` | 3928/3928 (149 archivos) |
| protegidas INV-1 (`platform-provisioning-contract` 42, `-db` 22) | verdes; `git diff e1ab64f` de las suites protegidas, `platform_provisioning.test.sql`, `_shared/platformProvisioning/**`, `platform-provisioning/**`, su migración y `ai_core.sql`: **vacío** (`logs/EC17-08-inv1-diff.txt`) |
| INV-4 | la migración no toca `plans`/`addons`/precios |
| secretos | `npm run scan:secrets` SIN HALLAZGOS; grep del diff staged: solo el NOMBRE del rol `service_role` (grants, revokes, pgTAP, comentarios y logs); ningún PEM, ningún JWT, ningún `sk_*`. Las claves de test son efímeras en memoria (`generateKey`) |
| pgTAP `supabase test db` (stack LOCAL) | **NOT_EXECUTED**: el sandbox deniega el socket de Docker y la escritura de `~/.supabase`; la ejecución fuera del sandbox no está autorizada en esta sesión (`logs/EC17-05-pgtap-supabase-test-db.txt`). Además sigue el bloqueo pre-existente de fase 09 (`20260827090600_storage_buckets.sql`). El MISMO archivo `database/platform_usage_outbox.test.sql` se ejecuta tal cual sobre PGlite con todas las migraciones y un shim mínimo de pgTAP (`usage-outbox-pgtap.test.ts`): 39/39. |

`SKIP LOCKED` bajo concurrencia real no se puede ejercitar en PGlite (una conexión): se verifica que la función lo contiene y que el lease impide el segundo reclamo.

## Rollback

`rollback/fase-17-usage-outbox-rollback.sql` (operador; no es migración): quita trigger, RPC y esquema; la traza de IA queda como antes. Dry-run: `supabase/tests/usage-outbox-rollback.test.ts` (aplica sobre PGlite, verifica y deshace) 1/1.

## Desviaciones

1. Outbox en esquema `platform_usage` en vez de `platform_provisioning` (INV-1: la suite protegida fija tablas y grants de ese esquema). Mismo criterio que fase 09.
2. Hook por trigger en `public.ai_interactions` en vez de editar `ebim.ai_record` (misma transacción; menos invasivo; `ai_core.sql` sin cambios).
3. Núcleo del emisor reimplementado en `_shared/usageOutbox/contract.ts` (no se importa el vendorizado en runtime: `supabase/functions` no depende de `tests/`); la paridad se prueba contra `reference-sender.ts` y los vectores.
4. Contadores en 0 se omiten de `internal` (la traza no distingue 0 de ausente); `provider` se infiere solo de modelos `claude-*`.
5. Nueva variable `EBIM_USAGE_ENVIRONMENT` (el contrato exige `environment` en el lote).
6. `usage-outbox-worker` con `verify_jwt=false` (clave dedicada de trabajador, patrón `notifications-dispatch`).
7. Commit único para toda la fase (regla del flujo), en vez de uno por tarea.

## Pendientes

- pgTAP en un stack Supabase local real (requiere Docker fuera del sandbox + el bloqueo de `storage_buckets` de fase 09).
- Eventos `TENANT_NOT_MAPPED` quedan PENDING indefinidamente (sin RPC de re-atribución; decisión de producto).
- Sin retención/purga de filas `SENT` (el hecho es inmutable; una purga necesita decisión y excepción controlada).
- Operador (tras D-12 / GATE): secretos del worker, registrar la clave pública en MasterAdmin (`usage_ingest_credentials`), medidor `ecommerce.ai.calls` en MasterAdmin, planificador que invoque el worker. E2E cruzado contra `usage-ingest` real: no ejecutado en esta fase.

## Reanudación de la fase 17: caracterización del bloqueo `storage_buckets`

- **Sentencia:** `supabase/migrations/20260827090600_storage_buckets.sql:83`, `alter table storage.objects enable row level security;`.
- **Origen:** commit `c5111cb` (2026-08-27, "add multitenant supabase foundation"), que ya está en la base DEV original `7da2ae4`. No lo introdujo el programa.
- **Causa, comprobada en solo lectura** sobre la imagen local actual `supabase/postgres:17.6.1.165`:
  - `storage.objects` y `storage.buckets` pertenecen a `supabase_storage_admin`;
  - el rol de migraciones `postgres` no es superusuario (`rolsuper=f`);
  - RLS ya viene activado (`relrowsecurity=t`).

  Solo el dueño puede hacer `ALTER TABLE`, así que la sentencia falla con `must be owner of table objects` aunque sea redundante.
- **Clasificación:** **defecto de portabilidad de la migración, preexistente**, no un problema de infraestructura local.
  - Afecta a cualquier base nueva creada desde cero con las imágenes actuales de Supabase: stacks locales, `db reset` y un proyecto nuevo.
  - No afecta a las bases que ya la tienen registrada como aplicada.
  - No se relaciona con la fase 17: su migración y su pgTAP corren sobre PGlite con toda la cadena (39/39).
- **Corrección propuesta (no aplicada; decide el dueño de eCommerce):** quitar la sentencia redundante o condicionarla con `if not relrowsecurity`. Cambiar una migración histórica exige revisar el historial remoto, así que queda fuera de este programa.
- **Consecuencia para la fase 19 (QAS):** QAS no se puede recrear con `db reset` hasta resolver esto. La verificación en vivo tiene que usar la base QAS existente, sin reset, y aplicar solo las migraciones nuevas del programa.
- No se cambió nada en QAS ni en PRD.
