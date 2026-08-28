import type { CurrencyCode, Money, MoneyAmount, Quantity } from '../money'

/**
 * `PricingPort` — cuánto cuesta una línea ANTES de promociones.
 *
 * Por qué existe la frontera: hoy el precio es `products.price`, una columna
 * escalar del producto, y quien la aplica de verdad es `create_order` en la
 * base. Mañana hay dos implementadores más, y los dos están ya declarados:
 * P04 trae listas de precio por canal, segmento, cantidad y vigencia, y
 * `integration_providers` declara `price.read` para los dos adaptadores de ERP
 * —un tenant que tarifica en su sistema de gestión quiere ese precio, no una
 * copia que se desincroniza—. Tres implementaciones de la misma pregunta son
 * una frontera, no una capa de más.
 *
 * Tres reglas que este contrato fija ahora para no tener que discutirlas en P04:
 *
 *  1. **Devuelve el desglose, no un total.** Un total sin `unitPrice`,
 *     `taxRate` y `taxAmount` por línea no puede reconstruir una factura, y ese
 *     es exactamente el hueco que la auditoría de P00 encontró en `order_items`.
 *  2. **No aplica descuentos.** Promociones son una capa posterior (P10) que
 *     recibe este resultado. Mezclarlas produce un motor que nadie puede
 *     explicar cuando un precio sale mal.
 *  3. **No recibe el tenant.** Ni aquí ni en ningún otro puerto: la
 *     organización y la sociedad salen del JWT en el servidor. Un parámetro que
 *     se puede pasar se puede pasar mal.
 */

export interface PriceRequest {
  readonly productId: string
  readonly quantity: Quantity
  /** Moneda en la que se pide la cotización. La resuelve la tienda, no el comprador. */
  readonly currency: CurrencyCode
}

export interface PricedLine {
  readonly productId: string
  readonly quantity: Quantity
  /** Precio unitario vigente, sin impuesto. */
  readonly unitPrice: Money
  /** Precio de referencia tachado, si lo hay. */
  readonly compareAtPrice: Money | null
  /** Base imponible de la línea: `unitPrice * quantity`. */
  readonly netAmount: MoneyAmount
  /** Tasa aplicada, como decimal en texto (`"0.18"`). Cero es una tasa válida. */
  readonly taxRate: MoneyAmount
  readonly taxAmount: MoneyAmount
  /** `netAmount + taxAmount`. Se devuelve calculado para no repetir el redondeo. */
  readonly grossAmount: MoneyAmount
  /**
   * De dónde salió el precio. No es decorativo: cuando un comercio reclama por
   * un importe, la primera pregunta es si lo puso la lista o el ERP.
   */
  readonly source: 'catalog' | 'price_list' | 'erp'
}

export interface PriceQuote {
  readonly currency: CurrencyCode
  readonly lines: readonly PricedLine[]
  readonly netTotal: MoneyAmount
  readonly taxTotal: MoneyAmount
  readonly grossTotal: MoneyAmount
}

export interface PricingPort {
  /**
   * Cotiza el conjunto de líneas de una vez.
   *
   * En lote y no línea a línea a propósito: una lista con escalado por cantidad
   * o un ERP con precio de pedido completo no pueden responder correctamente si
   * solo ven una línea, y N llamadas a un ERP por un carrito de N artículos es
   * la forma más rápida de agotar su cupo de sesiones.
   */
  quote(request: readonly PriceRequest[]): Promise<PriceQuote>
}
