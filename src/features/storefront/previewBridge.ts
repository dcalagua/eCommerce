import { useEffect, useMemo, useState } from 'react'
import type { PublicStore } from './types'

/**
 * El PUENTE de la vista previa (Resumen v2 · «Diseño de tienda» con la tienda real).
 *
 * El taller de diseño del backoffice abre la vitrina DE VERDAD en un iframe
 * (`/s/:slug?vista_previa=1`) y le manda por `postMessage` lo que hay en el
 * formulario SIN GUARDAR: tema, portada, color, letra, textos. La vitrina lo
 * pinta encima de lo que leyó de la base. Así la vista previa no imita la
 * tienda: ES la tienda, con sus componentes, sus datos y sus puntos de corte
 * (el iframe tiene su propio ancho, y las media queries responden a él).
 *
 * ## Lo que lo hace seguro
 *
 *  · Solo se activa DENTRO de un iframe y abierto con `?vista_previa=1` (la
 *    marca se guarda en la sesión de esa pestaña para sobrevivir a la
 *    navegación dentro del iframe).
 *  · Solo acepta mensajes de la ventana MADRE y del MISMO origen.
 *  · Solo copia una lista CERRADA de campos de presentación. Nada de ids, ni
 *    tienda, ni precios: el catálogo, los precios y el carrito siguen saliendo
 *    del servidor con el cliente anónimo de siempre.
 *  · No escribe nada: vive en memoria mientras la pestaña esté abierta.
 */

export const PREVIEW_PARAM = 'vista_previa'
export const PREVIEW_MESSAGE = 'ebim:store-preview'
export const PREVIEW_READY = 'ebim:store-preview-ready'
const MARCA_SESION = 'ebim.store-preview'

/** Lo único que la vista previa puede pisar: presentación y textos. */
export const PREVIEW_FIELDS = [
  'name',
  'accent_color',
  'font_family',
  'ui_radius',
  'ui_density',
  'theme_preset',
  'storefront_style',
  'home_layout',
  'hero_title',
  'hero_subtitle',
  'hero_kicker',
  'store_description',
  'brand_lockup',
  'show_theme_toggle',
  'announcement_messages',
  'value_props',
] as const

export type PreviewOverrides = Partial<Record<(typeof PREVIEW_FIELDS)[number], unknown>>

/** Se queda solo con los campos permitidos. Lo demás, fuera. */
export function sanitizePreviewOverrides(valor: unknown): PreviewOverrides {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return {}
  const crudo = valor as Record<string, unknown>
  const limpio: PreviewOverrides = {}
  for (const campo of PREVIEW_FIELDS) {
    if (campo in crudo) limpio[campo] = crudo[campo]
  }
  return limpio
}

/** ¿Está esta vitrina abierta como vista previa del taller? */
export function isStorePreview(): boolean {
  if (typeof window === 'undefined' || window.parent === window) return false
  try {
    if (new URLSearchParams(window.location.search).get(PREVIEW_PARAM) === '1') {
      sessionStorage.setItem(MARCA_SESION, '1')
      return true
    }
    return sessionStorage.getItem(MARCA_SESION) === '1'
  } catch {
    return false
  }
}

/**
 * La tienda que se pinta: la de la base, con lo que mande el taller encima.
 * Fuera del modo vista previa devuelve la de la base tal cual.
 */
export function useStorePreview(store: PublicStore | undefined): PublicStore | undefined {
  const [activo] = useState(isStorePreview)
  const [encima, setEncima] = useState<PreviewOverrides>({})

  useEffect(() => {
    if (!activo) return
    const alRecibir = (evento: MessageEvent) => {
      if (evento.source !== window.parent || evento.origin !== window.location.origin) return
      const datos = evento.data as { type?: unknown; overrides?: unknown } | null
      if (!datos || datos.type !== PREVIEW_MESSAGE) return
      setEncima(sanitizePreviewOverrides(datos.overrides))
    }
    window.addEventListener('message', alRecibir)
    // «Ya estoy»: el taller responde con lo que tenga en el formulario.
    window.parent.postMessage({ type: PREVIEW_READY }, window.location.origin)
    return () => window.removeEventListener('message', alRecibir)
  }, [activo])

  return useMemo(
    () => (store && activo ? ({ ...store, ...encima } as PublicStore) : store),
    [store, activo, encima],
  )
}
