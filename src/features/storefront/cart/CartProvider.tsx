import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PublicProduct, PublicVariant } from '../types'
import {
  addToCart,
  applyServerLines,
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
import {
  clearCartToken,
  openServerCart,
  readCartToken,
  replaceServerCartLines,
  writeCartToken,
} from './serverCart'

/**
 * Estado del carrito de UNA tienda.
 *
 * El `storeId` no lo elige el carrito: viene del layout, que lo obtuvo de
 * `public_stores` resolviendo el slug de la URL. Si el comprador salta a otra
 * tienda, el provider se remonta con otro `storeId` y carga el carrito de ESA
 * tienda: los dos carritos coexisten en `localStorage` sin mezclarse nunca.
 *
 * ## La sincronización con el servidor (P07-SaaS)
 *
 * Dos efectos, y el orden entre ellos es la decisión:
 *
 *  1. **Reconciliar UNA vez** por tienda y por estado de sesión. Al abrir, se
 *     presenta el token del invitado; si hay sesión, el servidor FUSIONA ese
 *     carrito en el del usuario y devuelve el resultado, que es lo que pasa a
 *     verse. Iniciar sesión con dos dispositivos abiertos deja de perder el
 *     carrito de uno de los dos.
 *  2. **Empujar** lo local al servidor cuando cambia, con un retardo. No al
 *     revés: mientras el comprador está tocando el carrito, la verdad es lo que
 *     tiene delante, y una respuesta del servidor que llegara tarde le movería
 *     las cantidades bajo el dedo.
 *
 * **Todo esto es de mejor esfuerzo.** Ni una sola de estas llamadas puede
 * impedir comprar: si fallan, el comprador sigue con su `localStorage` y el
 * checkout sigue funcionando sin `cart_token` —lo único que se pierde es el
 * aviso de cambio de precio y la marca de carrito convertido—. Un carrito que
 * deja de funcionar porque una red falló es peor que un carrito sin servidor.
 *
 * ## Quién gana al reconciliar
 *
 * Sin sesión, **lo local**: es donde el invitado ha estado comprando ahora
 * mismo, y pisarlo con lo que el servidor recordaba de ayer sería quitarle de
 * la vista lo que acaba de añadir. Con sesión, **lo del servidor**, porque ya
 * incluye lo local (se acaba de fusionar) más lo del otro dispositivo.
 */
export function CartProvider({
  storeId,
  storeSlug,
  currency,
  authenticated = false,
  children,
}: {
  storeId: string
  /** Slug público de la URL. Es como el servidor resuelve la tienda. */
  storeSlug: string
  /** Moneda de la tienda: la usa el carrito vacío, que aún no tiene líneas. */
  currency: string
  /** Hay sesión de comprador. Decide qué cliente habla con la base y quién gana. */
  authenticated?: boolean
  children: ReactNode
}) {
  const [cart, setCart] = useState(() => readCart(storeId))
  const [isOpen, setOpen] = useState(false)
  const [cartToken, setCartToken] = useState<string | null>(() => readCartToken(storeId))
  const [synced, setSynced] = useState(false)

  // Cambió la tienda: se recarga su carrito. Sin esto, el carrito de la tienda
  // anterior seguiría en pantalla y sería justo la mezcla que hay que evitar.
  useEffect(() => {
    setCart(readCart(storeId))
    setCartToken(readCartToken(storeId))
    setSynced(false)
    setOpen(false)
  }, [storeId])

  useEffect(() => {
    if (cart.store_id === storeId) writeCart(cart)
  }, [cart, storeId])

  // --- 1 · Reconciliar (y fusionar, si se acaba de iniciar sesión) ----------
  const reconciled = useRef<string | null>(null)
  useEffect(() => {
    const scope = `${storeId}|${authenticated}`
    if (reconciled.current === scope) return
    reconciled.current = scope

    let cancelled = false
    openServerCart({ storeSlug, token: readCartToken(storeId), authenticated })
      .then((server) => {
        if (cancelled) return
        if (server.token) {
          writeCartToken(storeId, server.token)
          setCartToken(server.token)
        }
        setCart((current) => {
          if (current.store_id !== storeId) return current
          // Invitado con carrito en la mano: manda lo suyo.
          if (!authenticated && current.lines.length > 0) return current
          if (server.lines.length === 0) return current
          return applyServerLines(current, server.lines, currency)
        })
        setSynced(true)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // Queda dicho en consola y se sigue: el carrito local basta para comprar.
        console.error('[carrito] no se pudo sincronizar con el servidor', error)
        setSynced(true)
      })

    return () => {
      cancelled = true
    }
  }, [storeId, storeSlug, authenticated, currency])

  // --- 2 · Empujar lo local, con retardo ------------------------------------
  useEffect(() => {
    if (!synced || !cartToken) return
    if (cart.store_id !== storeId) return

    // El retardo evita una llamada por pulsación en el selector de cantidad.
    const handle = setTimeout(() => {
      replaceServerCartLines({ storeSlug, token: cartToken, cart, authenticated }).catch(
        (error: unknown) => {
          console.error('[carrito] no se pudo guardar en el servidor', error)
        },
      )
    }, 600)

    return () => clearTimeout(handle)
  }, [cart, cartToken, synced, storeSlug, storeId, authenticated])

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
    // El token también se retira: el carrito que ese secreto abría ya se
    // convirtió en pedido o se vació, y guardarlo solo serviría para reabrir
    // uno cerrado.
    clearCartToken(storeId)
    setCartToken(null)
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
      cartToken,
      synced,
      add,
      setQuantity,
      remove,
      clear,
      openCart: () => setOpen(true),
      closeCart: () => setOpen(false),
    }),
    [cart, currency, isOpen, cartToken, synced, add, setQuantity, remove, clear],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}
