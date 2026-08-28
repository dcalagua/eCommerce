import { describe, expect, it } from 'vitest'
import {
  PRICE_CSV_HEADERS,
  parsePriceCsv,
  resolvePriceCsv,
  splitCsvLine,
} from './importCsv'
import {
  PRICE_SCOPES,
  SCOPE_RANK,
  assignmentFormSchema,
  comparePrecedence,
  conflictSeverity,
  priceListFormSchema,
  priceListToForm,
  priceQuoteSchema,
  toLocalInput,
  validityOf,
  type PriceList,
} from './types'

/**
 * Reglas PURAS del motor de precios en el cliente.
 *
 * Ninguna de estas funciones decide un precio —eso pasa en el servidor y se
 * prueba contra Postgres real en `supabase/tests`—. Lo que se comprueba aquí es
 * lo que el navegador sí hace y puede hacer mal: EXPLICAR la precedencia, leer
 * una hoja de cálculo sin inventarse filas, y no dejar guardar una vigencia
 * invertida ni una asignación sin destino.
 */

function list(overrides: Partial<PriceList> = {}): PriceList {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    store_id: 'b0000000-0000-4000-8000-000000000001',
    code: 'general',
    name: 'General',
    currency: 'PEN',
    priority: 0,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    is_active: true,
    notes: null,
    ...overrides,
  }
}

describe('precedencia entre alcances', () => {
  it('los cuatro alcances están declarados de más específico a menos', () => {
    expect([...PRICE_SCOPES]).toEqual(['customer', 'segment', 'channel', 'store'])
  })

  /**
   * Los rangos son los mismos números que escribe `ebim.active_price_lists`.
   * Si se separaran, la pantalla explicaría una precedencia que el motor no
   * aplica — que es peor que no explicar ninguna.
   */
  it('el rango crece con la especificidad y coincide con el del servidor', () => {
    expect(SCOPE_RANK).toEqual({ customer: 40, segment: 30, channel: 20, store: 10 })
  })

  it('el alcance manda sobre la prioridad', () => {
    const cliente = { scope: 'customer' as const, priority: 0, valid_from: '2026-01-01', price_list_id: 'a' }
    const tienda = { scope: 'store' as const, priority: 1000, valid_from: '2026-01-01', price_list_id: 'b' }
    expect([tienda, cliente].sort(comparePrecedence)[0]).toBe(cliente)
  })

  it('a igual alcance manda la prioridad', () => {
    const baja = { scope: 'store' as const, priority: 10, valid_from: '2026-01-01', price_list_id: 'a' }
    const alta = { scope: 'store' as const, priority: 90, valid_from: '2026-01-01', price_list_id: 'b' }
    expect([baja, alta].sort(comparePrecedence)[0]).toBe(alta)
  })

  it('a igual prioridad manda la vigencia más reciente', () => {
    const vieja = { scope: 'store' as const, priority: 5, valid_from: '2026-01-01', price_list_id: 'a' }
    const nueva = { scope: 'store' as const, priority: 5, valid_from: '2026-06-01', price_list_id: 'b' }
    expect([vieja, nueva].sort(comparePrecedence)[0]).toBe(nueva)
  })

  it('el desempate final es estable: mismo orden en dos llamadas', () => {
    const a = { scope: 'store' as const, priority: 5, valid_from: '2026-01-01', price_list_id: 'aaa' }
    const b = { scope: 'store' as const, priority: 5, valid_from: '2026-01-01', price_list_id: 'bbb' }
    expect([a, b].sort(comparePrecedence)).toEqual([b, a].sort(comparePrecedence))
  })
})

describe('estado de vigencia', () => {
  const now = new Date('2026-06-01T12:00:00.000Z')

  it('una lista desactivada no está vigente aunque su ventana lo esté', () => {
    expect(validityOf(list({ is_active: false }), now)).toBe('off')
  })

  it('una lista que empieza mañana está programada', () => {
    expect(validityOf(list({ valid_from: '2026-07-01T00:00:00.000Z' }), now)).toBe('scheduled')
  })

  it('una lista cuya ventana terminó está caducada', () => {
    expect(validityOf(list({ valid_to: '2026-05-01T00:00:00.000Z' }), now)).toBe('expired')
  })

  it('una lista abierta y sin fin está vigente', () => {
    expect(validityOf(list(), now)).toBe('active')
  })
})

describe('diagnóstico', () => {
  it('solo el empate ambiguo es un error: los demás dejan la lista sin efecto', () => {
    expect(conflictSeverity('ambiguous_priority')).toBe('error')
    for (const kind of ['currency_mismatch', 'expired', 'unassigned', 'empty'] as const) {
      expect(conflictSeverity(kind)).toBe('warning')
    }
  })
})

describe('formulario de lista', () => {
  it('rechaza una vigencia que termina antes de empezar', () => {
    const result = priceListFormSchema.safeParse({
      code: 'general',
      name: 'General',
      currency: 'PEN',
      priority: 0,
      valid_from: '2026-06-01T10:00',
      valid_to: '2026-05-01T10:00',
      is_active: true,
      notes: '',
    })
    expect(result.success).toBe(false)
  })

  it('admite una lista sin fecha de fin', () => {
    const result = priceListFormSchema.safeParse({
      code: 'general',
      name: 'General',
      currency: 'PEN',
      priority: 500,
      valid_from: '2026-06-01T10:00',
      valid_to: '',
      is_active: true,
      notes: '',
    })
    expect(result.success).toBe(true)
  })

  it('rechaza una prioridad fuera del rango que admite la base', () => {
    const base = {
      code: 'general',
      name: 'General',
      currency: 'PEN',
      valid_from: '2026-06-01T10:00',
      valid_to: '',
      is_active: true,
      notes: '',
    }
    expect(priceListFormSchema.safeParse({ ...base, priority: 1001 }).success).toBe(false)
    expect(priceListFormSchema.safeParse({ ...base, priority: -1 }).success).toBe(false)
  })

  it('el formulario de una lista nueva nace vigente desde hoy', () => {
    const form = priceListToForm(null)
    expect(form.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(form.valid_to).toBe('')
    expect(form.is_active).toBe(true)
  })

  it('una fecha que no se puede leer no se convierte en un valor inventado', () => {
    expect(toLocalInput('no-es-una-fecha')).toBe('')
    expect(toLocalInput(null)).toBe('')
  })
})

describe('formulario de asignación', () => {
  it('el alcance tienda no necesita destino', () => {
    const result = assignmentFormSchema.safeParse({
      scope: 'store',
      channel_id: '',
      segment_id: '',
      customer_id: '',
    })
    expect(result.success).toBe(true)
  })

  it('los otros tres sí: sin destino no se guarda', () => {
    for (const scope of ['channel', 'segment', 'customer'] as const) {
      const result = assignmentFormSchema.safeParse({
        scope,
        channel_id: '',
        segment_id: '',
        customer_id: '',
      })
      expect(`${scope}: ${result.success}`).toBe(`${scope}: false`)
    }
  })

  it('el cliente exige un identificador con forma de uuid', () => {
    const bad = assignmentFormSchema.safeParse({
      scope: 'customer',
      channel_id: '',
      segment_id: '',
      customer_id: 'cliente-uno',
    })
    expect(bad.success).toBe(false)

    const good = assignmentFormSchema.safeParse({
      scope: 'customer',
      channel_id: '',
      segment_id: '',
      customer_id: 'c0000000-0000-4000-8000-000000000001',
    })
    expect(good.success).toBe(true)
  })
})

describe('lectura de CSV', () => {
  it('respeta comillas y comas dentro de campo', () => {
    expect(splitCsvLine('"Jabón, grande",A-1,"dice ""hola"""')).toEqual([
      'Jabón, grande',
      'A-1',
      'dice "hola"',
    ])
  })

  it('acepta el punto y coma, que es lo que exporta media Europa', () => {
    expect(splitCsvLine('A-1;2;3.50')).toEqual(['A-1', '2', '3.50'])
  })

  it('sin las columnas obligatorias no lee ni una fila', () => {
    const result = parsePriceCsv('nombre,precio\nJabón,10')
    expect(result.rows).toEqual([])
    expect(result.issues).toEqual([{ line: 0, reason: 'missingHeader', value: 'nombre,precio' }])
  })

  it('lee las columnas mínimas y aplica la escala 1 por defecto', () => {
    const result = parsePriceCsv('sku,unit_price\nA-JABON,8.50')
    expect(result.issues).toEqual([])
    expect(result.rows).toEqual([
      {
        line: 1,
        sku: 'A-JABON',
        variantSku: null,
        uomCode: null,
        minQuantity: '1',
        unitPrice: '8.50',
        compareAtPrice: null,
      },
    ])
  })

  it('acepta la coma decimal de Excel en español', () => {
    const result = parsePriceCsv('sku,unit_price\nA-JABON,"8,50"')
    expect(result.rows[0]?.unitPrice).toBe('8.50')
  })

  it('el BOM de Excel no rompe la primera cabecera', () => {
    const bom = String.fromCharCode(0xfeff)
    const result = parsePriceCsv(`${bom}sku,unit_price\nA-JABON,8.50`)
    expect(result.rows).toHaveLength(1)
  })

  it('una fila con precio ilegible se rechaza y las demás siguen', () => {
    const result = parsePriceCsv('sku,unit_price\nA-JABON,ocho\nA-OTRO,9.00')
    expect(result.rows.map((row) => row.sku)).toEqual(['A-OTRO'])
    expect(result.issues).toEqual([{ line: 1, reason: 'invalidPrice', value: 'A-JABON' }])
  })

  it('una escala de cero se rechaza: no existe "desde cero unidades"', () => {
    const result = parsePriceCsv('sku,min_quantity,unit_price\nA-JABON,0,9.00')
    expect(result.issues).toEqual([{ line: 1, reason: 'invalidQuantity', value: 'A-JABON' }])
  })

  it('la plantilla declara las seis columnas en orden', () => {
    expect([...PRICE_CSV_HEADERS]).toEqual([
      'sku',
      'variant_sku',
      'uom_code',
      'min_quantity',
      'unit_price',
      'compare_at_price',
    ])
  })
})

describe('resolución del CSV contra el catálogo', () => {
  const catalog = {
    products: [
      { id: 'p1', sku: 'A-JABON', name: 'Jabón', kind: 'simple' as const },
      { id: 'p2', sku: 'A-CAMISETA', name: 'Camiseta', kind: 'variant' as const },
    ],
    variants: [{ id: 'v1', product_id: 'p2', sku: 'A-CAM-ROJA', name: 'Roja' }],
    uoms: [{ uom_id: 'u1', product_id: 'p1', code: 'CAJA', factor: '12' }],
  }

  it('resuelve el SKU y deja la variante y la presentación vacías', () => {
    const parsed = parsePriceCsv('sku,unit_price\nA-JABON,8.50')
    const { resolved, issues } = resolvePriceCsv(parsed.rows, catalog)
    expect(issues).toEqual([])
    expect(resolved).toEqual([
      {
        line: 1,
        productId: 'p1',
        variantId: null,
        uomId: null,
        minQuantity: '1',
        unitPrice: '8.50',
        compareAtPrice: null,
      },
    ])
  })

  it('un SKU que no existe es un error de fila, no una fila que se salta callando', () => {
    const parsed = parsePriceCsv('sku,unit_price\nA-FANTASMA,8.50')
    const { resolved, issues } = resolvePriceCsv(parsed.rows, catalog)
    expect(resolved).toEqual([])
    expect(issues).toEqual([{ line: 1, reason: 'unknownSku', value: 'A-FANTASMA' }])
  })

  it('una variante de OTRO producto se rechaza antes de llegar a la base', () => {
    const parsed = parsePriceCsv('sku,variant_sku,unit_price\nA-JABON,A-CAM-ROJA,8.50')
    const { resolved, issues } = resolvePriceCsv(parsed.rows, catalog)
    expect(resolved).toEqual([])
    expect(issues).toEqual([{ line: 1, reason: 'variantMismatch', value: 'A-CAM-ROJA' }])
  })

  it('una presentación que ese producto no tiene configurada se rechaza', () => {
    const parsed = parsePriceCsv('sku,uom_code,unit_price\nA-CAMISETA,CAJA,50.00')
    const { issues } = resolvePriceCsv(parsed.rows, catalog)
    expect(issues).toEqual([{ line: 1, reason: 'unknownUom', value: 'CAJA' }])
  })

  it('resuelve variante y presentación cuando sí corresponden', () => {
    const parsed = parsePriceCsv(
      'sku,variant_sku,uom_code,min_quantity,unit_price\nA-CAMISETA,A-CAM-ROJA,,10,42.00\nA-JABON,,caja,1,90.00',
    )
    const { resolved, issues } = resolvePriceCsv(parsed.rows, catalog)
    expect(issues).toEqual([])
    expect(resolved.map((row) => [row.productId, row.variantId, row.uomId])).toEqual([
      ['p2', 'v1', null],
      ['p1', null, 'u1'],
    ])
  })
})

describe('la cotización del servidor se lee sin pasar el dinero por un float', () => {
  it('los importes se conservan como texto decimal', () => {
    const quote = priceQuoteSchema.parse({
      currency: 'PEN',
      channel: 'b2c',
      tax_inclusive: false,
      quoted_at: '2026-06-01T00:00:00.000Z',
      subtotal: '80.00',
      tax_total: '14.40',
      grand_total: '94.40',
      lines: [
        {
          product_id: 'a0000000-0000-4000-8000-000000000001',
          variant_id: null,
          name: 'Jabón',
          uom_code: null,
          quantity: '10',
          unit_price: '8.00',
          compare_at_price: null,
          net_amount: '80.00',
          tax_rate: '0.1800',
          source: 'price_list',
          price_list_id: 'a0000000-0000-4000-8000-000000000002',
          price_list_code: 'mayorista',
          scope: 'segment',
          min_quantity: '10.000000',
        },
      ],
    })

    expect(quote.subtotal).toBe('80.00')
    expect(quote.lines[0]?.unit_price).toBe('8.00')
    // La cantidad SÍ es un número: es un contador, no dinero.
    expect(quote.lines[0]?.quantity).toBe(10)
    expect(quote.lines[0]?.scope).toBe('segment')
  })
})
