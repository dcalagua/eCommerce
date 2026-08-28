import type { Money, Quantity } from '../money'
import type { Provider, ProviderOperation } from './operations'

/**
 * `ErpProvider` — leer maestros y empujar pedidos al sistema de gestión.
 *
 * Esta es la frontera que decide si el producto se puede vender a una empresa
 * grande sin escribir código a medida, y por eso su forma importa más que la de
 * ninguna otra. La base ya declara dos implementadores con el MISMO juego de
 * operaciones (`customer.read`, `product.read`, `price.read`, `stock.read`,
 * `order.create`, `order.read`, `invoice.create`): dos generaciones del mismo
 * ERP hablan igual desde aquí, y esa es literalmente la respuesta a «preparado
 * para migrar sin reimplementar».
 *
 * **Ningún nombre de fabricante, transacción, módulo o función remota aparece
 * en este archivo.** El dominio dice `order.create`; qué llamada concreta es
 * eso en cada versión lo sabe el adaptador y nadie más.
 * `src/architecture.test.ts` verifica que sigue siendo cierto para todo `src/`.
 *
 * Dos decisiones de forma:
 *
 *  1. **Todo va por `externalId`.** El ERP tiene sus propias claves y no las va
 *     a cambiar por nosotros. Guardar la correspondencia es trabajo del
 *     adaptador; el dominio pide por su identificador y recibe el ajeno.
 *  2. **`pushOrder` es idempotente por clave.** Un pedido duplicado en el ERP
 *     es una factura duplicada y una devolución.
 */

export interface ErpCustomer {
  readonly externalId: string
  readonly name: string
  readonly taxId: string | null
  readonly creditLimit: Money | null
  readonly isBlocked: boolean
}

export interface ErpProduct {
  readonly externalId: string
  readonly sku: string
  readonly name: string
  /** Unidad de medida base del ERP. La UoM propia llega en P03. */
  readonly unitOfMeasure: string
  readonly isActive: boolean
}

export interface ErpPrice {
  readonly externalId: string
  readonly unitPrice: Money
  readonly validFrom: string | null
  readonly validTo: string | null
}

export interface ErpStock {
  readonly externalId: string
  readonly warehouseCode: string
  readonly availableQuantity: Quantity
}

export interface ErpOrderLine {
  readonly productExternalId: string
  readonly quantity: Quantity
  readonly unitPrice: Money
}

export interface ErpOrderRequest {
  readonly orderId: string
  readonly customerExternalId: string
  readonly lines: readonly ErpOrderLine[]
  readonly idempotencyKey: string
}

export interface ErpOrderRef {
  readonly orderId: string
  readonly externalId: string
  readonly status: string
}

export interface ErpProvider extends Provider {
  readCustomer(externalId: string): Promise<ErpCustomer | null>
  readProducts(externalIds: readonly string[]): Promise<readonly ErpProduct[]>
  readPrices(externalIds: readonly string[]): Promise<readonly ErpPrice[]>
  readStock(externalIds: readonly string[]): Promise<readonly ErpStock[]>
  pushOrder(request: ErpOrderRequest): Promise<ErpOrderRef>
  readOrder(externalId: string): Promise<ErpOrderRef | null>
}

export const ERP_OPERATIONS: readonly ProviderOperation[] = [
  'customer.read',
  'product.read',
  'price.read',
  'stock.read',
  'order.create',
  'order.read',
  'invoice.create',
]
