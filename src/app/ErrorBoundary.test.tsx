import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { ErrorBoundary } from './ErrorBoundary'

function Boom(): never {
  throw new Error('render roto')
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React registra el error en consola aunque lo capturemos: silenciamos el ruido.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('atrapa el error y evita la pantalla en blanco', () => {
    renderWithProviders(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('render roto')).toBeInTheDocument()
  })

  it('notifica el error al callback', () => {
    const onError = vi.fn()
    renderWithProviders(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(onError).toHaveBeenCalled()
  })

  it('renderiza los hijos cuando no hay error', () => {
    renderWithProviders(
      <ErrorBoundary>
        <p>contenido sano</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('contenido sano')).toBeInTheDocument()
  })
})
