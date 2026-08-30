// @vitest-environment node
/**
 * P15-SaaS · el `sitemap.xml` y el `robots.txt` de UNA tienda, sin base de datos.
 *
 * Aquí no hay Postgres: `_shared/seo/sitemap.ts` es TypeScript puro y el borde
 * (`functions/storefront-seo`) solo lo cablea. Lo que se comprueba es
 * exactamente lo que puede salir mal en una suite multitenant cuando el
 * artefacto que se genera es PÚBLICO y lo consume un robot:
 *
 *  1. **El origen no se cree.** Llega de la cabecera de la petición, que la
 *     escribe el cliente. Sin validarlo, cualquiera podría hacer que el sitemap
 *     de un tenant anunciara las URLs de otro dominio.
 *  2. **Lo que no es un slug no entra en el XML.** Un valor con `&`, `<` o una
 *     ruta relativa dentro rompería el documento o lo convertiría en un vector.
 *  3. **Las cuatro rutas privadas no se anuncian.** Son las mismas que llevan
 *     `noindex` en la aplicación y `Disallow` en `robots.txt`: anunciarlas en el
 *     sitemap le pediría al rastreador justo lo que las otras dos señales le
 *     niegan.
 *  4. **Hay techo.** Un catálogo grande no puede generar un documento sin
 *     límite.
 */
import { describe, expect, it } from 'vitest'
import {
  SITEMAP_MAX_URLS,
  escapeXml,
  isSafeSlug,
  normalizeOrigin,
  renderRobots,
  renderSitemap,
  storeEntries,
  toLastMod,
} from '../functions/_shared/seo/sitemap.ts'

const base = {
  origin: 'https://casaverde.pe',
  storeSlug: 'casa-verde',
  products: [{ slug: 'silla-roble', published_at: '2026-03-01T10:00:00.000Z' }],
  pages: [{ slug: 'envios' }],
}

describe('el origen se valida, no se acepta', () => {
  it('acepta `https` y el local, que es donde se desarrolla', () => {
    expect(normalizeOrigin('https://casaverde.pe')).toBe('https://casaverde.pe')
    expect(normalizeOrigin('https://casaverde.pe/s/casa-verde')).toBe('https://casaverde.pe')
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
  })

  it.each([
    ['nada', null],
    ['vacío', ''],
    ['sin esquema', 'casaverde.pe'],
    ['http remoto', 'http://casaverde.pe'],
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
  ])('rechaza %s', (_caso, value) => {
    expect(normalizeOrigin(value)).toBeNull()
  })
})

describe('solo entra lo que es un slug', () => {
  it.each(['silla-roble', 'silla', 'a1-b2-c3'])('acepta %s', (value) => {
    expect(isSafeSlug(value)).toBe(true)
  })

  it.each([
    'silla roble',
    'silla/roble',
    '../../etc/passwd',
    'silla&roble',
    '<script>',
    '-silla',
    'silla-',
    '',
  ])('rechaza %s', (value) => {
    expect(isSafeSlug(value)).toBe(false)
  })

  it('rechaza lo que ni siquiera es una cadena', () => {
    expect(isSafeSlug(null)).toBe(false)
    expect(isSafeSlug(42)).toBe(false)
    expect(isSafeSlug({ slug: 'silla' })).toBe(false)
  })

  it('un producto con slug inválido se OMITE, no rompe el documento entero', () => {
    const entries = storeEntries({
      ...base,
      products: [{ slug: 'silla & mesa' }, { slug: 'silla-roble' }],
    })
    const paths = entries.map((entry) => entry.path)
    expect(paths).toContain('/s/casa-verde/product/silla-roble')
    expect(paths.some((path) => path.includes('&'))).toBe(false)
  })
})

describe('la fecha se omite cuando no se puede leer, en vez de inventarse', () => {
  it('normaliza a `W3C Datetime`', () => {
    expect(toLastMod('2026-03-01T10:00:00.000Z')).toBe('2026-03-01')
  })

  it.each([null, undefined, '', 'ayer', 'no-es-una-fecha'])('omite %s', (value) => {
    expect(toLastMod(value)).toBeNull()
  })
})

describe('el sitemap de una tienda', () => {
  it('empieza por la portada y lleva su catálogo y sus páginas, todo bajo su slug', () => {
    const paths = storeEntries(base).map((entry) => entry.path)
    expect(paths).toEqual([
      '/s/casa-verde',
      '/s/casa-verde/p/envios',
      '/s/casa-verde/product/silla-roble',
    ])
  })

  it('NO anuncia carrito, checkout, cuenta ni seguimiento', () => {
    const xml = renderSitemap(base)
    for (const privada of ['/cart', '/checkout', '/account', '/order/']) {
      expect(xml).not.toContain(privada)
    }
  })

  it('tiene techo: un catálogo grande no genera un documento sin límite', () => {
    const muchos = Array.from({ length: SITEMAP_MAX_URLS + 500 }, (_, index) => ({
      slug: `producto-${index}`,
    }))
    expect(storeEntries({ ...base, products: muchos, pages: [] })).toHaveLength(SITEMAP_MAX_URLS)
  })

  it('sale un XML bien formado, con el origen ya unido y sin barra duplicada', () => {
    const xml = renderSitemap({ ...base, origin: 'https://casaverde.pe/' })
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<loc>https://casaverde.pe/s/casa-verde</loc>')
    expect(xml).not.toContain('https://casaverde.pe//')
    expect(xml).toContain('<lastmod>2026-03-01</lastmod>')
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true)
    // Tantas aperturas como cierres: si una entrada se escapara a medias, esto
    // dejaría de cuadrar antes de que lo notara un rastreador.
    expect(xml.match(/<url>/g)).toHaveLength(3)
    expect(xml.match(/<\/url>/g)).toHaveLength(3)
  })

  it('escapa lo que XML no admite', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
  })
})

describe('el robots de una tienda', () => {
  const robots = renderRobots({ origin: 'https://casaverde.pe', storeSlug: 'casa-verde' })

  it('apunta al sitemap de ESA tienda', () => {
    expect(robots).toContain('Sitemap: https://casaverde.pe/s/casa-verde/sitemap.xml')
  })

  it('prohíbe las mismas cuatro rutas que llevan `noindex` en la aplicación', () => {
    for (const privada of ['cart', 'checkout', 'account', 'order/']) {
      expect(robots).toContain(`Disallow: /s/casa-verde/${privada}`)
    }
  })

  it('no prohíbe las rutas de OTRA tienda: cada una habla de la suya', () => {
    expect(robots).not.toContain('/s/otra-tienda')
  })
})
