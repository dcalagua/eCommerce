import { z } from 'zod'

export const PRODUCT_STATUSES = ['draft', 'published', 'archived'] as const

/**
 * Producto del catálogo, con los nombres de columna reales de
 * `20260827090300_catalog.sql`. `organization_id`/`company_id` viajan en la fila
 * solo como lectura: el filtro de tenant lo aplica RLS con los claims del JWT,
 * nunca una condición que arme el cliente.
 */
export const productSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  store_id: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(PRODUCT_STATUSES),
  price: z.number().nonnegative(),
  currency: z.string().length(3),
  stock: z.number().int(),
})

export type Product = z.infer<typeof productSchema>
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]

export const PRODUCTS_TABLE = 'products'
