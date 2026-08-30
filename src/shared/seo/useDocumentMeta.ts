import { useEffect } from 'react'
import { absoluteUrl, type PageMeta } from './meta'

/**
 * Aplica los metadatos de una pantalla al `<head>` (P15-SaaS).
 *
 * Por qué a mano y no con una librería: son cinco etiquetas, un `<title>`, un
 * `<link>` y un `<script type="application/ld+json">`; `react-helmet-async`
 * cuesta ~7 kB gzip en el chunk de ENTRADA —el que descarga todo el mundo— para
 * resolver un problema que aquí no existe, porque una sola pantalla de la
 * vitrina está montada a la vez.
 *
 * Lo que sí hay que hacer bien es LIMPIAR. Una SPA no recarga el documento, así
 * que una etiqueta que no se quita al desmontar acaba describiendo la página
 * anterior: la ficha de un producto agotado declarando `InStock` porque el
 * JSON-LD anterior sigue ahí. Por eso todo lo que este hook pone lleva
 * `data-ebim-meta` y se retira entero.
 *
 * `meta === null` significa «todavía no sé qué página es esto» (la tienda o el
 * producto siguen cargando): no se toca nada. Escribir un título provisional
 * haría que lo que se comparte a los dos segundos fuera el título de un
 * esqueleto.
 */

const MARK = 'data-ebim-meta'

function upsert(selector: string, create: () => HTMLElement, apply: (el: HTMLElement) => void) {
  const head = document.head
  let element = head.querySelector<HTMLElement>(`${selector}[${MARK}]`)
  if (!element) {
    element = create()
    element.setAttribute(MARK, '')
    head.appendChild(element)
  }
  apply(element)
}

function meta(attribute: 'name' | 'property', key: string, content: string | null) {
  if (content === null) {
    document.head.querySelector(`meta[${attribute}="${key}"][${MARK}]`)?.remove()
    return
  }
  upsert(
    `meta[${attribute}="${key}"]`,
    () => {
      const el = document.createElement('meta')
      el.setAttribute(attribute, key)
      return el
    },
    (el) => el.setAttribute('content', content),
  )
}

export function useDocumentMeta(pageMeta: PageMeta | null): void {
  // Se serializa el objeto para la lista de dependencias: quien llama arma el
  // `PageMeta` en el render y una identidad nueva por render reescribiría el
  // `<head>` en bucle. Comparar por VALOR es lo que se quiere aquí.
  const fingerprint = pageMeta ? JSON.stringify(pageMeta) : null

  useEffect(() => {
    if (!fingerprint) return
    const value = JSON.parse(fingerprint) as PageMeta

    const previousTitle = document.title
    document.title = value.title

    const origin = typeof window === 'undefined' ? '' : window.location.origin
    const canonical = absoluteUrl(origin, value.canonicalPath)

    upsert(
      'link[rel="canonical"]',
      () => {
        const el = document.createElement('link')
        el.setAttribute('rel', 'canonical')
        return el
      },
      (el) => el.setAttribute('href', canonical),
    )

    // `noindex` va acompañado de `nofollow` a propósito: las páginas que lo
    // llevan (carrito, checkout, cuenta, seguimiento) enlazan a más de lo mismo.
    meta('name', 'robots', value.robots === 'index' ? 'index, follow' : 'noindex, nofollow')
    meta('name', 'description', value.description)

    meta('property', 'og:type', value.ogType)
    meta('property', 'og:title', value.title)
    meta('property', 'og:description', value.description)
    meta('property', 'og:url', canonical)
    meta('property', 'og:site_name', value.siteName)
    meta('property', 'og:locale', value.locale)
    meta('property', 'og:image', value.image?.url ?? null)
    meta('property', 'og:image:alt', value.image?.alt ?? null)
    // Sin imagen, una tarjeta grande sale con un hueco: se declara la pequeña.
    meta('name', 'twitter:card', value.image ? 'summary_large_image' : 'summary')

    for (const [index, document_] of value.jsonLd.entries()) {
      const script = window.document.createElement('script')
      script.type = 'application/ld+json'
      script.setAttribute(MARK, '')
      script.setAttribute('data-ebim-jsonld', String(index))
      script.textContent = JSON.stringify(document_)
      window.document.head.appendChild(script)
    }

    return () => {
      document.title = previousTitle
      for (const element of document.head.querySelectorAll(`[${MARK}]`)) element.remove()
    }
  }, [fingerprint])
}
