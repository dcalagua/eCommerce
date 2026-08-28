import type { PricedProduct, PricedUom, PricedVariant } from './types'

/**
 * Importación de precios desde CSV/Excel.
 *
 * Una lista de precios real no se teclea: llega en una hoja de cálculo con
 * miles de renglones. Esta es la vía de carga masiva, y por eso es también la
 * respuesta a «¿escala a miles de SKU?»: el alta fila a fila del panel sirve
 * para corregir tres precios, no para cargar un acuerdo entero.
 *
 * Tres decisiones que hacen que una importación sea revisable:
 *
 *  1. **Se resuelve por SKU, nunca por uuid.** Nadie tiene los uuid de sus
 *     productos en una hoja; el SKU es la clave que el negocio ya usa. Un SKU
 *     que no existe es un error de la fila, no una fila que se salta callando.
 *  2. **Parsear y resolver son dos pasos.** El primero solo mira el texto, el
 *     segundo lo cruza con el catálogo. Así la pantalla puede enseñar el
 *     resultado ANTES de escribir nada, que es lo que convierte una carga
 *     masiva en algo que alguien se atreve a aprobar.
 *  3. **Ningún importe pasa por `number`.** Se valida el formato decimal y se
 *     conserva el texto: redondear aquí sería exactamente el bug que el resto
 *     del proyecto evita.
 */

/** Cabeceras admitidas, en el orden en que se exportan. */
export const PRICE_CSV_HEADERS = [
  'sku',
  'variant_sku',
  'uom_code',
  'min_quantity',
  'unit_price',
  'compare_at_price',
] as const

export interface ParsedPriceRow {
  /** 1 = primera fila de datos (la cabecera no cuenta). */
  readonly line: number
  readonly sku: string
  readonly variantSku: string | null
  readonly uomCode: string | null
  readonly minQuantity: string
  readonly unitPrice: string
  readonly compareAtPrice: string | null
}

export interface CsvIssue {
  readonly line: number
  /** Clave de i18n. El texto crudo del archivo no se enseña como mensaje. */
  readonly reason:
    | 'missingHeader'
    | 'missingSku'
    | 'invalidPrice'
    | 'invalidQuantity'
    | 'unknownSku'
    | 'unknownVariant'
    | 'unknownUom'
    | 'variantMismatch'
  readonly value: string
}

export interface ParseResult {
  readonly rows: readonly ParsedPriceRow[]
  readonly issues: readonly CsvIssue[]
}

const DECIMAL = /^\d{1,10}([.,]\d{1,6})?$/

/** Una línea CSV respetando comillas dobles y comas dentro de campo. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        current += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ',' || char === ';') {
      fields.push(current)
      current = ''
      continue
    }
    current += char
  }
  fields.push(current)
  return fields.map((field) => field.trim())
}

function normalizeDecimal(value: string): string {
  // La coma decimal es lo que produce Excel en español. Se acepta y se
  // normaliza: rechazarla haría que la mitad de las hojas del mundo fallaran
  // por una convención de teclado.
  return value.replace(',', '.')
}

/**
 * Paso 1: el texto. No consulta nada y no sabe qué productos existen.
 */
export function parsePriceCsv(text: string): ParseResult {
  const rows: ParsedPriceRow[] = []
  const issues: CsvIssue[] = []

  const lines = text
    // BOM: Excel lo escribe siempre y sin quitarlo la primera cabecera no es
    // `sku` sino un `sku` con un carácter invisible delante.
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)

  if (lines.length === 0) {
    return { rows, issues: [{ line: 0, reason: 'missingHeader', value: '' }] }
  }

  const header = splitCsvLine(lines[0] as string).map((field) => field.toLowerCase())
  const column = (name: (typeof PRICE_CSV_HEADERS)[number]) => header.indexOf(name)

  if (column('sku') < 0 || column('unit_price') < 0) {
    return { rows, issues: [{ line: 0, reason: 'missingHeader', value: lines[0] as string }] }
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = index
    const fields = splitCsvLine(lines[index] as string)
    const at = (name: (typeof PRICE_CSV_HEADERS)[number]): string => {
      const position = column(name)
      return position < 0 ? '' : (fields[position] ?? '').trim()
    }

    const sku = at('sku')
    if (!sku) {
      issues.push({ line, reason: 'missingSku', value: '' })
      continue
    }

    const rawPrice = normalizeDecimal(at('unit_price'))
    if (!DECIMAL.test(rawPrice)) {
      issues.push({ line, reason: 'invalidPrice', value: sku })
      continue
    }

    const rawMin = normalizeDecimal(at('min_quantity') || '1')
    if (!DECIMAL.test(rawMin) || Number(rawMin) <= 0) {
      issues.push({ line, reason: 'invalidQuantity', value: sku })
      continue
    }

    const rawCompare = normalizeDecimal(at('compare_at_price'))
    if (rawCompare && !DECIMAL.test(rawCompare)) {
      issues.push({ line, reason: 'invalidPrice', value: sku })
      continue
    }

    rows.push({
      line,
      sku,
      variantSku: at('variant_sku') || null,
      uomCode: at('uom_code') ? at('uom_code').toUpperCase() : null,
      minQuantity: rawMin,
      unitPrice: rawPrice,
      compareAtPrice: rawCompare || null,
    })
  }

  return { rows, issues }
}

export interface ResolvedPriceRow {
  readonly line: number
  readonly productId: string
  readonly variantId: string | null
  readonly uomId: string | null
  readonly minQuantity: string
  readonly unitPrice: string
  readonly compareAtPrice: string | null
}

export interface PricingCatalog {
  readonly products: readonly PricedProduct[]
  readonly variants: readonly PricedVariant[]
  readonly uoms: readonly PricedUom[]
}

/**
 * Paso 2: cruzar con el catálogo. Devuelve lo que se puede escribir y, aparte,
 * lo que no — nunca una mezcla silenciosa de las dos cosas.
 */
export function resolvePriceCsv(
  rows: readonly ParsedPriceRow[],
  catalog: PricingCatalog,
): { resolved: ResolvedPriceRow[]; issues: CsvIssue[] } {
  const bySku = new Map(catalog.products.map((product) => [product.sku.toLowerCase(), product]))
  const variantBySku = new Map(
    catalog.variants.map((variant) => [variant.sku.toLowerCase(), variant]),
  )
  const uomByProduct = new Map(
    catalog.uoms.map((uom) => [`${uom.product_id}|${uom.code.toUpperCase()}`, uom]),
  )

  const resolved: ResolvedPriceRow[] = []
  const issues: CsvIssue[] = []

  for (const row of rows) {
    const product = bySku.get(row.sku.toLowerCase())
    if (!product) {
      issues.push({ line: row.line, reason: 'unknownSku', value: row.sku })
      continue
    }

    let variantId: string | null = null
    if (row.variantSku) {
      const variant = variantBySku.get(row.variantSku.toLowerCase())
      if (!variant) {
        issues.push({ line: row.line, reason: 'unknownVariant', value: row.variantSku })
        continue
      }
      if (variant.product_id !== product.id) {
        issues.push({ line: row.line, reason: 'variantMismatch', value: row.variantSku })
        continue
      }
      variantId = variant.id
    }

    let uomId: string | null = null
    if (row.uomCode) {
      const uom = uomByProduct.get(`${product.id}|${row.uomCode}`)
      if (!uom) {
        issues.push({ line: row.line, reason: 'unknownUom', value: row.uomCode })
        continue
      }
      uomId = uom.uom_id
    }

    resolved.push({
      line: row.line,
      productId: product.id,
      variantId,
      uomId,
      minQuantity: row.minQuantity,
      unitPrice: row.unitPrice,
      compareAtPrice: row.compareAtPrice,
    })
  }

  return { resolved, issues }
}
