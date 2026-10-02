import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { codeFromDbError } from '@/shared/lib/appError'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'

/**
 * Bandeja del Libro de Reclamaciones (2026-10-02).
 *
 * LEE por RLS (`complaints_select_member`: solo el tenant del JWT) y, además,
 * filtra por la sociedad activa y la tienda —regla del backoffice: ninguna
 * consulta sin filtro de tenant—. RESPONDE solo por `respond_complaint`, que
 * exige rol y deja rastro: no hay escritura directa en la tabla.
 */
export const complaintSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  kind: z.enum(['reclamo', 'queja']),
  status: z.enum(['received', 'in_progress', 'answered']),
  consumer_name: z.string(),
  doc_type: z.string(),
  doc_number: z.string(),
  consumer_email: z.string(),
  consumer_phone: z.string().nullable(),
  consumer_address: z.string().nullable(),
  is_minor: z.boolean(),
  guardian_name: z.string().nullable(),
  item_kind: z.string(),
  item_description: z.string(),
  amount: z.coerce.number().nullable(),
  order_reference: z.string().nullable(),
  detail: z.string(),
  request: z.string(),
  response: z.string().nullable(),
  responded_at: z.string().nullable(),
  created_at: z.string(),
})
export type Complaint = z.infer<typeof complaintSchema>

const COLUMNS =
  'id, code, kind, status, consumer_name, doc_type, doc_number, consumer_email, consumer_phone, consumer_address, is_minor, guardian_name, item_kind, item_description, amount, order_reference, detail, request, response, responded_at, created_at'

const key = (companyId: string | null, storeId: string | null) => ['admin', 'complaints', companyId, storeId] as const

export function useComplaints(companyId: string | null, storeId: string | null) {
  return useQuery({
    queryKey: key(companyId, storeId),
    enabled: Boolean(companyId && storeId),
    queryFn: async (): Promise<Complaint[]> => {
      const client = tryGetSupabaseClient()
      if (!client || !companyId || !storeId) return []
      const { data, error } = await client
        .from('complaints')
        .select(COLUMNS)
        .eq('company_id', companyId)
        .eq('store_id', storeId)
        .order('created_at', { ascending: false })
        .limit(500)
      if (error) throw error
      return z.array(complaintSchema).parse(data ?? [])
    },
  })
}

export function useRespondComplaint(companyId: string | null, storeId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; status: 'in_progress' | 'answered'; response?: string }) => {
      const client = tryGetSupabaseClient()
      if (!client) throw new Error('SIN_BACKEND')
      const { error } = await client.rpc('respond_complaint', {
        p_complaint_id: input.id,
        p_status: input.status,
        p_response: input.response ?? undefined,
      })
      if (error) throw new Error(codeFromDbError(error))
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(companyId, storeId) }),
  })
}

/** Días hábiles (lunes a viernes) desde el registro: el plazo legal es 15. */
export function businessDaysSince(iso: string, now: Date = new Date()): number {
  const desde = new Date(iso)
  let dias = 0
  const d = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate())
  const fin = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  while (d < fin) {
    d.setDate(d.getDate() + 1)
    const w = d.getDay()
    if (w !== 0 && w !== 6) dias += 1
  }
  return dias
}
