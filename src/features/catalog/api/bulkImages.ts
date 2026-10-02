import { ADMIN_PRODUCT_MASTERS_VIEW, PRODUCT_VARIANTS_TABLE } from '@/shared/lib/db-schema'
import { PRODUCT_IMAGES_TABLE } from '../types'
import { catalogClient } from './client'
import { catalogErrorFromDb } from './errors'

/**
 * Lecturas de la subida de fotos por SKU.
 *
 * `admin_product_masters` es de la SOCIEDAD y la RLS deja ver todas las
 * sociedades del token: con dos, un SKU podría emparejar con el producto de la
 * otra. Por eso aquí el `company_id` sí va en la consulta —no como seguridad,
 * que la pone la RLS y la ruta del objeto, sino como alcance de la pantalla—.
 */

const PAGINA = 1000

/** SKU (en mayúsculas) → id de producto, de toda la sociedad. */
export async function fetchSkuIndex(companyId: string): Promise<Map<string, string>> {
  const supabase = catalogClient()
  const indice = new Map<string, string>()
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase
      .from(ADMIN_PRODUCT_MASTERS_VIEW)
      .select('id, sku')
      .eq('company_id', companyId)
      .order('sku')
      .range(desde, desde + PAGINA - 1)
    if (error) throw catalogErrorFromDb(error)
    const filas = (data ?? []) as { id: string; sku: string | null }[]
    for (const fila of filas) {
      if (fila.sku) indice.set(fila.sku.trim().toUpperCase(), fila.id)
    }
    if (filas.length < PAGINA) return indice
  }
}

/** A qué producto y variante va una foto nombrada con el SKU de una variante. */
export interface VariantTarget {
  readonly productId: string
  readonly variantId: string
}

/**
 * SKU de VARIANTE (en mayúsculas) → su producto y su variante (2026-10-02).
 *
 * `PT-BA01-AZM.png` es la foto de la bandolera AZUL: se cuelga del producto,
 * marcada con su variante, y la ficha la enseña al elegir ese color.
 */
export async function fetchVariantSkuIndex(companyId: string): Promise<Map<string, VariantTarget>> {
  const supabase = catalogClient()
  const indice = new Map<string, VariantTarget>()
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase
      .from(PRODUCT_VARIANTS_TABLE)
      .select('id, product_id, sku')
      .eq('company_id', companyId)
      .order('sku')
      .range(desde, desde + PAGINA - 1)
    if (error) throw catalogErrorFromDb(error)
    const filas = (data ?? []) as { id: string; product_id: string; sku: string | null }[]
    for (const fila of filas) {
      if (fila.sku) indice.set(fila.sku.trim().toUpperCase(), { productId: fila.product_id, variantId: fila.id })
    }
    if (filas.length < PAGINA) return indice
  }
}

/** Cuántas fotos tiene ya cada producto (los que no salen, ninguna). */
export async function fetchImageCounts(productIds: readonly string[]): Promise<Map<string, number>> {
  const supabase = catalogClient()
  const cuentas = new Map<string, number>()
  // Trozos de cien: una lista `in` larga no cabe en la URL de PostgREST.
  for (let i = 0; i < productIds.length; i += 100) {
    const trozo = productIds.slice(i, i + 100)
    const { data, error } = await supabase.from(PRODUCT_IMAGES_TABLE).select('product_id').in('product_id', trozo)
    if (error) throw catalogErrorFromDb(error)
    for (const fila of (data ?? []) as { product_id: string }[]) {
      cuentas.set(fila.product_id, (cuentas.get(fila.product_id) ?? 0) + 1)
    }
  }
  return cuentas
}
