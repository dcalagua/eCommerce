import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { TextField } from '@mui/material'
import { describe, expect, it } from 'vitest'
import { createEbimTheme } from './createEbimTheme'
import { DEFAULT_APPEARANCE } from './appearance'

/**
 * La etiqueta de un campo nunca se cruza con su valor.
 *
 * MUI levanta la etiqueta cuando el campo está enfocado o «relleno», y ese
 * «relleno» lo marca el `<input>` al recibir un evento de cambio. Cuando el
 * valor lo escribe el código —el `slug` que sale solo del nombre, el SKU
 * sugerido de una variante, el código de un cliente— React Hook Form lo mete
 * directo en el nodo del DOM y ese evento no llega: el campo tiene texto, MUI
 * cree que está vacío y la etiqueta se queda ENCIMA del valor. Se leen los dos
 * superpuestos y no se entiende ninguno.
 *
 * Se arregló en el tema y no campo por campo, así que se comprueba en el tema:
 * un test por formulario sería volver al problema, que era justo tener que
 * acordarse en cada uno.
 */

const TEMA = createEbimTheme({ ...DEFAULT_APPEARANCE, tenantAccent: null })

function pintar(ui: React.ReactNode) {
  return render(<ThemeProvider theme={TEMA}>{ui}</ThemeProvider>)
}

describe('la etiqueta de los campos', () => {
  it('está arriba aunque el campo esté vacío: no puede caer sobre un valor que llegue después', () => {
    const { container } = pintar(<TextField label="Slug" />)

    // El `<label>` y no cualquier texto: la leyenda del borde repite la misma
    // palabra, y es justo la que abre el hueco.
    // `MuiInputLabel-shrink` es la clase que la sube. Sin ella, la etiqueta se
    // dibuja centrada sobre el hueco donde va el texto.
    expect(container.querySelector('label')).toHaveClass('MuiInputLabel-shrink')
  })

  it('el borde deja el hueco para la etiqueta: si no, la línea la atraviesa', () => {
    const { container } = pintar(<TextField label="Slug" />)

    // La leyenda del `fieldset` es el hueco. Vacía —sin `notched`— la etiqueta
    // flotante queda cruzada por el borde del recuadro.
    const leyenda = container.querySelector('fieldset legend')
    expect(leyenda).not.toBeNull()
    expect(leyenda?.textContent).toContain('Slug')
  })

  it('un campo que pide lo contrario sigue mandando sobre el tema', () => {
    const { container } = pintar(
      <TextField label="Buscar" slotProps={{ inputLabel: { shrink: false } }} />,
    )

    expect(container.querySelector('label')).not.toHaveClass('MuiInputLabel-shrink')
  })

  it('el valor escrito por el código convive con la etiqueta, no debajo de ella', () => {
    // El caso real: el campo nace vacío y alguien le mete el valor por fuera de
    // React, como hace `setValue` de React Hook Form sobre un campo registrado.
    const { container } = pintar(<TextField label="Slug" defaultValue="" />)
    const campo = screen.getByLabelText('Slug') as HTMLInputElement
    campo.value = 'accesorios-para-alimentacion-infantil'

    expect(container.querySelector('label')).toHaveClass('MuiInputLabel-shrink')
    expect(campo.value).toBe('accesorios-para-alimentacion-infantil')
  })
})
