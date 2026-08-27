import { z } from 'zod'
import type { MessageKey } from '@/shared/i18n/messages'

export const PRODUCTS_TABLE = 'products'
export const CATEGORIES_TABLE = 'categories'
export const PRODUCT_IMAGES_TABLE = 'product_images'

export const PRODUCT_STATUSES = ['draft', 'published', 'archived'] as const
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]

/**
 * Importe del catálogo.
 *
 * Sale de la base como TEXTO (`price::text` en el `select`) por la decisión
 * P02 #19: un `numeric` en JSON se convierte en float en el primer
 * `JSON.parse` del navegador y los céntimos dejan de cuadrar. El esquema
 * acepta número por si alguna respuesta llega sin castear, pero normaliza
 * siempre a string decimal: la app nunca guarda un importe como `number`.
 */
export const moneyText = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.trim()))

/**
 * Producto del catálogo con los nombres de columna reales de
 * `20260827090300_catalog.sql`. `organization_id`/`company_id` viajan en la
 * fila solo como lectura: el filtro de tenant lo aplica la RLS con los claims
 * del JWT, nunca una condición que arme el cliente.
 *
 * Nota de nomenclatura: el encargo llamaba `stock_qty` a la cantidad; la
 * columna se llama `stock` desde P02 y es la que conocen las policies, la
 * función de pedido y los tests de aislamiento. Se respeta el nombre real.
 */
export const productSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  store_id: z.string().uuid(),
  category_id: z.string().uuid().nullable().default(null),
  sku: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().default(null),
  status: z.enum(PRODUCT_STATUSES),
  price: moneyText,
  compare_at_price: moneyText.nullable().default(null),
  currency: z.string().length(3),
  stock: z.number().int(),
  published_at: z.string().nullable().default(null),
  updated_at: z.string(),
})
export type Product = z.infer<typeof productSchema>

export const categorySchema = z.object({
  id: z.string().uuid(),
  store_id: z.string().uuid(),
  parent_id: z.string().uuid().nullable().default(null),
  slug: z.string(),
  name: z.string(),
  position: z.number().int(),
  is_active: z.boolean(),
})
export type Category = z.infer<typeof categorySchema>

export const productImageSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  store_id: z.string().uuid(),
  storage_path: z.string(),
  alt: z.string().nullable().default(null),
  position: z.number().int(),
  is_primary: z.boolean(),
})
export type ProductImage = z.infer<typeof productImageSchema>

/** Conteo real de uso, para la eliminación segura (contrato §4.2). */
export const productUsageSchema = z.object({
  name: z.string(),
  order_lines: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
})
export type ProductUsage = z.infer<typeof productUsageSchema>

export const categoryUsageSchema = z.object({
  name: z.string(),
  products: z.number().int().nonnegative(),
  children: z.number().int().nonnegative(),
})
export type CategoryUsage = z.infer<typeof categoryUsageSchema>

// ---------------------------------------------------------------------------
// Formularios. Los mensajes de error son CLAVES de i18n, no texto: el mismo
// esquema tiene que servir en ES y en EN sin duplicarse.
// ---------------------------------------------------------------------------

/** Mismo formato que `requireSlug` de la Edge Function (3–62, minúsculas). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/
/** Mismo formato que `requireMoney`: hasta 12 enteros y 2 decimales. */
export const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/

const errorKey = (key: MessageKey) => key

export const productFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, errorKey('catalog.error.name'))
    .max(240, errorKey('catalog.error.name')),
  slug: z.string().trim().toLowerCase().regex(SLUG_RE, errorKey('catalog.error.slug')),
  sku: z
    .string()
    .trim()
    .min(1, errorKey('catalog.error.sku'))
    .max(64, errorKey('catalog.error.sku')),
  description: z.string().trim().max(8000, errorKey('catalog.error.description')),
  category_id: z.string(),
  price: z.string().trim().regex(MONEY_RE, errorKey('catalog.error.price')),
  stock: z
    .string()
    .trim()
    .regex(/^\d{1,9}$/, errorKey('catalog.error.stock')),
  status: z.enum(PRODUCT_STATUSES),
})
export type ProductFormValues = z.infer<typeof productFormSchema>

export const categoryFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, errorKey('catalog.error.name'))
    .max(160, errorKey('catalog.error.name')),
  slug: z.string().trim().toLowerCase().regex(SLUG_RE, errorKey('catalog.error.slug')),
  is_active: z.boolean(),
})
export type CategoryFormValues = z.infer<typeof categoryFormSchema>

/** Valores de partida del formulario a partir de un producto existente. */
export function productToForm(product: Product | null): ProductFormValues {
  return {
    name: product?.name ?? '',
    slug: product?.slug ?? '',
    sku: product?.sku ?? '',
    description: product?.description ?? '',
    category_id: product?.category_id ?? '',
    price: product?.price ?? '',
    stock: String(product?.stock ?? 0),
    status: product?.status ?? 'draft',
  }
}

export function categoryToForm(category: Category | null): CategoryFormValues {
  return {
    name: category?.name ?? '',
    slug: category?.slug ?? '',
    is_active: category?.is_active ?? true,
  }
}
