import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { RichTextDocument } from '@/domain/content'
import { renderWithProviders } from '@/test/render'
import { RichTextEditor } from './RichTextEditor'

/**
 * El editor de contenido, sobre TipTap.
 *
 * Lo que se prueba aquí NO es TipTap —está probado en su repositorio— sino la
 * frontera, que es lo único de casa: que lo que sale del editor sea el
 * documento del dominio y que la barra ofrezca exactamente lo que la base sabe
 * guardar. Si algún día se cambia de paquete, estas pruebas son las que dicen
 * si el cambio es transparente para el contenido publicado.
 *
 * La traducción nodo a nodo vive en `content.test.ts`, que la ejercita sin
 * montar el editor.
 */
function Harness({ initial = null }: { initial?: RichTextDocument | null }) {
  const [value, setValue] = useState<RichTextDocument | null>(initial)
  return (
    <>
      <RichTextEditor label="Contenido" value={value} onChange={setValue} />
      {/* El documento que se guardaría, a la vista de la prueba. */}
      <pre data-testid="doc">{JSON.stringify(value)}</pre>
    </>
  )
}

const doc = (): RichTextDocument | null => JSON.parse(screen.getByTestId('doc').textContent || 'null')

describe('Editor de contenido enriquecido', () => {
  it('pinta el contenido con las piezas de la vitrina: un titular es un h2', async () => {
    renderWithProviders(
      <Harness
        initial={[
          { type: 'heading', level: 2, text: 'Un taller pequeno' },
          { type: 'paragraph', text: 'Trabajamos madera maciza.' },
        ]}
      />,
    )

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Un taller pequeno' }),
    ).toBeInTheDocument()
  })

  it('la barra convierte el bloque del cursor en titular', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={[{ type: 'paragraph', text: 'El taller' }]} />)

    await user.click(screen.getByLabelText('Contenido'))
    await user.click(screen.getByRole('button', { name: 'Titular' }))

    await waitFor(() => expect(doc()).toEqual([{ type: 'heading', level: 2, text: 'El taller' }]))
  })

  it('la negrita sale como marca del dominio, no como una etiqueta', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={[{ type: 'paragraph', text: 'Envíos gratis' }]} />)

    const surface = screen.getByLabelText('Contenido')
    await user.click(surface)
    await user.keyboard('{Control>}a{/Control}')
    await user.click(screen.getByRole('button', { name: 'Negrita' }))

    await waitFor(() =>
      expect(doc()).toEqual([
        { type: 'paragraph', text: [{ text: 'Envíos gratis', bold: true }] },
      ]),
    )
  })

  it('la lista numerada es un nodo de lista con `ordered`, no otra cosa', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={[{ type: 'paragraph', text: 'Roble' }]} />)

    await user.click(screen.getByLabelText('Contenido'))
    await user.click(screen.getByRole('button', { name: 'Lista numerada' }))

    await waitFor(() =>
      expect(doc()).toEqual([{ type: 'list', items: ['Roble'], ordered: true }]),
    )
  })

  it('el separador es un nodo, y no lleva nada dentro', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={[{ type: 'paragraph', text: 'Arriba' }]} />)

    await user.click(screen.getByLabelText('Contenido'))
    await user.click(screen.getByRole('button', { name: 'Separador' }))

    await waitFor(() => expect(doc()).toContainEqual({ type: 'divider' }))
  })

  it('un enlace se comprueba ANTES de entrar en el documento', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={[{ type: 'paragraph', text: 'Ver zonas' }]} />)

    const surface = screen.getByLabelText('Contenido')
    await user.click(surface)
    await user.keyboard('{Control>}a{/Control}')
    await user.click(screen.getByRole('button', { name: 'Enlace' }))

    const field = await screen.findByLabelText('Destino del enlace')
    await user.type(field, 'javascript:alert(1)')

    // El destino ejecutable no se puede confirmar: el guard es el mismo que el
    // CHECK de la base, no una lista negra escrita en el formulario.
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
  })

  it('una etiqueta escrita a mano se avisa AL ESCRIBIRLA, no al guardar', async () => {
    renderWithProviders(<Harness initial={[{ type: 'paragraph', text: '<b>oferta</b>' }]} />)

    expect(await screen.findByText(/etiquetas HTML|no se admiten/i)).toBeInTheDocument()
  })
})
