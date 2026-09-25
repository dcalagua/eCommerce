import { z } from 'zod'
import { parseAiResult, type AiResult } from '@/features/ai/result'
import type { MessageKey } from '@/shared/i18n/messages'
import { UiError } from '@/shared/lib/appError'
import {
  WATCH_ASSISTANT_FUNCTION,
  WATCH_DISMISS_RPC,
  WATCH_FINDINGS_RPC,
  WATCH_RESTORE_RPC,
} from '@/shared/lib/db-schema'
import { codeFromInvokeError } from '@/shared/lib/edgeError'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'

/**
 * Centro de vigilancia en el CLIENTE.
 *
 * Aquí no se decide NADA: `public.watch_findings` calcula los hallazgos con el
 * JWT de quien mira (rol, módulo contratado y RLS), y esta capa solo los valida
 * y los pinta. Los títulos son del diccionario, no de la base: lo que viaja es
 * un `key` estable y unas cifras, para que el mismo aviso se lea en español y
 * en inglés sin que la base sepa de idiomas.
 */

export const WATCH_SEVERITIES = ['critica', 'advertencia'] as const
export type WatchSeverity = (typeof WATCH_SEVERITIES)[number]

/** Los avisos que la pantalla sabe explicar. Uno que no esté aquí se ignora. */
export const WATCH_KEYS = [
  'orders.unpaid',
  'orders.paid_unshipped',
  'orders.awaiting_approval',
  'inventory.negative',
  'inventory.below_reorder',
  'fulfillment.overdue',
  'fulfillment.failed',
  'credit.overdue',
  'catalog.unpublished',
  'integrations.circuit_open',
  'ops.critical_events',
] as const
export type WatchKey = (typeof WATCH_KEYS)[number]

const sampleSchema = z.object({
  label: z.string(),
  days: z.number().int().optional(),
  qty: z.string().optional(),
})

const findingSchema = z.object({
  key: z.enum(WATCH_KEYS),
  module: z.string(),
  severity: z.enum(WATCH_SEVERITIES),
  count: z.number().int(),
  fingerprint: z.string(),
  metrics: z.record(z.union([z.number(), z.string()])).default({}),
  samples: z.array(sampleSchema).default([]),
  href: z.string(),
})

const watchSchema = z.object({
  generated_at: z.string(),
  critical: z.number().int(),
  total: z.number().int(),
  // Un aviso que esta versión no conoce se descarta en vez de romper el panel:
  // la base puede aprender a vigilar algo nuevo antes de que se despliegue el
  // front que lo sabe explicar.
  items: z.array(z.unknown()).transform((rows) => rows.flatMap((row) => {
    const parsed = findingSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })),
  dismissed: z.array(z.unknown()).transform((rows) => rows.flatMap((row) => {
    const parsed = findingSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })),
})

export type WatchFinding = z.infer<typeof findingSchema>
export type WatchResult = z.infer<typeof watchSchema>

/** La pantalla nunca ve el `message` de Postgres: lleva nombres de tabla. */
export class WatchError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'ai', key, code })
    this.name = 'WatchError'
  }
}

function client() {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new WatchError('auth.notConfigured', 'CONFIG_INCOMPLETA')
  return supabase
}

export async function fetchWatchFindings(storeId: string | null): Promise<WatchResult> {
  const { data, error } = await client().rpc(WATCH_FINDINGS_RPC, { p_store_id: storeId })
  if (error) throw new WatchError('watch.error', error.code ?? 'ERROR_INTERNO')
  return watchSchema.parse(data)
}

export async function dismissWatchFinding(input: {
  key: WatchKey
  fingerprint: string
  storeId: string | null
}): Promise<void> {
  const { error } = await client().rpc(WATCH_DISMISS_RPC, {
    p_key: input.key,
    p_fingerprint: input.fingerprint,
    p_store_id: input.storeId,
  })
  if (error) throw new WatchError('watch.dismissError', error.code ?? 'ERROR_INTERNO')
}

export async function restoreWatchFinding(input: {
  key: WatchKey
  storeId: string | null
}): Promise<void> {
  const { error } = await client().rpc(WATCH_RESTORE_RPC, {
    p_key: input.key,
    p_store_id: input.storeId,
  })
  if (error) throw new WatchError('watch.restoreError', error.code ?? 'ERROR_INTERNO')
}

// ---------------------------------------------------------------------------
// «Ejecutar análisis»: la IA solo ORDENA y explica lo que la base encontró
// ---------------------------------------------------------------------------

const analysisSchema = z.object({
  headline: z.string().min(1).max(200),
  order: z.array(z.string().max(60)).min(1).max(20),
  reasons: z.array(z.object({ key: z.string().max(60), why: z.string().min(1).max(200) })).max(20),
})

export type WatchAnalysis = z.infer<typeof analysisSchema>

/**
 * No lanza cuando no hay análisis: la ausencia viene con su motivo tipado (sin
 * contratar, sin cuota, proveedor caído). El panel determinista se queda como
 * estaba, que es justo lo que tiene que pasar.
 */
export async function analyzeWatch(input: {
  storeId: string | null
  locale: 'es' | 'en'
}): Promise<AiResult<WatchAnalysis>> {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new WatchError('auth.notConfigured', 'CONFIG_INCOMPLETA')
  const { data, error } = await supabase.functions.invoke<{ data: unknown }>(WATCH_ASSISTANT_FUNCTION, {
    body: { store_id: input.storeId, locale: input.locale },
  })
  if (error) throw new WatchError('watch.error', await codeFromInvokeError(error))
  return parseAiResult(analysisSchema, data?.data)
}
