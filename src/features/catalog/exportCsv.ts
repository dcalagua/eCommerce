import { toCsv } from '@/shared/lib/csv'
import type { Category, Product } from './types'

/**
 * Exportación del catálogo. El escapado y la descarga viven en
 * `shared/lib/csv` desde P07: los usa igual el listado de pedidos.
 */
export { escapeCsvField, downloadCsv } from '@/shared/lib/csv'

const HEADERS = ['sku', 'name', 'slug', 'category', 'price', 'currency', 'stock', 'status'] as const

export function productsToCsv(products: Product[], categories: Category[]): string {
  const nameById = new Map(categories.map((category) => [category.id, category.name]))

  return toCsv(
    HEADERS,
    products.map((product) => [
      product.sku,
      product.name,
      product.slug,
      product.category_id ? (nameById.get(product.category_id) ?? '') : '',
      product.price,
      product.currency,
      String(product.stock),
      product.status,
    ]),
  )
}
