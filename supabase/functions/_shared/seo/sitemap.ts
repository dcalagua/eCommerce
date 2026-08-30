/**
 * Sitemap y robots POR TIENDA (P15-SaaS).
 *
 * TypeScript puro, sin SDK y sin `Deno`: el borde solo lo cablea. Así lo que
 * puede salir mal —que se publique la URL de una tienda que no está activa, que
 * un slug con `&` rompa el XML, que el sitemap crezca sin techo— se comprueba
 * con un test de función.
 *
 * ## Por qué se genera y no se sube un archivo
 *
 * Un `sitemap.xml` estático describe un sitio; aquí hay **una aplicación y N
 * tiendas**, cada una con su catálogo y su ritmo de publicación. Un archivo
 * commiteado estaría viejo el día que un tenant publica un producto, y no habría
 * forma de generarlo en el build: en tiempo de build no existen ni las tiendas.
 * Se genera a la carta, desde las MISMAS vistas públicas que ve un comprador
 * anónimo —`public_stores`, `public_products`— con el cliente anónimo.
 *
 * Esa última decisión es la importante: la función **no usa `service_role`**.
 * Si lo hiciera, un fallo aquí publicaría en un buscador el catálogo sin
 * publicar de un tenant. Al leer con `anon`, lo que este archivo puede llegar a
 * enseñar es exactamente lo que ya enseña la vitrina, ni una fila más: la
 * autoridad sigue siendo la RLS.
 */

/** Techo de URLs por sitemap. El estándar admite 50 000; se corta antes. */
export const SITEMAP_MAX_URLS = 5_000

export interface SitemapEntry {
  readonly path: string
  readonly lastModified?: string | null
  readonly changeFrequency?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
  readonly priority?: number
}

export interface SitemapInput {
  /** Origen ya validado, sin barra final. */
  readonly origin: string
  readonly storeSlug: string
  readonly products: readonly { slug: string; published_at?: string | null }[]
  readonly pages: readonly { slug: string }[]
}

/** Escapa lo que XML no admite dentro de un nodo de texto. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * `lastmod` en la forma que pide el estándar (`W3C Datetime`).
 *
 * Una fecha que no se puede leer se OMITE en vez de inventarse: un `lastmod` de
 * hoy sobre un producto de hace dos años le dice al rastreador que vuelva por
 * algo que no ha cambiado, y hace lo contrario de lo que se quiere.
 */
export function toLastMod(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

/**
 * Un origen solo se acepta si es `https` (o `http` en local). El origen llega
 * de la cabecera de la petición, que la escribe el cliente: sin esta
 * comprobación, cualquiera podría hacer que el sitemap de un tenant apuntase a
 * su propio dominio.
 */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return null
  }
  return url.origin
}

/** Slug válido de la vitrina. Lo que no lo sea no entra en el XML. */
export function isSafeSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value) && value.length <= 200
}

export function storeEntries(input: SitemapInput): SitemapEntry[] {
  const base = `/s/${input.storeSlug}`
  const entries: SitemapEntry[] = [
    { path: base, changeFrequency: 'daily', priority: 1 },
  ]

  for (const page of input.pages) {
    if (!isSafeSlug(page.slug)) continue
    entries.push({ path: `${base}/p/${page.slug}`, changeFrequency: 'weekly', priority: 0.6 })
  }

  for (const product of input.products) {
    if (!isSafeSlug(product.slug)) continue
    entries.push({
      path: `${base}/product/${product.slug}`,
      lastModified: toLastMod(product.published_at),
      changeFrequency: 'weekly',
      priority: 0.8,
    })
  }

  // El carrito, el checkout, la cuenta y el seguimiento NO aparecen aquí, y no
  // por olvido: son las mismas cuatro rutas que llevan `noindex` en la
  // aplicación y `Disallow` en `robots.txt`. Anunciarlas en el sitemap sería
  // pedirle al rastreador justo lo que las otras dos señales le niegan.
  return entries.slice(0, SITEMAP_MAX_URLS)
}

export function renderSitemap(input: SitemapInput): string {
  const origin = input.origin.replace(/\/+$/, '')
  const urls = storeEntries(input)
    .map((entry) => {
      const parts = [`    <loc>${escapeXml(`${origin}${entry.path}`)}</loc>`]
      if (entry.lastModified) parts.push(`    <lastmod>${entry.lastModified}</lastmod>`)
      if (entry.changeFrequency) parts.push(`    <changefreq>${entry.changeFrequency}</changefreq>`)
      if (entry.priority !== undefined) parts.push(`    <priority>${entry.priority}</priority>`)
      return `  <url>\n${parts.join('\n')}\n  </url>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

/**
 * `robots.txt` de una tienda. El del origen (`public/robots.txt`) cubre el
 * despliegue entero; este añade el `Sitemap:` de ESTA tienda, que es lo único
 * que no se puede escribir de antemano.
 */
export function renderRobots(input: { origin: string; storeSlug: string }): string {
  const origin = input.origin.replace(/\/+$/, '')
  return [
    'User-agent: *',
    `Disallow: /s/${input.storeSlug}/cart`,
    `Disallow: /s/${input.storeSlug}/checkout`,
    `Disallow: /s/${input.storeSlug}/account`,
    `Disallow: /s/${input.storeSlug}/order/`,
    'Allow: /',
    '',
    `Sitemap: ${origin}/s/${input.storeSlug}/sitemap.xml`,
    '',
  ].join('\n')
}
