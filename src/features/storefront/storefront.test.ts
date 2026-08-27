import { describe, expect, it } from 'vitest'
import { sanitizeSearchTerm } from '@/shared/lib/search'
import { initials } from './branding'
import {
  discountPercent,
  pickRelated,
  publicProductSchema,
  publicStoreSchema,
  type PublicProduct,
} from './types'

function product(overrides: Partial<PublicProduct> = {}): PublicProduct {
  return publicProductSchema.parse({
    product_id: '11111111-1111-4111-8111-111111111111',
    store_id: '22222222-2222-4222-8222-222222222222',
    category_id: null,
    slug: 'silla',
    name: 'Silla',
    description: null,
    price: '100.00',
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

describe('importes de la vitrina', () => {
  it('el precio llega como TEXTO y se queda como texto', () => {
    expect(product({ price: '1890.00' }).price).toBe('1890.00')
  })

  it('un numeric que se coló como número no pierde los céntimos', () => {
    // Si PostgREST devolviera el `numeric` sin castear, el navegador ya lo
    // habría hecho float; al menos no se guarda así en la app.
    expect(product({ price: 19.9 as unknown as string }).price).toBe('19.90')
  })

  it('calcula el descuento solo cuando el precio tachado es mayor', () => {
    expect(discountPercent(product({ price: '389.00', compare_at_price: '450.00' }))).toBe(14)
    expect(discountPercent(product({ price: '450.00', compare_at_price: '450.00' }))).toBeNull()
    expect(discountPercent(product({ price: '500.00', compare_at_price: '450.00' }))).toBeNull()
    expect(discountPercent(product({ compare_at_price: null }))).toBeNull()
  })
})

describe('branding del tenant', () => {
  it('un accent_color que no es hex se descarta en vez de romper la vitrina', () => {
    const store = publicStoreSchema.parse({
      store_id: '33333333-3333-4333-8333-333333333333',
      slug: 'tienda',
      name: 'Tienda',
      currency: 'PEN',
      accent_color: 'javascript:alert(1)',
      logo_url: 'no-es-una-url',
      white_label: false,
      default_locale: 'es',
      support_email: null,
      banner_url: null,
      hero_title: null,
      hero_subtitle: null,
      contact_phone: null,
      contact_address: null,
    })
    expect(store.accent_color).toBeNull()
    expect(store.logo_url).toBeNull()
  })

  it('las iniciales cubren el hueco del logo sin inventar marca', () => {
    expect(initials('Casa Nórdica')).toBe('CN')
    expect(initials('Muebles')).toBe('M')
    expect(initials('  Taller  de  Madera ')).toBe('TM')
    expect(initials('   ')).toBe('?')
  })
})

describe('relacionados simples', () => {
  const P1 = 'aaaaaaa1-1111-4111-8111-111111111111'
  const P2 = 'aaaaaaa2-1111-4111-8111-111111111111'
  const P3 = 'aaaaaaa3-1111-4111-8111-111111111111'
  const P9 = 'aaaaaaa9-1111-4111-8111-111111111111'
  const CAT_A = 'ccccccc1-1111-4111-8111-111111111111'
  const CAT_B = 'ccccccc2-1111-4111-8111-111111111111'

  const actual = product({ product_id: P1, category_id: CAT_A })
  const catalogo = [
    actual,
    product({ product_id: P2, category_id: CAT_A, name: 'Misma categoria' }),
    product({ product_id: P3, category_id: CAT_B, name: 'Otra categoria' }),
  ]

  it('nunca se recomienda a sí mismo', () => {
    expect(pickRelated(catalogo, actual).map((p) => p.product_id)).not.toContain(P1)
  })

  it('prioriza la misma categoría y completa con el resto', () => {
    expect(pickRelated(catalogo, actual).map((p) => p.product_id)).toEqual([P2, P3])
  })

  it('respeta el límite pedido', () => {
    expect(pickRelated(catalogo, actual, 1)).toHaveLength(1)
  })

  it('un producto sin categoría se relaciona con lo que haya', () => {
    const suelto = product({ product_id: P9, category_id: null })
    expect(pickRelated([...catalogo, suelto], suelto).map((p) => p.product_id)).toEqual([
      P1,
      P2,
      P3,
    ])
  })
})

describe('buscador público', () => {
  it('desactiva la sintaxis del filtro de PostgREST', () => {
    // Una coma o un paréntesis en el `or=` no "no encuentran nada": cambian la
    // consulta. Es el campo más expuesto de la app: lo escribe cualquiera.
    expect(sanitizeSearchTerm('silla, mesa (roble)')).toBe('silla mesa roble')
    expect(sanitizeSearchTerm('%_*')).toBe('')
    expect(sanitizeSearchTerm('  lámpara   ópalo  ')).toBe('lámpara ópalo')
    expect(sanitizeSearchTerm('x'.repeat(200))).toHaveLength(80)
  })
})
