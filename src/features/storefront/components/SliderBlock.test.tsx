import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/test/render'
import type { ContentBlock } from '../content'
import { SliderBlock } from './SliderBlock'

/**
 * El carrusel de la portada.
 *
 * Es lo primero que ve el comprador y lo unico de la portada que se mueve solo,
 * asi que lo que se prueba es lo que puede salir mal en una pantalla real: que
 * solo se vea UNA diapositiva —si se pintan todas, las ocultas siguen siendo
 * tabulables y el lector de pantalla las lee—, que el destino de cada imagen se
 * vuelva a comprobar aqui aunque la base ya lo haya validado, y que no se pinte
 * nada cuando el comercio todavia no ha subido ninguna.
 */

const ASSETS = {
  'org/store/content/verano.jpg': 'https://firmado.test/verano.jpg',
  'org/store/content/envio.jpg': 'https://firmado.test/envio.jpg',
}

function slide(path: string, alt: string, href: string | null = null) {
  return { kind: 'media' as const, image_path: path, image_alt: alt, href }
}

function block(items: ReturnType<typeof slide>[], settings: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    blockType: 'slider',
    title: 'Campañas',
    subtitle: null,
    body: null,
    mediaUrl: null,
    mediaAlt: null,
    ctaLabel: null,
    ctaHref: null,
    settings,
    items,
    promotion: null,
  } as unknown as ContentBlock
}

/**
 * El mosaico: la MISMA lista de imágenes, todas a la vez.
 *
 * Es lo que se pide cuando las piezas compiten —dos marcas, dos campañas— y hay
 * que compararlas de un vistazo. Lo que se fija aquí es que sea de verdad la
 * misma lista con otra disposición: no otro bloque, no otra carga de imágenes.
 */
describe('mosaico de imágenes', () => {
  const MOSAICO = { layout: 'grid', columns: 2 }

  it('las enseña TODAS a la vez, no una', () => {
    renderWithProviders(
      <SliderBlock
        block={block(
          [
            slide('org/store/content/verano.jpg', 'Rebajas de verano'),
            slide('org/store/content/envio.jpg', 'Envío gratis'),
          ],
          MOSAICO,
        )}
        assets={ASSETS}
      />,
    )

    expect(screen.getByRole('img', { name: 'Rebajas de verano' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Envío gratis' })).toBeInTheDocument()
  })

  it('no hay flechas ni puntos: no hay nada escondido que buscar', () => {
    renderWithProviders(
      <SliderBlock
        block={block(
          [
            slide('org/store/content/verano.jpg', 'Rebajas de verano'),
            slide('org/store/content/envio.jpg', 'Envío gratis'),
          ],
          MOSAICO,
        )}
        assets={ASSETS}
      />,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('cada pieza conserva su enlace y sigue sin recortarse', () => {
    renderWithProviders(
      <SliderBlock
        block={block(
          [slide('org/store/content/verano.jpg', 'Rebajas', '/categoria/vitaminas')],
          MOSAICO,
        )}
        assets={ASSETS}
      />,
    )

    expect(screen.getByRole('link', { name: 'Rebajas' })).toHaveAttribute(
      'href',
      '/categoria/vitaminas',
    )
    expect(screen.getByRole('img', { name: 'Rebajas' })).toHaveStyle({ objectFit: 'contain' })
  })

  it('sin imágenes tampoco pinta nada', () => {
    const { container } = renderWithProviders(
      <SliderBlock block={block([], MOSAICO)} assets={ASSETS} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('carrusel de imágenes de la portada', () => {
  it('enseña una sola diapositiva: las demás no están en la página', () => {
    renderWithProviders(
      <SliderBlock
        block={block([
          slide('org/store/content/verano.jpg', 'Rebajas de verano'),
          slide('org/store/content/envio.jpg', 'Envío gratis'),
        ])}
        assets={ASSETS}
      />,
    )

    expect(screen.getByRole('img', { name: 'Rebajas de verano' })).toBeInTheDocument()
    // Ocultarla con CSS no bastaría: seguiría siendo tabulable y el lector de
    // pantalla la leería como si estuviera a la vista.
    expect(screen.queryByRole('img', { name: 'Envío gratis' })).not.toBeInTheDocument()
  })

  it('la flecha avanza, y desde la última vuelve a la primera', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <SliderBlock
        block={block([
          slide('org/store/content/verano.jpg', 'Rebajas de verano'),
          slide('org/store/content/envio.jpg', 'Envío gratis'),
        ])}
        assets={ASSETS}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(screen.getByRole('img', { name: 'Envío gratis' })).toBeInTheDocument()

    // Da la vuelta en vez de quedarse clavada: un carrusel que se acaba deja al
    // comprador delante de una flecha que ya no hace nada.
    await user.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(screen.getByRole('img', { name: 'Rebajas de verano' })).toBeInTheDocument()
  })

  it('una diapositiva con destino interno es un enlace de la propia tienda', () => {
    renderWithProviders(
      <SliderBlock
        block={block([
          slide('org/store/content/verano.jpg', 'Rebajas', '/categoria/vitaminas'),
        ])}
        assets={ASSETS}
      />,
    )

    const enlace = screen.getByRole('link', { name: 'Rebajas' })
    expect(enlace).toHaveAttribute('href', '/categoria/vitaminas')
    // Interno: sin `target`, para no partir la navegación de la tienda.
    expect(enlace).not.toHaveAttribute('target')
  })

  it('un destino que no pasa la lista blanca deja la imagen SIN enlace', () => {
    renderWithProviders(
      <SliderBlock
        block={block([
          slide('org/store/content/verano.jpg', 'Rebajas', 'javascript:alert(1)'),
        ])}
        assets={ASSETS}
      />,
    )

    // La base ya lo rechaza, pero la vitrina pinta lo que le llega por red: si
    // alguna vez llegara, la imagen se enseña y el destino se tira.
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Rebajas' })).toBeInTheDocument()
  })

  /**
   * El caso que lo destapó: el comercio subió un banner compuesto —caja del
   * producto, precio y titular dentro de la propia imagen— y `cover` se comía
   * el titular por los lados. Un banner recortado esconde justo lo que anuncia.
   */
  it('la imagen se ve ENTERA: el carrusel no recorta', () => {
    renderWithProviders(
      <SliderBlock
        block={block([slide('org/store/content/verano.jpg', 'Rebajas')])}
        assets={ASSETS}
      />,
    )

    const imagen = screen.getByRole('img', { name: 'Rebajas' })
    expect(imagen).toHaveStyle({ objectFit: 'contain' })
    // Centrada: sin esto el hueco sobrante se acumula a un lado.
    expect(imagen).toHaveStyle({ objectPosition: 'center' })
  })

  it('sin diapositivas no pinta nada: mejor eso que una franja gris vacía', () => {
    const { container } = renderWithProviders(<SliderBlock block={block([])} assets={ASSETS} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('con una sola no ofrece flechas ni puntos: no hay a dónde ir', () => {
    renderWithProviders(
      <SliderBlock
        block={block([slide('org/store/content/verano.jpg', 'Rebajas')])}
        assets={ASSETS}
      />,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('los puntos dicen cuántas hay y en cuál se está', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <SliderBlock
        block={block([
          slide('org/store/content/verano.jpg', 'Rebajas de verano'),
          slide('org/store/content/envio.jpg', 'Envío gratis'),
        ])}
        assets={ASSETS}
      />,
    )

    const carrusel = screen.getByRole('region', { name: 'Campañas' })
    expect(within(carrusel).getByRole('button', { name: 'Ir a la imagen 1' })).toHaveAttribute(
      'aria-current',
      'true',
    )

    await user.click(screen.getByRole('button', { name: 'Ir a la imagen 2' }))
    expect(screen.getByRole('img', { name: 'Envío gratis' })).toBeInTheDocument()
  })
})
