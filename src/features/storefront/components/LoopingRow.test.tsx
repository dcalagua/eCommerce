import { createEvent, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { LoopingRow } from './LoopingRow'

/**
 * La fila que gira sola, y el clic que se comía.
 *
 * `setPointerCapture` estaba en `pointerdown`. Con la captura puesta, el
 * navegador dirige el `click` al elemento que capturó —la pista— en vez de al
 * que hay debajo, así que el enlace de dentro no lo recibía nunca: con ratón no
 * se podía entrar a ninguna categoría, marca ni producto de estas filas. Con el
 * dedo sí funcionaba, porque el táctil sale antes por el filtro de tipo de
 * puntero, y eso hacía que el fallo pareciera cosa del navegador.
 *
 * jsdom no implementa esa redirección, así que aquí no se puede comprobar el
 * síntoma: se comprueba la CAUSA —cuándo se captura el puntero—, que es lo que
 * de verdad se arregló.
 */

const ENLACES = [
  { id: 'a', label: 'Cuidado personal' },
  { id: 'b', label: 'Nutrición' },
]

const puntero = {
  capturar: vi.fn(),
  tiene: vi.fn(() => false),
  soltar: vi.fn(),
}

beforeEach(() => {
  // jsdom no trae la API de captura de puntero. Se declara aquí, y que hiciera
  // falta declararla dice cuánto se había probado este camino: con la versión
  // anterior, un solo `pointerdown` reventaba.
  puntero.capturar = vi.fn()
  puntero.tiene = vi.fn(() => false)
  puntero.soltar = vi.fn()
  HTMLElement.prototype.setPointerCapture = puntero.capturar
  HTMLElement.prototype.hasPointerCapture = puntero.tiene
  HTMLElement.prototype.releasePointerCapture = puntero.soltar
})

function pintar() {
  renderWithProviders(
    <LoopingRow
      items={ENLACES}
      keyOf={(item) => item.id}
      itemWidth={200}
      ariaLabel="Por categoría"
      render={(item) => <a href={`/s/tienda?c=${item.id}`}>{item.label}</a>}
    />,
  )
}

/** La pista: es quien lleva los manejadores del puntero. */
function pista(): HTMLElement {
  return screen.getByRole('group', { name: 'Por categoría' })
}

/**
 * Un evento de puntero de verdad.
 *
 * jsdom no trae `PointerEvent`, y `fireEvent.pointerDown` acaba creando un
 * evento sin `pointerType`. El componente filtra justo por ese campo, así que
 * sin ponerlo a mano el manejador salía por la puerta de «esto no es un ratón»
 * y el test comprobaba un camino que nunca se recorre.
 */
function puntero_(tipo: string, nombre: string, nodo: HTMLElement, init: Record<string, unknown>) {
  const evento = createEvent[nombre as 'pointerDown'](nodo, init)
  Object.assign(evento, { pointerType: tipo, ...init })
  fireEvent(nodo, evento)
}

const raton = (nombre: string, nodo: HTMLElement, init: Record<string, unknown> = {}) =>
  puntero_('mouse', nombre, nodo, { pointerId: 1, ...init })

describe('LoopingRow — el clic llega al enlace', () => {
  it('un clic SIN arrastre no captura el puntero', async () => {
    const user = userEvent.setup()
    pintar()

    await user.click(screen.getAllByText('Cuidado personal')[0]!)

    // Ni una vez: capturar aquí es exactamente lo que le robaba el clic al
    // enlace de debajo.
    expect(puntero.capturar).not.toHaveBeenCalled()
  })

  it('pasado el umbral SÍ captura: un arrastre de verdad no se suelta a medias', () => {
    pintar()
    const nodo = pista()

    raton('pointerDown', nodo, { clientX: 100 })
    // Un píxel no es un arrastre: sigue siendo un clic tembloroso.
    raton('pointerMove', nodo, { clientX: 101 })
    expect(puntero.capturar).not.toHaveBeenCalled()

    // Cuarenta sí lo son.
    raton('pointerMove', nodo, { clientX: 140 })
    expect(puntero.capturar).toHaveBeenCalledWith(1)
  })

  it('un arrastre de ratón no deja marcado el siguiente toque con el dedo', () => {
    pintar()
    const nodo = pista()

    // Arrastre largo con el ratón: deja el contador de recorrido alto.
    raton('pointerDown', nodo, { clientX: 100 })
    raton('pointerMove', nodo, { clientX: 300 })
    raton('pointerUp', nodo, {})

    // Y ahora un toque. El contador tiene que estar a cero, o la guarda de
    // `onClickCapture` se comería este clic sin que nadie haya arrastrado.
    puntero_('touch', 'pointerDown', nodo, { pointerId: 2, clientX: 100 })

    const enlace = screen.getAllByText('Nutrición')[0]!
    const evento = new MouseEvent('click', { bubbles: true, cancelable: true })
    enlace.dispatchEvent(evento)

    expect(evento.defaultPrevented).toBe(false)
  })
})
