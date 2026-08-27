import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { EmptyState, ErrorState, LoadingState } from './states'

describe('estados de pantalla', () => {
  it('el estado de carga se anuncia al lector de pantalla', () => {
    renderWithProviders(<LoadingState />)
    expect(screen.getByRole('status')).toHaveTextContent('Cargando…')
  })

  it('el estado de error se anuncia como alerta y permite reintentar', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    renderWithProviders(<ErrorState error={new Error('RLS denegó la fila')} onRetry={onRetry} />)

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('RLS denegó la fila')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('el estado vacío no es una alerta: no falló nada', () => {
    renderWithProviders(<EmptyState />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Nada por aquí todavía')).toBeInTheDocument()
  })

  it('traduce los estados a inglés', () => {
    renderWithProviders(<EmptyState />, { locale: 'en' })
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument()
  })
})
