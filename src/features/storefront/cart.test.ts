import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_LINE_QUANTITY,
  addToCart,
  cartCount,
  cartStorageKey,
  cartSubtotal,
  CartStoreMismatchError,
  CartVariantMismatchError,
  emptyCart,
  parseCart,
  readCart,
  removeFromCart,
  setLineQuantity,
  toOrderItems,
  writeCart,
} from './cart/cart'
import {
  publicProductSchema,
  publicVariantSchema,
  type PublicProduct,
  type PublicVariant,
} from './types'

/**
 * Reglas del carrito, sin React de por medio.
 *
 * Lo que se defiende aquí es lo del encargo: cantidades y subtotal correctos,
 * un carrito por tienda en `localStorage`, y la imposibilidad de mezclar dos
 * tiendas en el mismo pedido.
 */

const STORE_A = 'aaaa1111-1111-4111-8111-111111111111'
const STORE_B = 'aaaa2222-1111-4111-8111-111111111111'
const SILLA = 'cccc1111-1111-4111-8111-111111111111'
const MESA = 'cccc2222-1111-4111-8111-111111111111'

function product(overrides: Partial<PublicProduct> = {}): PublicProduct {
  return publicProductSchema.parse({
    product_id: SILLA,
    store_id: STORE_A,
    category_id: null,
    slug: 'silla-roble',
    name: 'Silla de roble',
    description: null,
    price: '389.90',
    compare_at_price: null,
    currency: 'PEN',
    published_at: '2026-08-01T00:00:00.000Z',
    in_stock: true,
    category_slug: null,
    category_name: null,
    primary_image_path: null,
    primary_image_alt: null,
    ...overrides,
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('cantidades', () => {
  it('agregar dos veces el mismo producto suma en una sola línea', () => {
    let cart = addToCart(emptyCart(STORE_A), product(), 1)
    cart = addToCart(cart, product(), 2)

    expect(cart.lines).toHaveLength(1)
    expect(cart.lines[0]?.quantity).toBe(3)
    expect(cartCount(cart)).toBe(3)
  })

  it('la cantidad se puede fijar y la línea desaparece al llegar a cero', () => {
    let cart = addToCart(emptyCart(STORE_A), product(), 5)
    cart = setLineQuantity(cart, SILLA, 2)
    expect(cart.lines[0]?.quantity).toBe(2)

    cart = setLineQuantity(cart, SILLA, 0)
    expect(cart.lines).toHaveLength(0)
  })

  it('quitar deja el resto del carrito intacto', () => {
    let cart = addToCart(emptyCart(STORE_A), product(), 1)
    cart = addToCart(cart, product({ product_id: MESA, slug: 'mesa', name: 'Mesa', price: '100.00' }), 1)

    cart = removeFromCart(cart, SILLA)
    expect(cart.lines.map((line) => line.product_id)).toEqual([MESA])
  })

  it('no se pasa del tope por línea ni acepta cantidades absurdas', () => {
    const cart = addToCart(emptyCart(STORE_A), product(), 5_000)
    expect(cart.lines[0]?.quantity).toBe(MAX_LINE_QUANTITY)

    expect(setLineQuantity(cart, SILLA, Number.NaN).lines).toHaveLength(0)
    expect(setLineQuantity(cart, SILLA, -3).lines).toHaveLength(0)
    expect(addToCart(emptyCart(STORE_A), product(), 2.7).lines[0]?.quantity).toBe(2)
  })
})

describe('subtotal', () => {
  it('suma en céntimos: los decimales no derivan', () => {
    // 0.1 + 0.2 en float da 0.30000000000000004. En céntimos, no.
    let cart = addToCart(emptyCart(STORE_A), product({ price: '0.10' }), 1)
    cart = addToCart(cart, product({ product_id: MESA, slug: 'mesa', name: 'Mesa', price: '0.20' }), 1)

    expect(cartSubtotal(cart)).toBe('0.30')
  })

  it('multiplica precio por cantidad con dos decimales exactos', () => {
    const cart = addToCart(emptyCart(STORE_A), product({ price: '389.90' }), 3)
    expect(cartSubtotal(cart)).toBe('1169.70')
  })

  it('un carrito vacío vale cero, no `NaN`', () => {
    expect(cartSubtotal(emptyCart(STORE_A))).toBe('0.00')
  })
})

describe('el carrito no cruza tiendas', () => {
  it('un producto de otra tienda no entra', () => {
    const cart = emptyCart(STORE_A)
    expect(() => addToCart(cart, product({ store_id: STORE_B }), 1)).toThrow(CartStoreMismatchError)
  })

  it('cada tienda guarda su carrito en su propia clave', () => {
    writeCart(addToCart(emptyCart(STORE_A), product(), 2))
    writeCart(addToCart(emptyCart(STORE_B), product({ store_id: STORE_B, product_id: MESA }), 1))

    expect(cartCount(readCart(STORE_A))).toBe(2)
    expect(cartCount(readCart(STORE_B))).toBe(1)
    expect(localStorage.getItem(cartStorageKey(STORE_A))).not.toBeNull()
    expect(localStorage.getItem(cartStorageKey(STORE_B))).not.toBeNull()
  })

  it('un carrito guardado bajo la clave de otra tienda se descarta', () => {
    // Escenario real: alguien copia el valor de una clave a otra a mano.
    const ajeno = JSON.stringify(addToCart(emptyCart(STORE_B), product({ store_id: STORE_B }), 1))
    localStorage.setItem(cartStorageKey(STORE_A), ajeno)

    expect(readCart(STORE_A).lines).toHaveLength(0)
  })
})

describe('lo que se lee de localStorage no es de fiar', () => {
  it('un JSON roto no rompe la vitrina', () => {
    expect(parseCart(STORE_A, '{no es json')).toEqual(emptyCart(STORE_A))
    expect(parseCart(STORE_A, null)).toEqual(emptyCart(STORE_A))
  })

  it('una línea manipulada invalida el carrito entero en vez de colarse', () => {
    const manipulado = JSON.stringify({
      store_id: STORE_A,
      lines: [{ product_id: 'no-es-uuid', slug: 'x', name: 'x', unit_price: '1.00', currency: 'PEN', image_path: null, quantity: 1 }],
    })
    expect(parseCart(STORE_A, manipulado).lines).toHaveLength(0)
  })

  it('vaciar el carrito borra la clave, no deja un carrito vacío guardado', () => {
    writeCart(addToCart(emptyCart(STORE_A), product(), 1))
    writeCart(emptyCart(STORE_A))
    expect(localStorage.getItem(cartStorageKey(STORE_A))).toBeNull()
  })
})

describe('lo que viaja al servidor', () => {
  it('solo product_id y quantity: ni precio, ni moneda, ni total', () => {
    let cart = addToCart(emptyCart(STORE_A), product({ price: '0.01' }), 2)
    cart = addToCart(cart, product({ product_id: MESA, slug: 'mesa', name: 'Mesa' }), 1)

    const items = toOrderItems(cart)
    expect(items).toEqual([
      { product_id: SILLA, quantity: 2 },
      { product_id: MESA, quantity: 1 },
    ])
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['product_id', 'quantity'])
    }
  })
})

/**
 * Variantes en el carrito (P03-SaaS).
 *
 * La identidad de una línea deja de ser el producto y pasa a ser el producto MÁS
 * la variante. Es el cambio que impide el fallo más caro del PIM en una vitrina:
 * agrupar la talla M con la L en una sola línea y despachar la que no era.
 */
const VARIANTE_M = 'dddd1111-1111-4111-8111-111111111111'
const VARIANTE_L = 'dddd2222-1111-4111-8111-111111111111'

function variant(overrides: Partial<PublicVariant> = {}): PublicVariant {
  return publicVariantSchema.parse({
    variant_id: VARIANTE_M,
    product_id: SILLA,
    store_id: STORE_A,
    name: 'Talla M',
    position: 0,
    is_default: true,
    in_stock: true,
    price: '389.90',
    compare_at_price: null,
    currency: 'PEN',
    ...overrides,
  })
}

describe('variantes en el carrito', () => {
  it('dos variantes del mismo producto son dos líneas', () => {
    const base = product({ kind: 'variant' })
    let cart = addToCart(emptyCart(STORE_A), base, 1, variant())
    cart = addToCart(cart, base, 2, variant({ variant_id: VARIANTE_L, name: 'Talla L' }))

    expect(cart.lines).toHaveLength(2)
    expect(cart.lines.map((line) => line.variant_name)).toEqual(['Talla M', 'Talla L'])
    expect(cartCount(cart)).toBe(3)
  })

  it('la misma variante repetida sí suma en una línea', () => {
    const base = product({ kind: 'variant' })
    let cart = addToCart(emptyCart(STORE_A), base, 1, variant())
    cart = addToCart(cart, base, 2, variant())

    expect(cart.lines).toHaveLength(1)
    expect(cart.lines[0]?.quantity).toBe(3)
  })

  it('el precio de la línea es el de la variante, no el del maestro', () => {
    const base = product({ kind: 'variant', price: '389.90' })
    const cart = addToCart(emptyCart(STORE_A), base, 1, variant({ price: '429.00' }))
    expect(cart.lines[0]?.unit_price).toBe('429.00')
  })

  it('cambiar la cantidad de una variante no toca la otra', () => {
    const base = product({ kind: 'variant' })
    let cart = addToCart(emptyCart(STORE_A), base, 2, variant())
    cart = addToCart(cart, base, 2, variant({ variant_id: VARIANTE_L, name: 'Talla L' }))

    cart = setLineQuantity(cart, SILLA, 5, VARIANTE_M)
    expect(cart.lines.map((line) => line.quantity)).toEqual([5, 2])

    cart = removeFromCart(cart, SILLA, VARIANTE_L)
    expect(cart.lines).toHaveLength(1)
    expect(cart.lines[0]?.variant_id).toBe(VARIANTE_M)
  })

  it('quitar sin decir la variante no borra una línea con variante', () => {
    // Es deliberado: `removeFromCart(cart, id)` significa "la línea SIN
    // variante de ese producto". Si borrase la primera que encuentre, el botón
    // de una línea quitaría la de al lado.
    const base = product({ kind: 'variant' })
    const cart = addToCart(emptyCart(STORE_A), base, 1, variant())
    expect(removeFromCart(cart, SILLA).lines).toHaveLength(1)
  })

  it('una variante de OTRO producto no entra en el carrito', () => {
    const base = product({ kind: 'variant' })
    expect(() =>
      addToCart(emptyCart(STORE_A), base, 1, variant({ product_id: MESA })),
    ).toThrow(CartVariantMismatchError)
  })

  it('al servidor viaja `variant_id`, y solo cuando la línea tiene variante', () => {
    const base = product({ kind: 'variant' })
    let cart = addToCart(emptyCart(STORE_A), base, 1, variant())
    cart = addToCart(cart, product({ product_id: MESA, slug: 'mesa', name: 'Mesa' }), 1)

    expect(toOrderItems(cart)).toEqual([
      { product_id: SILLA, quantity: 1, variant_id: VARIANTE_M },
      { product_id: MESA, quantity: 1 },
    ])
  })

  it('un carrito guardado antes del PIM se sigue leyendo, sin variante', () => {
    // Compatibilidad: `localStorage` puede tener líneas de ayer. La línea sin
    // `variant_id` es exactamente el producto simple que era.
    const legacy = JSON.stringify({
      store_id: STORE_A,
      lines: [
        {
          product_id: SILLA,
          slug: 'silla-roble',
          name: 'Silla de roble',
          unit_price: '389.90',
          currency: 'PEN',
          image_path: null,
          quantity: 2,
        },
      ],
    })
    const cart = parseCart(STORE_A, legacy)
    expect(cart.lines).toHaveLength(1)
    expect(cart.lines[0]?.variant_id).toBeNull()
    expect(toOrderItems(cart)).toEqual([{ product_id: SILLA, quantity: 2 }])
  })
})
