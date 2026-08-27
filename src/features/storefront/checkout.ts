import { z } from 'zod'
import type { MessageKey } from '@/shared/i18n/messages'
import { codeFromInvokeError } from '@/shared/lib/edgeError'
import { moneyText } from '@/shared/lib/money'
import { tryGetStorefrontClient } from '@/shared/lib/supabase'
import { toOrderItems, type Cart } from './cart/cart'

export const CREATE_ORDER_FUNCTION = 'create-order'

/**
 * Checkout mínimo (P06).
 *
 * Cuatro datos obligatorios —nombre, correo, teléfono y dirección— y una
 * referencia opcional. No hay pasarela de pago todavía: el pedido nace en
 * `pending` y la tienda lo cobra por su canal.
 *
 * Lo que NO viaja en esta petición es tan importante como lo que viaja: ni
 * precios, ni subtotal, ni total, ni moneda, ni `store_id`, ni `organization_id`.
 * El servidor resuelve la tienda por el slug de la URL y vuelve a leer los
 * precios de la base. El carrito del navegador es una lista de deseos, no una
 * factura.
 */
export const checkoutSchema = z.object({
  customerName: z.string().trim().min(2, 'store.checkout.error.name').max(200, 'store.checkout.error.name'),
  customerEmail: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'store.checkout.error.email'),
  customerPhone: z
    .string()
    .trim()
    .min(6, 'store.checkout.error.phone')
    .max(40, 'store.checkout.error.phone'),
  address: z
    .string()
    .trim()
    .min(3, 'store.checkout.error.address')
    .max(300, 'store.checkout.error.address'),
  reference: z.string().trim().max(200, 'store.checkout.error.reference').optional(),
})
export type CheckoutValues = z.infer<typeof checkoutSchema>

/** Respuesta de `create-order`. Todo el dinero llega como texto decimal. */
export const orderResultSchema = z.object({
  order_id: z.string().uuid(),
  order_number: z.string().min(1),
  status: z.string().min(1),
  currency: z.string().length(3),
  subtotal: moneyText,
  tax_total: moneyText,
  grand_total: moneyText,
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        sku: z.string(),
        name: z.string(),
        unit_price: moneyText,
        quantity: z.union([z.number(), z.string()]).transform((value) => Number(value)),
      }),
    )
    .default([]),
})
export type OrderResult = z.infer<typeof orderResultSchema>

export class CheckoutError extends Error {
  readonly key: MessageKey
  readonly code: string

  constructor(key: MessageKey, code: string) {
    super(code)
    this.name = 'CheckoutError'
    this.key = key
    this.code = code
  }
}

/** Códigos de la Edge Function traducidos a algo que el comprador pueda hacer. */
export function mapCheckoutCode(code: string): MessageKey {
  switch (code) {
    case 'STOCK_INSUFICIENTE':
      return 'store.checkout.error.stock'
    case 'PRODUCTO_NO_DISPONIBLE':
      return 'store.checkout.error.product'
    case 'TIENDA_NO_DISPONIBLE':
      return 'store.checkout.error.store'
    case 'ITEMS_REQUERIDOS':
      return 'store.checkout.error.emptyCart'
    case 'MONEDA_INCONSISTENTE':
    case 'CAMPO_INVALIDO':
    case 'CAMPO_NO_PERMITIDO':
    case 'TENANT_NO_ADMITIDO':
    case 'CANTIDAD_INVALIDA':
      return 'store.checkout.error.invalid'
    default:
      return 'store.checkout.error.generic'
  }
}

export interface CreateOrderInput extends CheckoutValues {
  /** Slug de la URL pública. La tienda la resuelve el servidor a partir de él. */
  storeSlug: string
  cart: Cart
}

export async function createOrder(input: CreateOrderInput): Promise<OrderResult> {
  const supabase = tryGetStorefrontClient()
  if (!supabase) throw new CheckoutError('store.checkout.error.generic', 'CONFIG_INCOMPLETA')

  const items = toOrderItems(input.cart)
  if (items.length === 0) {
    throw new CheckoutError('store.checkout.error.emptyCart', 'ITEMS_REQUERIDOS')
  }

  const { data, error } = await supabase.functions.invoke<{ data: unknown }>(
    CREATE_ORDER_FUNCTION,
    {
      body: {
        store_slug: input.storeSlug,
        customer_name: input.customerName,
        customer_email: input.customerEmail,
        customer_phone: input.customerPhone,
        shipping_address: input.reference
          ? { address: input.address, reference: input.reference }
          : { address: input.address },
        items,
      },
    },
  )

  if (error) {
    const code = await codeFromInvokeError(error)
    throw new CheckoutError(mapCheckoutCode(code), code)
  }

  const parsed = orderResultSchema.safeParse(data?.data)
  if (!parsed.success) {
    throw new CheckoutError('store.checkout.error.generic', 'RESPUESTA_INVALIDA')
  }
  return parsed.data
}
