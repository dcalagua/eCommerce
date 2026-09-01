import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/shared/i18n/I18nProvider'
import { AppearanceProvider } from '@/theme/AppearanceProvider'
import { DEFAULT_APPEARANCE } from '@/theme/appearance'
import { StoreCategoryNav } from './components/StoreCategoryNav'
import type { PublicCategory } from './types'

/**
 * La barra de familias de la cabecera.
 *
 * Estaba a media portada: para cambiar de familia había que volver arriba, y
 * desde una ficha de producto no había forma de llegar. Aquí se fija lo que la
 * hace útil y no un adorno:
 *
 *  · sale en la cabecera, con las familias de PRIMER nivel;
 *  · una familia con hijas abre su panel en vez de navegar a una pantalla
 *    intermedia que solo lista más categorías;
 *  · desde el panel se entra a la subcategoría en UN clic, y también a la
 *    familia entera —que es lo que no se puede pedir desde la lista de hijas—;
 *  · el panel se cierra con Escape: uno que solo se cierre volviendo a pulsar
 *    su pestaña es una trampa con el teclado.
 */

const STORE = 'aaaa1111-1111-4111-8111-111111111111'

function categoria(over: Partial<PublicCategory> & { slug: string; name: string }): PublicCategory {
  return {
    category_id: `id-${over.slug}`,
    store_id: STORE,
    parent_id: null,
    position: 0,
    ...over,
  } as PublicCategory
}

const ARBOL: PublicCategory[] = [
  categoria({ slug: 'medicamentos', name: 'Medicamentos' }),
  categoria({ slug: 'nutricion', name: 'Nutrición' }),
  categoria({
    slug: 'antiinfecciosos',
    name: 'Antiinfecciosos',
    parent_id: 'id-medicamentos',
  }),
  categoria({
    slug: 'dermatologicos',
    name: 'Dermatológicos',
    parent_id: 'id-medicamentos',
  }),
]

function pintar(categories: PublicCategory[] = ARBOL) {
  return render(
    <I18nProvider initial="es">
      <AppearanceProvider initial={DEFAULT_APPEARANCE} tenantAccent={null}>
        <MemoryRouter initialEntries={['/s/miquimica']}>
          <StoreCategoryNav storeSlug="miquimica" categories={categories} />
        </MemoryRouter>
      </AppearanceProvider>
    </I18nProvider>,
  )
}

describe('la barra de familias de la cabecera', () => {
  it('enseña las familias de primer nivel, no el catálogo de categorías entero', () => {
    pintar()

    const nav = screen.getByRole('navigation', { name: 'Categorías' })
    expect(within(nav).getByRole('button', { name: /Medicamentos/ })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: /Nutrición/ })).toBeInTheDocument()
    // Las hijas NO están en la barra: para eso está el panel.
    expect(within(nav).queryByText('Antiinfecciosos')).not.toBeInTheDocument()
  })

  it('una familia sin hijas es un enlace directo; con hijas, abre su panel', async () => {
    const user = userEvent.setup()
    pintar()

    // Sin hijas: no hay panel que abrir, así que navega y punto.
    expect(screen.getByRole('link', { name: /Nutrición/ })).toHaveAttribute(
      'href',
      '/s/miquimica?c=nutricion',
    )

    await user.click(screen.getByRole('button', { name: /Medicamentos/ }))

    expect(screen.getByRole('link', { name: 'Antiinfecciosos' })).toHaveAttribute(
      'href',
      '/s/miquimica?c=antiinfecciosos',
    )
    expect(screen.getByRole('link', { name: 'Dermatológicos' })).toBeInTheDocument()
    // Y la familia entera, para quien busca «algo de esto» sin saber cuál.
    expect(screen.getByRole('link', { name: 'Ver toda la familia' })).toHaveAttribute(
      'href',
      '/s/miquimica?c=medicamentos',
    )
  })

  it('el panel se cierra con Escape', async () => {
    const user = userEvent.setup()
    pintar()

    await user.click(screen.getByRole('button', { name: /Medicamentos/ }))
    expect(screen.getByRole('link', { name: 'Antiinfecciosos' })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('link', { name: 'Antiinfecciosos' })).not.toBeInTheDocument()
  })

  it('sin categorías no pinta nada: una barra vacía es una franja sin sentido', () => {
    const { container } = pintar([])

    expect(container).toBeEmptyDOMElement()
  })
})
