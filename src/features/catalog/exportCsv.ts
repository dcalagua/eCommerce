import type { Category, Product } from './types'

const HEADERS = ['sku', 'name', 'slug', 'category', 'price', 'currency', 'stock', 'status'] as const

/**
 * Escapa un campo CSV.
 *
 * Además de las comillas y los separadores, se neutraliza el arranque por
 * `= + - @` (y tabulador): Excel interpreta esas celdas como fórmula, y un
 * nombre de producto escrito por un tercero no debería ejecutarse al abrir el
 * archivo. Es el clásico "CSV injection".
 */
export function escapeCsvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${guarded.replace(/"/g, '""')}"`
}

export function productsToCsv(products: Product[], categories: Category[]): string {
  const nameById = new Map(categories.map((category) => [category.id, category.name]))

  const lines = [HEADERS.join(',')]
  for (const product of products) {
    lines.push(
      [
        product.sku,
        product.name,
        product.slug,
        product.category_id ? (nameById.get(product.category_id) ?? '') : '',
        product.price,
        product.currency,
        String(product.stock),
        product.status,
      ]
        .map(escapeCsvField)
        .join(','),
    )
  }
  return lines.join('\r\n')
}

/** Descarga en el navegador. El BOM es lo que hace que Excel lea el UTF-8. */
export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([`\u{FEFF}${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
