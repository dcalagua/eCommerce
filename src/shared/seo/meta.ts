/**
 * Metadatos de página de la vitrina (P15-SaaS).
 *
 * Todo lo de este archivo es PURO: recibe datos y devuelve la lista de
 * etiquetas que hay que poner en el `<head>`. Ponerlas es trabajo del hook, y
 * son dos archivos a propósito — así lo que se puede equivocar (qué se indexa,
 * qué canonical se declara, qué se le cuenta a un tercero) se comprueba con un
 * test de función y no montando un DOM.
 *
 * Tres reglas que este módulo tiene que conservar:
 *
 *  1. **El tenant sale del dato que ya resolvió el servidor**, nunca de un
 *     parámetro que el navegador declare. Aquí solo entra el `PublicStore` que
 *     `public_stores` devolvió para el slug de la URL.
 *  2. **Lo privado no se indexa.** Carrito, checkout, cuenta y seguimiento de
 *     pedido llevan `noindex`: no aportan nada a un buscador y el último
 *     además lleva un token en la URL.
 *  3. **Lo que no existe no se indexa**. Una SPA responde 200 a todo, así que
 *     una tienda o una ficha que no resuelven serían un «soft 404» que el
 *     buscador acabaría indexando como página vacía. Se marcan `noindex`.
 */

export type RobotsPolicy = 'index' | 'noindex'

export interface OpenGraphImage {
  readonly url: string
  readonly alt: string | null
}

export interface PageMeta {
  readonly title: string
  readonly description: string | null
  /** Ruta absoluta del canonical (sin origen: lo pone el hook). */
  readonly canonicalPath: string
  readonly robots: RobotsPolicy
  readonly ogType: 'website' | 'product' | 'article'
  readonly image: OpenGraphImage | null
  readonly siteName: string
  readonly locale: string
  /** Documentos JSON-LD, ya listos para serializar. */
  readonly jsonLd: readonly Record<string, unknown>[]
}

/** Longitud a la que un buscador corta la descripción. Recortar aquí evita el «…». */
const DESCRIPTION_MAX = 160

export function clampDescription(value: string | null | undefined): string | null {
  const clean = value?.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  if (clean.length <= DESCRIPTION_MAX) return clean
  const cut = clean.slice(0, DESCRIPTION_MAX)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * `<title>` de la vitrina: primero lo específico, después la tienda.
 *
 * En ese orden porque una pestaña estrecha y un resultado de búsqueda cortan
 * por el final: «Silla de roble · Casa Nórdica» sigue siendo útil cortado,
 * «Casa Nórdica · Silla…» no.
 */
export function storeTitle(storeName: string, pageTitle?: string | null): string {
  const page = pageTitle?.trim()
  if (!page || page === storeName.trim()) return storeName.trim()
  return `${page} · ${storeName.trim()}`
}

/**
 * Canonical de la vitrina.
 *
 * La vitrina vive bajo `/s/:slug`, así que el canonical SIEMPRE lleva el slug:
 * es lo que impide que dos tiendas del mismo despliegue compitan por la misma
 * dirección. La cadena de consulta se descarta salvo las claves que cambian el
 * contenido de verdad —hoy solo el filtro de categoría y el de marca—; el
 * término de búsqueda y la ordenación no crean una página nueva, crean la
 * misma página en otro orden, y declararlas multiplicaría el catálogo por sus
 * combinaciones.
 */
const CANONICAL_PARAMS = ['c', 'b'] as const

export function canonicalPath(pathname: string, search?: string | URLSearchParams): string {
  const params = new URLSearchParams(typeof search === 'string' ? search : (search ?? ''))
  const kept = new URLSearchParams()
  for (const key of CANONICAL_PARAMS) {
    const value = params.get(key)
    if (value) kept.set(key, value)
  }
  const query = kept.toString()
  const clean = pathname.replace(/\/+$/, '') || '/'
  return query ? `${clean}?${query}` : clean
}

/** Une el origen con la ruta. Separado para poder probarlo sin `window`. */
export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

/**
 * `Organization` de la tienda. Es lo que permite que un buscador enseñe el
 * nombre y el logo del TENANT y no el del proveedor: en una suite multitenant,
 * un dato de marca cableado sería la marca de otro.
 */
export function organizationJsonLd(input: {
  name: string
  url: string
  logoUrl: string | null
  email: string | null
  phone: string | null
}): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: input.name,
    url: input.url,
  }
  if (input.logoUrl) node.logo = input.logoUrl
  const contact: Record<string, unknown> = {}
  if (input.email) contact.email = input.email
  if (input.phone) contact.telephone = input.phone
  if (Object.keys(contact).length > 0) {
    node.contactPoint = { '@type': 'ContactPoint', contactType: 'customer support', ...contact }
  }
  return node
}

/**
 * `Product` con su oferta.
 *
 * El precio que se declara es el de ESCAPARATE, el mismo que se pinta. No es el
 * que se cobra —eso lo vuelve a decidir la base al confirmar (P04/P10)— y por
 * eso la oferta lleva `priceValidUntil` ausente en vez de inventado: prometerle
 * a un buscador una vigencia que nadie garantiza es peor que no prometer nada.
 */
export function productJsonLd(input: {
  name: string
  description: string | null
  url: string
  imageUrl: string | null
  sku: string | null
  brand: string | null
  price: string | null
  currency: string | null
  inStock: boolean
}): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: input.name,
    url: input.url,
  }
  if (input.description) node.description = input.description
  if (input.imageUrl) node.image = input.imageUrl
  if (input.sku) node.sku = input.sku
  if (input.brand) node.brand = { '@type': 'Brand', name: input.brand }

  if (input.price && input.currency) {
    node.offers = {
      '@type': 'Offer',
      price: input.price,
      priceCurrency: input.currency,
      availability: input.inStock
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      url: input.url,
    }
  }
  return node
}

export function breadcrumbJsonLd(
  items: readonly { name: string; url: string }[],
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  }
}
