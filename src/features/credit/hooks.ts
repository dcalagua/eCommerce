import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  fetchAging,
  fetchArDocuments,
  fetchArReceipts,
  fetchInvoices,
  registerReceipt,
} from './api'
import type { Aging, ArDocument, ArReceipt, Invoice } from './types'

/**
 * Estado de crédito en el cliente.
 *
 * Un cobro invalida el árbol entero y no solo la lista de recibos: al aplicarlo,
 * un TRIGGER de la base recalcula el saldo de los documentos afectados. Una
 * invalidación quirúrgica dejaría la tabla de deuda enseñando el saldo de antes
 * del cobro que el usuario acaba de registrar, que es la forma más rápida de
 * que alguien lo registre dos veces.
 */
export const CREDIT_KEY = ['credit'] as const
export const documentsKey = (onlyOpen: boolean) =>
  [...CREDIT_KEY, 'documents', onlyOpen] as const
export const receiptsKey = () => [...CREDIT_KEY, 'receipts'] as const
export const agingKey = (customerId: string | null) =>
  [...CREDIT_KEY, 'aging', customerId ?? 'none'] as const
export const invoicesKey = () => [...CREDIT_KEY, 'invoices'] as const

export function useArDocuments(onlyOpen: boolean): UseQueryResult<ArDocument[]> {
  return useQuery({
    queryKey: documentsKey(onlyOpen),
    queryFn: () => fetchArDocuments({ onlyOpen }),
    retry: false,
  })
}

export function useArReceipts(): UseQueryResult<ArReceipt[]> {
  return useQuery({ queryKey: receiptsKey(), queryFn: fetchArReceipts, retry: false })
}

export function useAging(customerId: string | null): UseQueryResult<Aging | null> {
  return useQuery({
    queryKey: agingKey(customerId),
    queryFn: () => fetchAging(customerId),
    enabled: customerId !== null,
    retry: false,
  })
}

export function useInvoices(): UseQueryResult<Invoice[]> {
  return useQuery({ queryKey: invoicesKey(), queryFn: fetchInvoices, retry: false })
}

export function useRegisterReceipt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: registerReceipt,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CREDIT_KEY }),
  })
}
