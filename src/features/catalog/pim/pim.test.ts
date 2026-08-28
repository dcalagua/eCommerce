/**
 * Reglas del PIM que no dependen de React ni de Supabase (P03-SaaS).
 *
 * Todas tienen su gemela en la base —la herencia de precio está en
 * `public_product_variants`, la conversión a unidades base en `create_order`—
 * y la copia del cliente existe para PINTAR, no para decidir. Que las dos digan
 * lo mismo importa igual: un listado que muestra 60.00 y un pedido que cobra
 * 69.90 es la clase de discrepancia por la que se abren incidencias que nadie
 * sabe reproducir.
 */
import { describe, expect, it } from 'vitest'
import {
  assemblableUnits,
  attributeFormSchema,
  baseUnitsFor,
  bundleItemFormSchema,
  effectiveUomPrice,
  effectiveVariantPrice,
  productUomFormSchema,
  suggestVariantName,
  suggestVariantSku,
  unitFormSchema,
  variantFormSchema,
} from './types'

const PRODUCT = '66666666-6666-4666-8666-666666666666'

describe('herencia de precio de la variante', () => {
  it('sin precio propio hereda el del maestro', () => {
    expect(effectiveVariantPrice({ price: null }, '60.00')).toBe('60.00')
  })

  it('con precio propio manda el suyo, aunque sea menor', () => {
    expect(effectiveVariantPrice({ price: '49.90' }, '60.00')).toBe('49.90')
  })

  it('cero es un precio, no "sin precio"', () => {
    // La distinción es la razón por la que la columna es nullable en vez de
    // usar 0 como centinela: un producto de regalo cuesta 0 de verdad.
    expect(effectiveVariantPrice({ price: '0.00' }, '60.00')).toBe('0.00')
  })
})

describe('precio de la unidad de venta', () => {
  it('sin precio propio es el base por el factor', () => {
    expect(effectiveUomPrice({ price: null, factor: '12' }, '10.00')).toBe('120.00')
  })

  it('con precio propio manda el suyo: la caja no siempre es proporcional', () => {
    expect(effectiveUomPrice({ price: '100.00', factor: '12' }, '10.00')).toBe('100.00')
  })

  it('el céntimo no se pierde en el float', () => {
    // 0.1 * 3 en coma flotante es 0.30000000000000004. En céntimos enteros, no.
    expect(effectiveUomPrice({ price: null, factor: '3' }, '0.10')).toBe('0.30')
    expect(effectiveUomPrice({ price: null, factor: '7' }, '19.99')).toBe('139.93')
  })

  it('un factor con decimales redondea al céntimo, no al azar', () => {
    expect(effectiveUomPrice({ price: null, factor: '0.5' }, '19.99')).toBe('10.00')
  })
})

describe('conversión a unidades base', () => {
  it('dos cajas de doce son veinticuatro unidades', () => {
    expect(baseUnitsFor(2, '12')).toBe(24)
  })

  it('una media unidad NO es convertible: `stock` es entero', () => {
    expect(baseUnitsFor(1, '0.5')).toBeNull()
  })

  it('dos medias unidades sí lo son', () => {
    expect(baseUnitsFor(2, '0.5')).toBe(1)
  })

  it('un factor con seis decimales no se rompe por el error de coma flotante', () => {
    // 3 x 0.333333 = 0.999999 → no entero. Y 1000000 x 0.000001 = 1 sí lo es,
    // aunque el producto en coma flotante caiga en 0.9999999999999999.
    expect(baseUnitsFor(3, '0.333333')).toBeNull()
    expect(baseUnitsFor(1000000, '0.000001')).toBe(1)
  })
})

describe('cuántos kits se pueden armar', () => {
  it('manda el componente más escaso', () => {
    expect(
      assemblableUnits([
        { requiredPerUnit: 2, available: 10 },
        { requiredPerUnit: 1, available: 3 },
      ]),
    ).toBe(3)
  })

  it('un componente agotado deja el kit en cero', () => {
    expect(
      assemblableUnits([
        { requiredPerUnit: 2, available: 10 },
        { requiredPerUnit: 1, available: 0 },
      ]),
    ).toBe(0)
  })

  it('un kit sin componentes es cero, no infinito', () => {
    // Es la misma respuesta que da la base: `KIT_SIN_COMPONENTES`. Devolver
    // infinito habría anunciado disponibilidad ilimitada de un pack vacío.
    expect(assemblableUnits([])).toBe(0)
  })

  it('no se promete media unidad: la división se trunca hacia abajo', () => {
    expect(assemblableUnits([{ requiredPerUnit: 3, available: 8 }])).toBe(2)
  })
})

describe('sugerencia de nombre y SKU de variante', () => {
  it('el nombre concatena las etiquetas de los ejes', () => {
    expect(suggestVariantName(['Rojo', 'M'])).toBe('Rojo · M')
  })

  it('un eje sin elegir no deja separadores sueltos', () => {
    expect(suggestVariantName(['Rojo', '', '  '])).toBe('Rojo')
  })

  it('el SKU añade los códigos en mayúsculas y sin puntuación', () => {
    expect(suggestVariantSku('A-CAMISETA', ['rojo', 'm'])).toBe('A-CAMISETA-ROJO-M')
    expect(suggestVariantSku('A-CAMISETA', ['ro-jo'])).toBe('A-CAMISETA-ROJO')
  })

  it('sin ejes el SKU es el del maestro y no se rompe', () => {
    expect(suggestVariantSku('A-CAMISETA', [])).toBe('A-CAMISETA')
  })

  it('el SKU sugerido nunca supera los 64 caracteres de la columna', () => {
    const suggested = suggestVariantSku('X'.repeat(60), ['rojo', 'talla-extra-grande'])
    expect(suggested.length).toBeLessThanOrEqual(64)
  })
})

describe('formularios: las mismas reglas que los CHECK de la base', () => {
  it('un eje de variante exige tipo lista, igual que `attributes_axis_is_option`', () => {
    const base = {
      code: 'color',
      name: 'Color',
      unit: '',
      is_filterable: true,
      is_active: true,
    }
    expect(
      attributeFormSchema.safeParse({ ...base, data_type: 'option', is_variant_axis: true }).success,
    ).toBe(true)

    const invalid = attributeFormSchema.safeParse({
      ...base,
      data_type: 'text',
      is_variant_axis: true,
    })
    expect(invalid.success).toBe(false)
    expect(invalid.error?.issues[0]?.message).toBe('pim.error.axisNeedsOptions')
  })

  it('el código de atributo empieza por letra: es identificador, no etiqueta', () => {
    const base = {
      name: 'Color',
      data_type: 'option' as const,
      unit: '',
      is_variant_axis: false,
      is_filterable: true,
      is_active: true,
    }
    expect(attributeFormSchema.safeParse({ ...base, code: '1color' }).success).toBe(false)
    expect(attributeFormSchema.safeParse({ ...base, code: 'color_base' }).success).toBe(true)
    expect(attributeFormSchema.safeParse({ ...base, code: 'color-base' }).success).toBe(false)
  })

  it('el código de unidad admite mayúsculas: UND y CAJA son lo normal', () => {
    const base = { name: 'Caja', symbol: '', is_active: true }
    expect(unitFormSchema.safeParse({ ...base, code: 'CAJA' }).success).toBe(true)
    expect(unitFormSchema.safeParse({ ...base, code: 'CAJA X 12' }).success).toBe(false)
    expect(unitFormSchema.safeParse({ ...base, code: 'A'.repeat(17) }).success).toBe(false)
  })

  it('el precio vacío de una variante es válido: significa "hereda"', () => {
    const base = {
      sku: 'A-1-ROJO',
      name: 'Rojo',
      stock: '5',
      barcode: '',
      is_active: true,
      is_default: false,
    }
    expect(variantFormSchema.safeParse({ ...base, price: '' }).success).toBe(true)
    expect(variantFormSchema.safeParse({ ...base, price: '49.90' }).success).toBe(true)
    expect(variantFormSchema.safeParse({ ...base, price: '49,90' }).success).toBe(false)
    expect(variantFormSchema.safeParse({ ...base, price: '49.999' }).success).toBe(false)
  })

  it('un factor de conversión cero o negativo no pasa, como el CHECK de la base', () => {
    const base = { uom_id: PRODUCT, is_base: false, is_sellable: true, price: '' }
    expect(productUomFormSchema.safeParse({ ...base, factor: '12' }).success).toBe(true)
    expect(productUomFormSchema.safeParse({ ...base, factor: '0' }).success).toBe(false)
    expect(productUomFormSchema.safeParse({ ...base, factor: '-1' }).success).toBe(false)
    expect(productUomFormSchema.safeParse({ ...base, factor: '0.333333' }).success).toBe(true)
    // Siete decimales: la columna es numeric(18,6) y redondearía en silencio.
    expect(productUomFormSchema.safeParse({ ...base, factor: '0.3333333' }).success).toBe(false)
  })

  it('un componente de kit necesita producto y cantidad positiva', () => {
    const base = { component_variant_id: '', uom_id: '' }
    expect(
      bundleItemFormSchema.safeParse({ ...base, component_product_id: PRODUCT, quantity: '2' })
        .success,
    ).toBe(true)
    expect(
      bundleItemFormSchema.safeParse({ ...base, component_product_id: '', quantity: '2' }).success,
    ).toBe(false)
    expect(
      bundleItemFormSchema.safeParse({ ...base, component_product_id: PRODUCT, quantity: '0' })
        .success,
    ).toBe(false)
  })
})
