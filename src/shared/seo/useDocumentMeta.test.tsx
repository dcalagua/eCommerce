/**
 * P15-SaaS · el `<head>` de una SPA, que es donde se acumula la basura.
 *
 * Una aplicación de una sola página no recarga el documento: lo que se escribe
 * en el `<head>` sigue ahí cuando se navega. El fallo que este archivo defiende
 * no es cosmético — es que la ficha de un producto AGOTADO acabe declarando
 * `InStock` porque el JSON-LD del producto anterior nunca se retiró, o que lo
 * que se comparte en una red social sea el título de la pantalla de antes.
 *
 * Por eso todo lo que pone el hook lleva `data-ebim-meta` y se retira ENTERO al
 * desmontar, y por eso `meta === null` —«todavía no sé qué página es esto»— no
 * escribe nada: un título provisional es lo que se acaba compartiendo.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PageMeta } from './meta'
import { useDocumentMeta } from './useDocumentMeta'

function meta(overrides: Partial<PageMeta> = {}): PageMeta {
  return {
    title: 'Silla de roble · Casa Verde',
    description: 'Silla maciza de roble.',
    canonicalPath: '/s/casa-verde/product/silla-roble',
    robots: 'index',
    ogType: 'product',
    image: { url: 'https://cdn.example.com/silla.jpg', alt: 'Silla' },
    siteName: 'Casa Verde',
    locale: 'es_PE',
    jsonLd: [{ '@type': 'Product', name: 'Silla de roble' }],
    ...overrides,
  }
}

function Page({ value }: { value: PageMeta | null }) {
  useDocumentMeta(value)
  return null
}

const head = () => document.head
const content = (selector: string) => head().querySelector(selector)?.getAttribute('content')

describe('useDocumentMeta', () => {
  it('escribe título, canonical absoluto, robots, Open Graph y JSON-LD', () => {
    render(<Page value={meta()} />)

    expect(document.title).toBe('Silla de roble · Casa Verde')
    expect(head().querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      `${window.location.origin}/s/casa-verde/product/silla-roble`,
    )
    expect(content('meta[name="robots"]')).toBe('index, follow')
    expect(content('meta[property="og:type"]')).toBe('product')
    expect(content('meta[property="og:site_name"]')).toBe('Casa Verde')
    expect(content('meta[property="og:locale"]')).toBe('es_PE')
    expect(content('meta[name="twitter:card"]')).toBe('summary_large_image')

    const script = head().querySelector('script[type="application/ld+json"]')
    expect(JSON.parse(script?.textContent ?? '{}')).toEqual({
      '@type': 'Product',
      name: 'Silla de roble',
    })
  })

  it('`noindex` viaja SIEMPRE con `nofollow`: esas páginas enlazan a más de lo mismo', () => {
    render(<Page value={meta({ robots: 'noindex' })} />)
    expect(content('meta[name="robots"]')).toBe('noindex, nofollow')
  })

  it('sin imagen se declara la tarjeta pequeña y no queda un `og:image` huérfano', () => {
    render(<Page value={meta({ image: null })} />)
    expect(content('meta[name="twitter:card"]')).toBe('summary')
    expect(head().querySelector('meta[property="og:image"]')).toBeNull()
  })

  it('sin descripción no se escribe la etiqueta, en vez de escribirla vacía', () => {
    render(<Page value={meta({ description: null })} />)
    expect(head().querySelector('meta[name="description"]')).toBeNull()
  })

  it('`null` no toca NADA: un título de esqueleto es lo que se acaba compartiendo', () => {
    const before = document.title
    render(<Page value={null} />)
    expect(document.title).toBe(before)
    expect(head().querySelectorAll('[data-ebim-meta]')).toHaveLength(0)
  })

  /**
   * El caso que da nombre al archivo. Sin la limpieza del `useEffect`, el
   * JSON-LD del producto disponible sobrevive al desmontaje y la ficha
   * siguiente —agotada— sale con DOS documentos, uno de ellos mintiendo.
   */
  it('al desmontar retira todo lo suyo y devuelve el título anterior', () => {
    document.title = 'eCommerce by EBIM'
    const view = render(<Page value={meta()} />)
    expect(head().querySelectorAll('[data-ebim-meta]').length).toBeGreaterThan(0)

    view.unmount()

    expect(document.title).toBe('eCommerce by EBIM')
    expect(head().querySelectorAll('[data-ebim-meta]')).toHaveLength(0)
    expect(head().querySelectorAll('script[type="application/ld+json"]')).toHaveLength(0)
  })

  it('cambiar de página no acumula: un solo canonical y un solo JSON-LD', () => {
    const view = render(<Page value={meta()} />)
    view.rerender(
      <Page
        value={meta({
          title: 'Mesa de nogal · Casa Verde',
          canonicalPath: '/s/casa-verde/product/mesa-nogal',
          jsonLd: [{ '@type': 'Product', name: 'Mesa de nogal' }],
        })}
      />,
    )

    expect(head().querySelectorAll('link[rel="canonical"]')).toHaveLength(1)
    expect(head().querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      `${window.location.origin}/s/casa-verde/product/mesa-nogal`,
    )
    const scripts = head().querySelectorAll('script[type="application/ld+json"]')
    expect(scripts).toHaveLength(1)
    expect(JSON.parse(scripts[0]?.textContent ?? '{}').name).toBe('Mesa de nogal')
  })

  it('un render que no cambia el valor no reescribe el `<head>`', () => {
    const view = render(<Page value={meta()} />)
    const canonical = head().querySelector('link[rel="canonical"]')
    // Mismo contenido, objeto nuevo: es lo que devuelve un `homeMeta()` en cada
    // render. Si el hook comparase por identidad, aquí habría un nodo distinto.
    view.rerender(<Page value={meta()} />)
    expect(head().querySelector('link[rel="canonical"]')).toBe(canonical)
  })
})
