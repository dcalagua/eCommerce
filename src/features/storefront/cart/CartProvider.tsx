import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PublicProduct, PublicVariant } from '../types'
import {
  addToCart,
  cartCount,
  cartCurrency,
  cartSubtotal,
  clearStoredCart,
  emptyCart,
  readCart,
  removeFromCart,
  setLineQuantity,
  writeCart,
  CartStoreMismatchError,
  CartVariantMismatchError,
} from './cart'
import { CartContext, type CartApi } from './cart-context'

/**
 * Estado del carrito de UNA tienda.
 *
 * El `storeId` no lo elige el carrito: viene del layout, que lo obtuvo de
 * `public_stores` resolviendo el slug de la URL. Si el comprador salta a otra
 * tienda, el provider se remonta con otro `storeId` y carga el carrito de ESA
 * tienda: los dos carritos coexisten en `localStorage` sin mezclarse nunca.
 */
export function CartProvider({
  storeId,
  currency,
  children,
}: {
  storeId: string
  /** Moneda de la tienda: la usa el carrito vacío, que aún no tiene líneas. */
  currency: string
  children: ReactNode
}) {
  const [cart, setCart] = useState(() => readCart(storeId))
  const [isOpen, setOpen] = useState(false)

  // Cambió la tienda: se recarga su carrito. Sin esto, el carrito de la tienda
  // anterior seguiría en pantalla y sería justo la mezcla que hay que evitar.
  useEffect(() => {
    setCart(readCart(storeId))
    setOpen(false)
  }, [storeId])

  useEffect(() => {
    if (cart.store_id === storeId) writeCart(cart)
  }, [cart, storeId])

  const add = useCallback(
    (product: PublicProduct, quantity = 1, variant: PublicVariant | null = null) => {
      setCart((current) => {
        try {
          return addToCart(current, product, quantity, variant)
        } catch (error) {
          // Producto de otra tienda o variante que no es de ese producto: se
          // ignora en vez de tumbar la vitrina, pero queda dicho en consola
          // porque significa que algo está mal arriba.
          if (error instanceof CartStoreMismatchError || error instanceof CartVariantMismatchError) {
            console.error('[carrito] línea descartada', error)
            return current
          }
          throw error
        }
      })
      setOpen(true)
    },
    [],
  )

  const setQuantity = useCallback(
    (productId: string, quantity: number, variantId: string | null = null) => {
      setCart((current) => setLineQuantity(current, productId, quantity, variantId))
    },
    [],
  )

  const remove = useCallback((productId: string, variantId: string | null = null) => {
    setCart((current) => removeFromCart(current, productId, variantId))
  }, [])

  const clear = useCallback(() => {
    clearStoredCart(storeId)
    setCart(emptyCart(storeId))
    setOpen(false)
  }, [storeId])

  const value = useMemo<CartApi>(
    () => ({
      cart,
      count: cartCount(cart),
      subtotal: cartSubtotal(cart),
      currency: cartCurrency(cart, currency),
      isOpen,
      add,
      setQuantity,
      remove,
      clear,
      openCart: () => setOpen(true),
      closeCart: () => setOpen(false),
    }),
    [cart, currency, isOpen, add, setQuantity, remove, clear],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}
