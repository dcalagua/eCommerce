import type { Money, MoneyAmount, Quantity } from '../money'
import type { Provider, ProviderOperation } from './operations'

/**
 * `InvoicingProvider` — emitir el comprobante fiscal.
 *
 * Existe por la misma regla que los demás puertos de proveedor: la base ya
 * declara un implementador (`invoice.issue`, `invoice.read`) y la facturación
 * electrónica es, por definición, distinta en cada país y a menudo en cada
 * tenant. Omitirlo dejaría la única frontera regulada del sistema sin contrato.
 *
 * Lo que este contrato hace evidente, y que hoy no se puede cumplir: la línea
 * de factura necesita `taxRate` y `taxAmount` POR LÍNEA. `order_items` no los
 * guarda —solo quedan los totales del pedido—, así que un carrito con dos tipos
 * impositivos no puede reconstruir su comprobante desde la base. Es el hallazgo
 * de P00 y lo cierra P08; el puerto queda escrito de forma que no se pueda
 * implementar a medias sin que se note.
 */

export interface InvoiceLine {
  readonly description: string
  readonly quantity: Quantity
  readonly unitPrice: Money
  readonly netAmount: MoneyAmount
  /** Decimal en texto (`"0.18"`). Cero es una tasa válida, no un hueco. */
  readonly taxRate: MoneyAmount
  readonly taxAmount: MoneyAmount
}

export interface InvoiceRequest {
  readonly orderId: string
  /** Serie fiscal del tenant. Es configuración, nunca una constante del código. */
  readonly series: string
  readonly issuedAt: string
  readonly customerName: string
  readonly customerTaxId: string | null
  readonly lines: readonly InvoiceLine[]
  readonly netTotal: MoneyAmount
  readonly taxTotal: MoneyAmount
  readonly grossTotal: MoneyAmount
  readonly idempotencyKey: string
}

export type InvoiceStatus = 'issued' | 'accepted' | 'rejected' | 'cancelled' | 'pending'

export interface Invoice {
  readonly invoiceId: string
  readonly orderId: string
  readonly status: InvoiceStatus
  /** Número asignado por la autoridad o por el emisor autorizado. */
  readonly number: string | null
  /** Referencia al documento firmado. Ruta o URL, según el proveedor. */
  readonly documentRef: string | null
  readonly providerCode: string | null
}

export interface InvoicingProvider extends Provider {
  issue(request: InvoiceRequest): Promise<Invoice>
  read(invoiceId: string): Promise<Invoice | null>
}

export const INVOICING_OPERATIONS: readonly ProviderOperation[] = ['invoice.issue', 'invoice.read']
