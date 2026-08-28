import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { renderWithProviders } from '@/test/render'
import { createFakeSupabase, type FakeSupabase } from '@/test/supabaseMock'

/**
 * El contenido administrable EN LA VITRINA (P11-SaaS).
 *
 * Cuatro propiedades que solo se ven montando el árbol:
 *
 *  1. **sin `content.cms` la vitrina no cambia** — `cms: false` es una
 *     respuesta válida y la portada cae al hero de `store_settings` y al
 *     catálogo, que es lo que pintaba antes de esta fase;
 *  2. **con contenido, el hero del CMS SUSTITUYE al de `store_settings`** — dos
 *     portadas apiladas no son una portada más completa;
 *  3. **el contenido enriquecido se pinta como TEXTO** — un `<script>` guardado
 *     como texto sale como texto, porque no hay ninguna ruta que interprete
 *     HTML;
 *  4. **una página despublicada da «no encontramos esta página»**, la misma
 *     respuesta que una que no existe: distinguirlas le diría a un desconocido
 *     que la tienda tiene algo que hoy no puede ver.
 */

const holder = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/shared/lib/supabase', () => ({
  tryGetSupabaseClient: () => holder.client,
  getSupabaseClient: () => holder.client,
  tryGetStorefrontClient: () => holder.client,
  getStorefrontClient: () => holder.client,
}))

const { StorefrontLayout } = await import('./StorefrontLayout')
const { StoreHomePage } = await import('./StoreHomePage')
const { StoreContentPage } = await import('./StoreContentPage')

const STORE = 'aaaa1111-1111-4111-8111-111111111111'
const BLOCK_HERO = 'bbbb1111-1111-4111-8111-111111111111'
const BLOCK_TEXT = 'bbbb2222-1111-4111-8111-111111111111'
const BLOCK_COLLECTION = 'bbbb3333-1111-4111-8111-111111111111'
const PRODUCT = 'cccc1111-1111-4111-8111-111111111111'

function store() {
  return {
    store_id: STORE,
    slug: 'casa-verde',
    name: 'Casa Verde',
    currency: 'PEN',
    accent_color: '#056769',
    logo_url: null,
    white_label: false,
    default_locale: 'es',
    support_email: null,
    banner_url: null,
    hero_title: 'Hero de ajustes',
    hero_subtitle: 'El de siempre',
    contact_phone: null,
    contact_address: null,
    favicon_url: null,
    font_family: 'serif',
    ui_radius: 'round',
    ui_density: 'compacta',
    business_display_name: 'Casa Verde S.A.C.',
  }
}

const EMPTY_SEARCH = {
  items: [],
  total: 0,
  limit: 24,
  offset: 0,
  sort: 'relevance',
  mode: 'browse',
  query: null,
  facets: {
    categories: [],
    brands: [],
    attributes: [],
    price: { min: null, max: null },
    availability: { in_stock: 0, total: 0 },
  },
}

function content(blocks: unknown[], page: unknown = null) {
  return {
    cms: true,
    store_id: STORE,
    draft: false,
    page: page ?? {
      id: 'dddd1111-1111-4111-8111-111111111111',
      slug: 'inicio',
      title: 'Portada',
      kind: 'home',
      status: 'published',
      seo_title: null,
      seo_description: null,
      og_image_url: null,
    },
    blocks,
  }
}

function heroBlock() {
  return {
    id: BLOCK_HERO,
    type: 'hero',
    position: 0,
    title: 'Rebajas de invierno',
    subtitle: 'Hasta el 40 %',
    body: null,
    media_url: null,
    media_alt: null,
    cta_label: 'Ver ofertas',
    cta_href: '/s/casa-verde?c=abrigos',
    settings: {},
    is_active: true,
    category_id: null,
    campaign: null,
    items: [],
  }
}

function backend(options: { content?: unknown; navigation?: unknown[] } = {}): FakeSupabase {
  return createFakeSupabase({
    tables: {
      public_stores: [store()],
      public_categories: [],
      public_products: [],
      public_product_images: [],
    },
    rpc: {
      catalog_search_for_slug: () => EMPTY_SEARCH,
      catalog_suggest_for_slug: () => [],
      store_navigation_for_slug: () => options.navigation ?? [],
      store_page_for_slug: () =>
        options.content ?? {
          cms: false,
          store_id: STORE,
          page: null,
          blocks: [],
          resolved_at: '2026-08-28T00:00:00.000Z',
        },
    },
  })
}

function renderStorefront(fake: FakeSupabase, route: string) {
  holder.client = fake
  return renderWithProviders(
    <Routes>
      <Route path="/s/:storeSlug" element={<StorefrontLayout />}>
        <Route index element={<StoreHomePage />} />
        <Route path="p/:pageSlug" element={<StoreContentPage />} />
      </Route>
    </Routes>,
    { route },
  )
}

describe('sin el módulo de contenido, la vitrina es la de siempre', () => {
  it('pinta el hero de `store_settings` y ningún bloque', async () => {
    renderStorefront(backend(), '/s/casa-verde')

    expect(
      await screen.findByRole('heading', { name: 'Hero de ajustes', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Rebajas de invierno' })).not.toBeInTheDocument()
  })

  it('una página administrable responde «no encontramos esta página»', async () => {
    renderStorefront(backend(), '/s/casa-verde/p/envios')

    expect(await screen.findByText('No encontramos esta página')).toBeInTheDocument()
  })
})

describe('con contenido publicado', () => {
  it('el hero del CMS SUSTITUYE al de `store_settings`, no se suma', async () => {
    renderStorefront(backend({ content: content([heroBlock()]) }), '/s/casa-verde')

    expect(
      await screen.findByRole('heading', { name: 'Rebajas de invierno', level: 2 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Hero de ajustes' })).not.toBeInTheDocument()
  })

  it('el botón del bloque lleva a donde dice el contenido', async () => {
    renderStorefront(backend({ content: content([heroBlock()]) }), '/s/casa-verde')

    const cta = await screen.findByRole('link', { name: 'Ver ofertas' })
    expect(cta).toHaveAttribute('href', '/s/casa-verde?c=abrigos')
  })

  it('un botón cuyo destino NO pasa la lista blanca no se pinta', async () => {
    const roto = { ...heroBlock(), cta_href: 'javascript:alert(1)' }
    renderStorefront(backend({ content: content([roto]) }), '/s/casa-verde')

    await screen.findByRole('heading', { name: 'Rebajas de invierno', level: 2 })
    // Ni el enlace ni la etiqueta: un botón sin destino es un botón roto.
    expect(screen.queryByText('Ver ofertas')).not.toBeInTheDocument()
  })

  it('el contenido enriquecido se pinta como TEXTO, nunca como marcado', async () => {
    const texto = {
      id: BLOCK_TEXT,
      type: 'rich_text',
      position: 0,
      title: 'Envíos',
      subtitle: null,
      body: [
        { type: 'heading', level: 2, text: 'Cobertura' },
        { type: 'paragraph', text: 'Llegamos a todo el país.' },
        { type: 'list', items: ['Lima en 24 h', 'Provincia en 72 h'] },
      ],
      media_url: null,
      media_alt: null,
      cta_label: null,
      cta_href: null,
      settings: {},
      is_active: true,
      category_id: null,
      campaign: null,
      items: [],
    }
    const { container } = renderStorefront(
      backend({ content: content([texto]) }),
      '/s/casa-verde',
    )

    expect(await screen.findByText('Llegamos a todo el país.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Cobertura', level: 2 })).toBeInTheDocument()
    // La lista sale como una lista de verdad: el renderizador mapea nodo →
    // componente, así que un lector de pantalla la anuncia como tal.
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(within(container).getByText('Lima en 24 h')).toBeInTheDocument()
  })

  it('un documento que NO cumple el contrato no se pinta a medias', async () => {
    const sucio = {
      id: BLOCK_TEXT,
      type: 'rich_text',
      position: 0,
      title: 'Aviso',
      subtitle: null,
      // Guardado por una versión anterior, o por alguien que se saltó el CHECK:
      // el nodo lleva una clave que el vocabulario no declara.
      body: [{ type: 'paragraph', text: 'Hola', onclick: 'robar()' }],
      media_url: null,
      media_alt: null,
      cta_label: null,
      cta_href: null,
      settings: {},
      is_active: true,
      category_id: null,
      campaign: null,
      items: [],
    }
    const { container } = renderStorefront(backend({ content: content([sucio]) }), '/s/casa-verde')

    expect(await screen.findByRole('heading', { name: 'Aviso' })).toBeInTheDocument()
    expect(screen.queryByText('Hola')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain('onclick')
  })

  it('una colección de productos enlaza a cada ficha', async () => {
    const coleccion = {
      id: BLOCK_COLLECTION,
      type: 'product_collection',
      position: 0,
      title: 'Destacados',
      subtitle: null,
      body: null,
      media_url: null,
      media_alt: null,
      cta_label: null,
      cta_href: null,
      settings: { columns: 4 },
      is_active: true,
      category_id: null,
      campaign: null,
      items: [
        {
          kind: 'product',
          product_id: PRODUCT,
          slug: 'manta-lana',
          name: 'Manta de lana',
          brand_name: null,
          price: '180.00',
          compare_at_price: null,
          price_from: '180.00',
          currency: 'PEN',
          in_stock: true,
          image_path: null,
          image_alt: null,
        },
      ],
    }
    renderStorefront(backend({ content: content([coleccion]) }), '/s/casa-verde')

    const card = (await screen.findByText('Manta de lana')).closest('a')
    expect(card).toHaveAttribute('href', '/s/casa-verde/product/manta-lana')
  })

  it('las páginas marcadas para el menú aparecen en la cabecera', async () => {
    renderStorefront(
      backend({ navigation: [{ slug: 'envios', title: 'Envíos y devoluciones' }] }),
      '/s/casa-verde',
    )

    const header = await screen.findByRole('banner')
    expect(within(header).getByRole('link', { name: 'Envíos y devoluciones' })).toHaveAttribute(
      'href',
      '/s/casa-verde/p/envios',
    )
  })
})

describe('white-label: la marca del tenant, no la de casa', () => {
  it('el pie usa el nombre comercial cuando el tenant lo declara', async () => {
    renderStorefront(backend(), '/s/casa-verde')

    const footer = await screen.findByRole('contentinfo')
    expect(within(footer).getByText('© Casa Verde S.A.C.')).toBeInTheDocument()
  })

  it('la densidad de la tienda se aplica a quien llega sin preferencia', async () => {
    renderStorefront(backend(), '/s/casa-verde')
    await screen.findByRole('banner')

    expect(document.documentElement.getAttribute('data-density')).toBe('compacta')
  })
})
