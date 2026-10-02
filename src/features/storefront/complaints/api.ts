import { z } from 'zod'
import { codeFromDbError } from '@/shared/lib/appError'
import { tryGetStorefrontRpcClient } from '@/shared/lib/supabase'

/**
 * Libro de Reclamaciones · lo que el consumidor ENVÍA (2026-10-02).
 *
 * La hoja viaja a `submit_complaint`, que resuelve la tienda por el slug y
 * asigna el correlativo. Aquí no hay tenant: el servidor no lo aceptaría.
 */
export const COMPLAINT_KINDS = ['reclamo', 'queja'] as const
export const DOC_TYPES = ['dni', 'ce', 'pasaporte', 'ruc'] as const
export const ITEM_KINDS = ['producto', 'servicio'] as const

export interface ComplaintInput {
  readonly kind: (typeof COMPLAINT_KINDS)[number]
  readonly consumer_name: string
  readonly doc_type: (typeof DOC_TYPES)[number]
  readonly doc_number: string
  readonly consumer_email: string
  readonly consumer_phone?: string
  readonly consumer_address?: string
  readonly is_minor: boolean
  readonly guardian_name?: string
  readonly item_kind: (typeof ITEM_KINDS)[number]
  readonly item_description: string
  readonly amount?: number | null
  readonly order_reference?: string
  readonly detail: string
  readonly request: string
}

const receiptSchema = z.object({
  code: z.string().min(1),
  created_at: z.string(),
  kind: z.enum(COMPLAINT_KINDS),
})
export type ComplaintReceipt = z.infer<typeof receiptSchema>

export class ComplaintError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ComplaintError'
  }
}

/** Quita lo vacío: un campo opcional en blanco viaja como ausente, no como "". */
function limpia(input: ComplaintInput): Record<string, unknown> {
  const fuera: Record<string, unknown> = {}
  for (const [clave, valor] of Object.entries(input)) {
    if (valor === undefined || valor === null) continue
    if (typeof valor === 'string' && valor.trim() === '') continue
    fuera[clave] = typeof valor === 'string' ? valor.trim() : valor
  }
  if (!input.is_minor) delete fuera.guardian_name
  return fuera
}

export async function submitComplaint(storeSlug: string, input: ComplaintInput): Promise<ComplaintReceipt> {
  const client = tryGetStorefrontRpcClient()
  if (!client) throw new ComplaintError('SIN_BACKEND')
  const { data, error } = await client.rpc('submit_complaint', {
    p_store_slug: storeSlug,
    p_complaint: limpia(input),
  })
  if (error) {
    throw new ComplaintError(codeFromDbError(error))
  }
  return receiptSchema.parse(data)
}
