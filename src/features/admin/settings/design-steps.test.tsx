import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { renderWithProviders } from '@/test/render'
import { StorefrontDesignSection } from './StorefrontDesignSection'
import { storeFormSchema, toForm, type StoreFormValues } from './types'

/**
 * Resumen v2 · «Diseño de tienda» como TALLER POR PASOS.
 *
 * Lo que se fija: que de entrada solo está abierto el primero, que abrir uno
 * cierra el anterior, que «Siguiente» lleva al que sigue y que, cerrados, los
 * pasos dicen lo que se eligió en ellos. El contenido de cada paso lo prueba
 * `storefront-design.test.tsx`.
 */
function Anfitrion({ inicial }: { inicial?: Partial<StoreFormValues> }) {
  const form = useForm<StoreFormValues>({
    resolver: zodResolver(storeFormSchema),
    defaultValues: { ...toForm('Botica', null), ...inicial },
  })
  return <StorefrontDesignSection form={form} />
}

/** La cabecera (botón) de un paso, por su identificador. */
const paso = (id: string) => {
  const boton = document.querySelector(`[data-design-step="${id}"] > button`)
  if (!(boton instanceof HTMLElement)) throw new Error(`no hay paso ${id}`)
  return boton
}

describe('el taller por pasos', () => {
  it('son cinco pasos, y de entrada solo está abierto el primero', () => {
    renderWithProviders(<Anfitrion />)
    for (const [id, titulo] of [['tema', 'Tema'], ['portada', 'Portada'], ['forma', 'Forma y detalles'], ['confianza', 'Confianza y avisos'], ['revisar', 'Revisar']] as const) {
      expect(within(paso(id)).getByRole('heading', { name: titulo })).toBeInTheDocument()
    }
    expect(paso('tema')).toHaveAttribute('aria-expanded', 'true')
    expect(paso('portada')).toHaveAttribute('aria-expanded', 'false')
    // El contenido del paso 1 está; el del 2, no (se desmonta al cerrar).
    expect(screen.getByRole('radiogroup')).toBeInTheDocument()
    expect(screen.queryByText('Restablecer al tema')).not.toBeInTheDocument()
  })

  it('abrir un paso cierra el que estaba abierto', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Anfitrion />)
    await user.click(paso('portada'))
    expect(paso('portada')).toHaveAttribute('aria-expanded', 'true')
    expect(paso('tema')).toHaveAttribute('aria-expanded', 'false')
    // Se desmonta al terminar de plegarse.
    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument())
  })

  it('«Siguiente» lleva al paso que sigue, y el anterior queda como hecho', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Anfitrion />)
    await user.click(screen.getByRole('button', { name: 'Siguiente: Portada' }))
    expect(paso('portada')).toHaveAttribute('aria-expanded', 'true')
    const tema = document.querySelector('[data-design-step="tema"]') as HTMLElement
    expect(tema).toHaveAttribute('data-open', 'false')
  })

  it('cerrados, los pasos dicen lo que se eligió en ellos', () => {
    renderWithProviders(
      <Anfitrion inicial={{ theme_preset: 'retail', storefront_style: { contentWidth: 'xl' } }} />,
    )
    // El tema y su letra; y cuántos ajustes se apartaron del tema.
    expect(within(paso('tema')).getByText(/Retail · Archivo/)).toBeInTheDocument()
    expect(within(paso('forma')).getByText('1 ajustes cambiados respecto al tema')).toBeInTheDocument()
  })

  it('las garantías se escriben en el paso 4, y Marca sigue siendo el sitio del lockup', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Anfitrion />)
    await user.click(paso('confianza'))
    expect(screen.getByRole('link', { name: 'Ir a Marca →' })).toHaveAttribute('href', '#branding')
  })
})
