import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { LoginPage } from './LoginPage'

/** La anatomía del login es normativa de suite (contrato §4.5): se testea, no se confía. */
describe('LoginPage — anatomía de suite', () => {
  it('muestra el isotipo EBIM y el lockup "by EBIM" al pie', () => {
    renderWithProviders(<LoginPage />)
    expect(screen.getAllByRole('img', { name: 'EBIM' }).length).toBeGreaterThan(0)
    expect(screen.getByText(/by EBIM/i)).toBeInTheDocument()
  })

  it('tiene exactamente 3 bullets en el panel de marca', () => {
    renderWithProviders(<LoginPage />)
    const bullets = [
      screen.getByText('Catálogo por sociedad'),
      screen.getByText('Pedidos en un flujo'),
      screen.getByText('Tu marca, tu tienda'),
    ]
    expect(bullets).toHaveLength(3)
    expect(screen.queryByText('Cuarto bullet')).not.toBeInTheDocument()
  })

  it('dice de dónde sale la credencial (subtítulo obligatorio)', () => {
    renderWithProviders(<LoginPage />)
    expect(screen.getByText(/administrador de tu empresa/i)).toBeInTheDocument()
  })

  it('incluye el pie de confianza sobre cifrado y aislamiento', () => {
    renderWithProviders(<LoginPage />)
    expect(screen.getByText(/aislamiento de datos por cliente/i)).toBeInTheDocument()
  })

  it('valida el correo antes de enviar', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)

    await user.type(screen.getByLabelText('Correo corporativo'), 'no-es-un-correo')
    await user.type(screen.getByLabelText('Contraseña'), 'secreto123')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByText('Ese correo no parece válido')).toBeInTheDocument()
  })

  it('alterna la visibilidad de la contraseña', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)

    const field = screen.getByLabelText('Contraseña')
    expect(field).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Mostrar contraseña' }))
    await waitFor(() => expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'text'))
  })

  // `findBy*` y no `getBy*` desde P15-SaaS: el diccionario ingles llega por
  // `import()` (ver `shared/i18n/messages.ts`). La asercion es la misma; lo que
  // cambio es que ahora hay un tick de por medio, y el primer pintado se ve en
  // espanol a proposito.
  it('traduce a inglés sin cambiar la estructura', async () => {
    renderWithProviders(<LoginPage />, { locale: 'en' })
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByText(/by EBIM/i)).toBeInTheDocument()
  })
})
