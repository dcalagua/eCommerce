import { describe, expect, it } from 'vitest'
import { MESSAGES } from '@/shared/i18n/messages.all'
import { mapPromotionsCode } from './errors'
import {
  AUDIENCE_KINDS,
  EFFECTIVE_STATUSES,
  PROMOTION_KINDS,
  PROMOTION_STATUSES,
  SCOPE_KINDS,
  combinationLabel,
  formatGiftCardCode,
  normalizeCouponCode,
  promotionSchema,
  promotionSummary,
  simulationSchema,
  trimDecimals,
  validatePromotionForm,
  type Promotion,
  type PromotionFormValues,
} from './types'

/**
 * Las funciones PURAS del módulo de promociones.
 *
 * Lo que se prueba aquí no es el motor —eso vive en el servidor y se prueba
 * contra Postgres real— sino las tres cosas que solo dependen de este lado:
 *
 *  1. **La validación del formulario dice lo mismo que los CHECK de la base.**
 *     Está escrita dos veces a propósito, y estos tests son lo que impide que
 *     las dos copias se separen: si alguien relaja el formulario, el error deja
 *     de salir en el campo y empieza a salir como un 400 con un nombre de
 *     restricción dentro.
 *  2. **La normalización del cupón es la MISMA que la columna generada.** Si no
 *     lo fuera, la pantalla enseñaría un código que se guarda distinto.
 *  3. **Ningún importe pasa por un `number`.** Los esquemas devuelven texto
 *     decimal, que es lo que P02 decidió y lo que hace que los céntimos cuadren.
 */

const BASE: PromotionFormValues = {
  code: 'verano',
  name: 'Verano',
  description: '',
  kind: 'percentage',
  status: 'draft',
  priority: 100,
  stackGroup: '',
  isExclusive: false,
  requiresCoupon: false,
  valuePercent: '10',
  valueAmount: '',
  maxDiscountAmount: '',
  buyQuantity: '',
  freeQuantity: '',
  minSubtotal: '',
  minQuantity: '',
  validFrom: '2026-08-01T00:00',
  validTo: '',
  usageLimit: '',
  usageLimitPerCustomer: '',
}

const PROMOTION: Promotion = {
  id: 'p1',
  store_id: 's1',
  code: 'verano',
  name: 'Verano',
  description: null,
  kind: 'percentage',
  status: 'active',
  effective_status: 'live',
  priority: 100,
  stack_group: null,
  is_exclusive: false,
  requires_coupon: false,
  value_percent: '10.0000',
  value_amount: null,
  max_discount_amount: null,
  buy_quantity: null,
  free_quantity: null,
  min_subtotal: null,
  min_quantity: null,
  valid_from: '2026-08-01T00:00:00.000Z',
  valid_to: null,
  usage_limit: null,
  usage_limit_per_customer: null,
  usage_count: 0,
  scope_count: 1,
  exclusion_count: 0,
  audience_count: 0,
  tier_count: 0,
  coupon_count: 0,
  redemption_count: 0,
  discount_granted: '0.00',
}

describe('validación del formulario de campaña', () => {
  it('una campaña de porcentaje bien puesta no tiene errores', () => {
    expect(validatePromotionForm(BASE)).toEqual({})
  })

  it('el código sigue el mismo formato que `promotions_code_fmt`', () => {
    for (const code of ['Verano', 'verano 25', '-verano', 'VERANO', 'ver@no', '']) {
      expect(validatePromotionForm({ ...BASE, code }).code).toBe('promotions.invalid.code')
    }
    for (const code of ['verano', 'verano-25', 'verano_25', 'v2']) {
      expect(validatePromotionForm({ ...BASE, code }).code).toBeUndefined()
    }
  })

  it('un porcentaje fuera de (0, 100] se detiene en el cliente', () => {
    for (const valuePercent of ['0', '-5', '101', '', 'diez', '10,5']) {
      expect(validatePromotionForm({ ...BASE, valuePercent }).valuePercent).toBe(
        'promotions.invalid.percent',
      )
    }
    expect(validatePromotionForm({ ...BASE, valuePercent: '33.3333' }).valuePercent).toBeUndefined()
  })

  it('un importe con coma decimal no pasa: el dinero va con punto', () => {
    const errors = validatePromotionForm({
      ...BASE, kind: 'fixed_amount', valuePercent: '', valueAmount: '10,50',
    })
    expect(errors.valueAmount).toBe('promotions.invalid.amount')
  })

  it('cada tipo exige SUS campos, igual que `promotions_kind_shape`', () => {
    // Porcentaje sin porcentaje.
    expect(
      validatePromotionForm({ ...BASE, valuePercent: '' }).valuePercent,
    ).toBe('promotions.invalid.percent')
    // Importe fijo sin importe.
    expect(
      validatePromotionForm({ ...BASE, kind: 'fixed_amount', valuePercent: '' }).valueAmount,
    ).toBe('promotions.invalid.amount')
    // X por Y sin cantidades.
    const xForY = validatePromotionForm({ ...BASE, kind: 'x_for_y', valuePercent: '' })
    expect(xForY.buyQuantity).toBe('promotions.invalid.quantity')
    expect(xForY.freeQuantity).toBe('promotions.invalid.quantity')
    // Volumen no necesita ninguno: las escalas van aparte.
    expect(validatePromotionForm({ ...BASE, kind: 'volume_tier', valuePercent: '' })).toEqual({})
  })

  it('un 3x2 que regala tanto como cobra se rechaza aquí y no en la base', () => {
    const errors = validatePromotionForm({
      ...BASE, kind: 'x_for_y', valuePercent: '', buyQuantity: '3', freeQuantity: '3',
    })
    expect(errors.freeQuantity).toBe('promotions.invalid.freeBelowBuy')
  })

  it('un combo lleva porcentaje O importe, nunca los dos ni ninguno', () => {
    const ninguno = validatePromotionForm({ ...BASE, kind: 'bundle', valuePercent: '' })
    expect(ninguno.valuePercent).toBe('promotions.invalid.bundleValue')

    const ambos = validatePromotionForm({
      ...BASE, kind: 'bundle', valuePercent: '10', valueAmount: '5.00',
    })
    expect(ambos.valuePercent).toBe('promotions.invalid.bundleValue')

    expect(
      validatePromotionForm({ ...BASE, kind: 'bundle', valuePercent: '10' }),
    ).toEqual({})
  })

  it('un tope sobre un importe fijo no significa nada y se dice', () => {
    const errors = validatePromotionForm({
      ...BASE, kind: 'fixed_amount', valuePercent: '', valueAmount: '10.00',
      maxDiscountAmount: '5.00',
    })
    expect(errors.maxDiscountAmount).toBe('promotions.invalid.capOnlyPercent')
    // Sobre un porcentaje y sobre una escala, sí.
    expect(
      validatePromotionForm({ ...BASE, maxDiscountAmount: '50.00' }).maxDiscountAmount,
    ).toBeUndefined()
  })

  it('la prioridad va de 0 a 1000, como en la base', () => {
    for (const priority of [-1, 1001, 1.5]) {
      expect(validatePromotionForm({ ...BASE, priority }).priority).toBe(
        'promotions.invalid.priority',
      )
    }
    for (const priority of [0, 500, 1000]) {
      expect(validatePromotionForm({ ...BASE, priority }).priority).toBeUndefined()
    }
  })

  it('una vigencia invertida se detiene antes de llegar al CHECK', () => {
    const errors = validatePromotionForm({
      ...BASE, validFrom: '2026-08-10T00:00', validTo: '2026-08-01T00:00',
    })
    expect(errors.validTo).toBe('promotions.invalid.period')
  })

  it('un límite de usos de cero o negativo no es un límite', () => {
    for (const usageLimit of ['0', '-1', 'muchos', '1.5']) {
      expect(validatePromotionForm({ ...BASE, usageLimit }).usageLimit).toBe(
        'promotions.invalid.limit',
      )
    }
    expect(validatePromotionForm({ ...BASE, usageLimit: '100' }).usageLimit).toBeUndefined()
  })

  it('todos los mensajes de validación son CLAVES de i18n que existen en las dos lenguas', () => {
    const casos: PromotionFormValues[] = [
      { ...BASE, code: 'MAL', name: '', priority: -1, valuePercent: '', usageLimit: '0' },
      { ...BASE, kind: 'x_for_y', valuePercent: '', buyQuantity: '2', freeQuantity: '2' },
      { ...BASE, kind: 'bundle', valuePercent: '', valueAmount: '' },
      { ...BASE, validFrom: '', maxDiscountAmount: 'x' },
      { ...BASE, kind: 'fixed_amount', valuePercent: '', valueAmount: '1',
        maxDiscountAmount: '5', stackGroup: 'MAL', minQuantity: '-1' },
    ]
    for (const caso of casos) {
      for (const key of Object.values(validatePromotionForm(caso))) {
        expect(MESSAGES.es).toHaveProperty(key)
        expect(MESSAGES.en).toHaveProperty(key)
      }
    }
  })
})

describe('normalización del cupón', () => {
  it('es la misma regla que la columna generada: mayúsculas y solo alfanumérico', () => {
    for (const typed of [' verano-25 ', 'Verano 25', 'VeRaNo_25', 'verano.25']) {
      expect(normalizeCouponCode(typed)).toBe('VERANO25')
    }
  })

  it('un código que al normalizar se queda en nada lo dice', () => {
    expect(normalizeCouponCode('---')).toBe('')
    expect(normalizeCouponCode('   ')).toBe('')
  })

  it('no toca los dígitos ni los reordena', () => {
    expect(normalizeCouponCode('a1-b2-c3')).toBe('A1B2C3')
  })
})

describe('presentación', () => {
  it('un porcentaje con cuatro decimales de cola se lee', () => {
    expect(trimDecimals('10.0000')).toBe('10')
    expect(trimDecimals('33.3300')).toBe('33.33')
    expect(trimDecimals('100')).toBe('100')
  })

  it('el resumen de cada tipo devuelve clave y parámetros, no texto', () => {
    expect(promotionSummary(PROMOTION)).toEqual({
      key: 'promotions.summary.percentage',
      params: { value: '10' },
    })
    expect(
      promotionSummary({
        ...PROMOTION, kind: 'x_for_y', value_percent: null,
        buy_quantity: '3.000000', free_quantity: '1.000000',
      }),
    ).toEqual({ key: 'promotions.summary.xForY', params: { buy: '3', pay: '2' } })
  })

  it('los cinco resúmenes tienen su clave en las dos lenguas', () => {
    for (const kind of PROMOTION_KINDS) {
      const { key } = promotionSummary({ ...PROMOTION, kind })
      expect(MESSAGES.es).toHaveProperty(key)
      expect(MESSAGES.en).toHaveProperty(key)
    }
  })

  it('la etiqueta de combinación distingue exclusiva, grupo y libre', () => {
    expect(combinationLabel(PROMOTION)).toBe('promotions.stack.free')
    expect(combinationLabel({ ...PROMOTION, stack_group: 'rebajas' })).toBe(
      'promotions.stack.group',
    )
    // Exclusiva gana sobre grupo: si va sola, el grupo no significa nada.
    expect(
      combinationLabel({ ...PROMOTION, is_exclusive: true, stack_group: 'rebajas' }),
    ).toBe('promotions.stack.exclusive')
  })

  it('el código de una tarjeta regalo se agrupa de cuatro en cuatro para poder leerlo', () => {
    expect(formatGiftCardCode('ABCD1234EFGH5678IJKL9012')).toBe(
      'ABCD-1234-EFGH-5678-IJKL-9012',
    )
    expect(formatGiftCardCode('')).toBe('')
  })
})

describe('los importes NUNCA son `number`', () => {
  it('el esquema de campaña devuelve texto decimal aunque llegue un número', () => {
    const parsed = promotionSchema.parse({
      ...PROMOTION,
      value_percent: 10,
      discount_granted: 12.5,
    })
    expect(parsed.value_percent).toBe('10.00')
    expect(parsed.discount_granted).toBe('12.50')
    expect(typeof parsed.discount_granted).toBe('string')
  })

  it('el esquema de simulación conserva los decimales de cola', () => {
    const parsed = simulationSchema.parse({
      currency: 'PEN',
      subtotal: '100.00',
      discount_total: '10.00',
      tax_total: '16.20',
      grand_total: '106.20',
      lines: [
        {
          product_id: 'p1',
          name: 'Toalla',
          quantity: '4',
          unit_price: '25.00',
          net_amount: '100.00',
          discount: '10.00',
        },
      ],
      promotions: {
        entitled: true,
        applied: [
          {
            promotion_id: 'p1',
            code: 'verano',
            label: 'Verano',
            kind: 'percentage',
            amount: '10.00',
            coupon_code: null,
          },
        ],
        skipped: [{ code: 'otra', reason: 'sin_alcance' }],
        coupons: [],
      },
    })
    expect(parsed.subtotal).toBe('100.00')
    expect(parsed.lines[0]?.net_amount).toBe('100.00')
    expect(parsed.lines[0]?.quantity).toBe(4)
    expect(parsed.promotions.applied[0]?.amount).toBe('10.00')
  })

  it('una simulación sin bloque de promociones no rompe la pantalla', () => {
    const parsed = simulationSchema.parse({
      currency: 'PEN',
      subtotal: '100.00',
      tax_total: '0.00',
      grand_total: '100.00',
    })
    expect(parsed.discount_total).toBe('0.00')
    expect(parsed.promotions.applied).toEqual([])
  })
})

describe('vocabulario y errores', () => {
  it('los enums del cliente son los mismos que los de la migración 130000', () => {
    // La copia que manda es la de Postgres; `supabase/tests/promotions.test.ts`
    // la ejercita entera. Esto solo impide que alguien añada aquí un valor que
    // la base no conoce.
    expect([...PROMOTION_KINDS]).toEqual([
      'percentage', 'fixed_amount', 'volume_tier', 'x_for_y', 'bundle',
    ])
    expect([...PROMOTION_STATUSES]).toEqual(['draft', 'active', 'paused', 'archived'])
    expect([...SCOPE_KINDS]).toEqual(['all', 'product', 'variant', 'category', 'brand'])
    expect([...AUDIENCE_KINDS]).toEqual([
      'all', 'channel', 'segment', 'customer', 'business_account',
    ])
  })

  it('los estados EFECTIVOS incluyen los guardados más los derivados del reloj', () => {
    for (const status of PROMOTION_STATUSES) {
      if (status === 'active') continue
      expect(EFFECTIVE_STATUSES).toContain(status)
    }
    expect(EFFECTIVE_STATUSES).toContain('live')
    expect(EFFECTIVE_STATUSES).toContain('scheduled')
    expect(EFFECTIVE_STATUSES).toContain('expired')
    expect(EFFECTIVE_STATUSES).toContain('exhausted')
  })

  it('cada código de error se traduce a una clave que existe en las dos lenguas', () => {
    const codigos = [
      'SIN_PERMISO', '42501', 'MODULO_NO_CONTRATADO', '23505', '23514', '23503',
      'TARJETA_NO_ENCONTRADA', 'TARJETA_CADUCADA', 'TARJETA_NO_DISPONIBLE',
      'SALDO_INSUFICIENTE', 'MOTIVO_REQUERIDO', 'IMPORTE_INVALIDO',
      'CUPONES_EXCESIVOS', 'CONFIG_INCOMPLETA', 'UN_CODIGO_QUE_NO_EXISTE',
    ]
    for (const code of codigos) {
      const key = mapPromotionsCode(code)
      expect(MESSAGES.es).toHaveProperty(key)
      expect(MESSAGES.en).toHaveProperty(key)
    }
  })

  it('lo desconocido se traduce a genérico, nunca a «sin permiso»', () => {
    expect(mapPromotionsCode('ERROR_INTERNO')).toBe('promotions.error.generic')
    expect(mapPromotionsCode('')).toBe('promotions.error.generic')
  })

  it('una violación de CHECK se explica como forma inválida, no como error interno', () => {
    // Es el `promotions_kind_shape` visto desde fuera: el detalle accionable lo
    // da `validatePromotionForm` antes de enviar.
    expect(mapPromotionsCode('23514')).toBe('promotions.error.shape')
  })
})
