import { useQuery } from '@tanstack/react-query'
import { PUBLIC_PRODUCT_VARIANTS_VIEW } from '@/shared/lib/db-schema'
import { tryGetStorefrontClient } from '@/shared/lib/supabase'
import { isColorAxis, swatchOf } from './colorSwatch'

/**
 * Los colores de un producto con variantes, para las bolitas de la tarjeta
 * (2026-10-02, pedido para la demo «Porta»).
 *
 * ## Una consulta por pantalla, no por tarjeta
 *
 * Cada tarjeta pide los suyos, pero las peticiones del mismo instante se JUNTAN
 * (`queueMicrotask` + un `setTimeout(0)`) en una sola lectura de la vista
 * pública de variantes con `product_id in (...)`. Una rejilla de 24 productos
 * es una petición, no 24.
 *
 * Solo lo PUBLICADO: la vista `public_product_variants` es la frontera pública
 * de siempre. Y solo colores que se reconocen por el nombre: si un valor no es
 * un color conocido, ese producto no pinta bolitas (no se mezclan).
 */
export interface ProductSwatch {
  readonly label: string
  readonly swatch: string
}

type Pendiente = { resolve: (value: ProductSwatch[]) => void; reject: (error: unknown) => void }
let cola = new Map<string, Pendiente[]>()
let programado = false

const LOTE = 60

async function vaciar(): Promise<void> {
  programado = false
  const actual = cola
  cola = new Map()
  const ids = [...actual.keys()]
  const client = tryGetStorefrontClient()
  for (let i = 0; i < ids.length; i += LOTE) {
    const trozo = ids.slice(i, i + LOTE)
    try {
      const resultado = new Map<string, ProductSwatch[]>(trozo.map((id) => [id, []]))
      if (client) {
        const { data, error } = await client
          .from(PUBLIC_PRODUCT_VARIANTS_VIEW)
          .select('product_id, options, position')
          .in('product_id', trozo)
          .order('position')
        if (error) throw error
        const vistos = new Map<string, Set<string>>()
        const desconocido = new Set<string>()
        for (const fila of (data ?? []) as Array<{ product_id: string; options: unknown }>) {
          if (!Array.isArray(fila.options)) continue
          for (const option of fila.options as Array<Record<string, unknown>>) {
            const code = String(option.code ?? '')
            const name = String(option.name ?? '')
            const label = String(option.label ?? '')
            if (!label || !isColorAxis({ code, name })) continue
            const tono = swatchOf(label)
            if (!tono) {
              desconocido.add(fila.product_id)
              continue
            }
            const set = vistos.get(fila.product_id) ?? new Set<string>()
            if (!set.has(label)) {
              set.add(label)
              resultado.get(fila.product_id)?.push({ label, swatch: tono })
            }
            vistos.set(fila.product_id, set)
          }
        }
        for (const id of desconocido) resultado.set(id, [])
      }
      for (const id of trozo) for (const p of actual.get(id) ?? []) p.resolve(resultado.get(id) ?? [])
    } catch (error) {
      for (const id of trozo) for (const p of actual.get(id) ?? []) p.reject(error)
    }
  }
}

function cargar(productId: string): Promise<ProductSwatch[]> {
  return new Promise((resolve, reject) => {
    const lista = cola.get(productId) ?? []
    lista.push({ resolve, reject })
    cola.set(productId, lista)
    if (!programado) {
      programado = true
      setTimeout(() => void vaciar(), 0)
    }
  })
}

export function useProductSwatches(productId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['storefront', 'swatches', productId],
    queryFn: () => cargar(productId),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
}
