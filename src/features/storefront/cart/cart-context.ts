import { createContext, useContext } from 'react'
import type { PublicProduct, PublicVariant } from '../types'
import type { Cart } from './cart'

/**
 * Contexto del carrito, separado del provider a propósito: un archivo que
 * exporta a la vez un componente y un valor rompe el Fast Refresh de Vite
 * (misma razón que en `feedback-context.ts`).
 */
export interface CartApi {
  cart: Cart
  /** Unidades totales, para el contador de la cabecera. */
  count: number
  /** Subtotal informativo como texto decimal. El de cobro lo calcula la base. */
  subtotal: string
  currency: string
  isOpen: boolean
  /**
   * `variant` es opcional y `null` para el producto simple. La identidad de una
   * línea es producto MÁS variante desde P03: sin ella, la talla M y la L
   * acabarían en la misma línea.
   */
  add: (product: PublicProduct, quantity?: number, variant?: PublicVariant | null) => void
  setQuantity: (productId: string, quantity: number, variantId?: string | null) => void
  remove: (productId: string, variantId?: string | null) => void
  clear: () => void
  openCart: () => void
  closeCart: () => void
}

export const CartContext = createContext<CartApi | null>(null)

export function useCart(): CartApi {
  const value = useContext(CartContext)
  if (!value) throw new Error('useCart requiere <CartProvider> (vive en el layout de la vitrina)')
  return value
}
