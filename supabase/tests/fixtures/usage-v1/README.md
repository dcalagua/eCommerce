# FIX-USG-v1 — contrato `ebim.usage/v1`

Contrato normativo de envío de uso desde cada SaaS (emisor) a MasterAdmin (receptor).
Spec: `docs/superpowers/specs/2026-09-27-ebim-commercial-control-plane-design.md` §11–§12, §14.
Plan: `docs/superpowers/plans/2026-09-27-ebim-commercial-control-plane-implementation.md` §12.

**Este directorio es inmutable una vez publicado.** Una corrección es `v1.1` aditivo en un directorio nuevo. Cada SaaS copia el directorio completo y lo fija con `CHECKSUMS.sha256` (test `usage-fixtures-pin`, constante `FIX_USG_V1_SHA256 = sha256(CHECKSUMS.sha256)`).

## 1. Flujo

```
acción medida / llamada IA (SaaS)
  → fila en el outbox local, en la MISMA transacción o en el `finally` del pipeline IA
  → worker con backoff: lotes ≤ 500 eventos y ≤ 256 KB, JWT ES256 nuevo por intento
  → POST {MasterAdmin}/functions/v1/usage-ingest
  → usage_events append-only (idempotente por (producto, eventId))
  → agregado por tenant × medidor × período (OPEN → CLOSING → FINALIZED)
  → créditos IA / asignación / exceso → línea de factura (fase 18)
```

Nunca se factura desde eventos crudos. El SaaS **no** depende de MasterAdmin para atender al usuario: si el ingest está caído o apagado, el outbox acumula.

## 2. Autenticación

- `Authorization: Bearer <JWT>` firmado **por el SaaS** con su clave privada ES256 (P-256) propia por producto × ambiente. La clave privada vive solo en el SaaS (secreto de su runtime); MasterAdmin registra la **pública** por referencia (`platform.usage_ingest_credentials.public_key_ref` = nombre de variable `…_PUBLIC_JWK` o `…_PUBLIC_KEY` con una JWK EC P-256 o un PEM SPKI).
- Cabecera: `alg = ES256` (cualquier otro → `ALGORITHM_NOT_ALLOWED`), `typ = JWT` opcional, `kid` opcional.
- Claims: `iss = <product>.ebim` (identifica la credencial y, por ella, el producto), `aud = masteradmin.ebim`, `scope` contiene `usage:ingest` (o `scp[]`), `iat`, `exp` enteros con `exp − iat ≤ 300`, `jti` único (un solo uso por emisor). Skew tolerado: 60 s.
- **Desviación D-12** del contrato §2.6: la credencial identifica al **producto**, no al tenant. Cada evento trae `controlPlaneTenantId` y MasterAdmin lo rechaza (`TENANT_NOT_MAPPED_FOR_PRODUCT`) si ese tenant no tiene un mapping de provisioning ACTIVE para ese producto.
- **Apagado por defecto**: `USAGE_INGEST_ENABLED != 'true'` en MasterAdmin o `product_integrations.usage_ingest_enabled = false` → `503 USAGE_INGEST_DISABLED`. Se enciende solo con la aprobación de D-12.

## 3. Petición (`request.schema.json`)

```json
{
  "schema": "ebim.usage/v1",
  "environment": "DEV",
  "productCode": "eexpense",
  "batchId": "<uuid por intento de envío>",
  "events": [ { …evento… } ]
}
```

`environment` debe ser el de la credencial (`ENVIRONMENT_MISMATCH`); `productCode` es opcional y, si viene, debe ser el de la credencial (`PRODUCT_MISMATCH`).

Evento (ningún campo adicional):

| Campo | Regla |
| --- | --- |
| `eventId` | UUID generado **en origen** al crear la fila del outbox; estable ante reintentos |
| `meterCode` | medidor ACTIVE del producto (`meters.json`); DRAFT o inexistente → `UNKNOWN_METER` |
| `quantity` | número finito, ≤ 6 decimales, `|q| < 1e14`; **no negativo** salvo medidor con `allowsNegative` (eventos compensatorios) |
| `unit` | exactamente la unidad del medidor (`UNIT_MISMATCH`) |
| `occurredAt` | ISO-8601 con zona; no más de 5 min en el futuro. Define el período (mes UTC, D-10) |
| `controlPlaneTenantId` | UUID del tenant en MasterAdmin (el del contrato de provisioning) |
| `externalCompanyId` | opcional, id de compañía del SaaS (atribución) |
| `subjectRef` | opcional, referencia opaca del sujeto (p. ej. para `COUNT_DISTINCT_SUBJECT`); nunca PII |
| `capabilityCode` | opcional; para IA, la capacidad `AI_FEATURE` que consumió (pesos de créditos, §12) |
| `internal` | opcional, **solo COGS**: `provider`, `model`, `inputTokens`, `outputTokens`, `cacheTokens`, `latencyMs`, `costAmount`, `costCurrency`. Los tokens se envían **solo si el proveedor los devolvió**; si no, la clave se omite (nunca 0 ni estimación). Nunca prompts, respuestas, textos, archivos ni datos del cliente |

## 4. Respuesta

`200` con resultado **por evento, en el orden del lote**:

```json
{ "schema": "ebim.usage/v1", "batchId": "…",
  "results": [ { "eventId": "…", "status": "ACCEPTED" },
               { "eventId": "…", "status": "DUPLICATE" },
               { "eventId": "…", "status": "REJECTED", "code": "UNKNOWN_METER" } ],
  "accepted": 1, "duplicate": 1, "rejected": 1 }
```

| Estado | Significado | Outbox |
| --- | --- | --- |
| `ACCEPTED` | evento nuevo persistido | `sent` |
| `DUPLICATE` | mismo `eventId` y mismo contenido (hash JCS) ya existía | `sent` |
| `REJECTED:CONFLICT` | mismo `eventId`, contenido distinto (alerta de integridad en MasterAdmin) | terminal (dead-letter) |
| `REJECTED:<code>` | `INVALID_EVENT`, `UNKNOWN_METER`, `NEGATIVE_QUANTITY`, `UNIT_MISMATCH`, `OCCURRED_AT_IN_FUTURE`, `INTERNAL_METADATA_INVALID`, `TENANT_NOT_MAPPED_FOR_PRODUCT`, `ENVIRONMENT_MISMATCH` | terminal (dead-letter con el código) |

Errores de **lote** (HTTP ≠ 200): `expected/transport-errors.json`. **Ninguno descarta eventos**: el outbox reintenta con backoff `min(30·2^(n−1), 21600)` s y un JWT nuevo (jti nuevo) por intento. Los resultados se emparejan **por posición** y deben repetir el `eventId` de esa posición; si falta o no coincide, ese evento se reintenta (`MISSING_RESULT`). Vectores: `expected/classification-vectors.json`.

## 5. Outbox del SaaS (obligaciones)

1. Tabla nueva o existente del producto, **sin grants a `anon`/`authenticated`** (escritura solo de servidor).
2. Escritura en la misma transacción que la acción medida, o en el `finally` del pipeline IA (también en fallo, si el proveedor cobró).
3. `eventId` generado en origen; `status` (`PENDING`/`SENT`/`DEAD`), `attempts`, `next_attempt_at`, `sent_at`, `last_error_code`. El hecho medido es inmutable; solo cambian las columnas de entrega.
4. Tenant y producto atribuidos en origen: el `controlPlaneTenantId` sale del mapping de provisioning local (ACTIVE). Sin mapping → el evento queda `PENDING` con `last_error_code = TENANT_NOT_MAPPED` y no se envía (no se inventa tenant).
5. `DAILY_SNAPSHOT`: ninguna dimensión aprobada en v1 → no se emiten fotos diarias.
6. Compatibilidad: las cuotas locales por acción **no** se convierten en créditos. Mapear una acción a peso 1 requiere aprobación (D-03); hasta entonces el SaaS mantiene su cuota legacy y el evento lleva `quantity = 1` en `…ai.calls`, sin peso.

## 6. Archivos

| Archivo | Contenido |
| --- | --- |
| `request.schema.json` / `response.schema.json` | JSON Schema de la petición y de la respuesta `200` |
| `meters.json` | medidores v1 por producto (todos `is_billable=false` al registrarse, D-06) |
| `fixtures/setup.json` + `fixtures/ingest-batch.json` | lote dorado y el estado de MasterAdmin contra el que se evalúa |
| `expected/ingest-results.json` | resultado por evento esperado (verificado contra la RPC real por `scripts/ccp/usage-ingest-e2e.mts`) |
| `expected/transport-errors.json` | errores de lote y su código exacto |
| `expected/classification-vectors.json` | respuesta → `SENT`/`DEAD`/`RETRY` por evento + backoff |
| `reference-sender.ts` | validación en origen, `internalFromProvider`, lotes, firma ES256, clasificación, envío |
