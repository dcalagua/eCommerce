import { z } from 'zod'

/**
 * Producto del catálogo. `organization_id`/`company_id` son los uuid del hub y
 * viajan en la fila solo como lectura: el filtro de tenant lo aplica RLS con los
 * claims del JWT, nunca una condición que arme el cliente.
 */
export const productSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(['draft', 'published', 'archived']),
  price: z.number().nonnegative(),
  currency: z.string().length(3),
  image_url: z.string().url().nullable().default(null),
})

export type Product = z.infer<typeof productSchema>

export const PRODUCTS_TABLE = 'products'
