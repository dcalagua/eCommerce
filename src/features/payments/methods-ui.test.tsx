import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import type { PaymentMethod } from './types'

/**
 * Borrar un medio de pago (visto en QAS: se borraba al primer clic).
 *
 * Lo que se comprueba: que el clic en la papelera NO borra, que el diálogo
 * ofrece ocultarlo como salida segura, y que las acciones de cada fila dicen
 * de qué medio son.
 */
const holder = vi.hoisted(() => ({
  remove: { mutateAsync: vi.fn(async () => undefined), isPending: false },
  save: { mutateAsync: vi.fn(async () => undefined), isPending: false },
}))

const METODOS: PaymentMethod[] = [
  {
    id: 'm-yape',
    store_id: 's1',
    code: 'yape',
    kind: 'wallet',
    display_name: 'Yape',
    provider_code: null,
    capture_mode: 'manual',
    is_active: true,
    position: 10,
    instructions: null,
  },
  {
    id: 'm-credito',
    store_id: 's1',
    code: 'credito',
    kind: 'credit',
    display_name: 'Credito empresa',
    provider_code: null,
    capture_mode: 'manual',
    is_active: false,
    position: 50,
    instructions: null,
  },
]

vi.mock('./hooks', () => ({
  usePaymentMethods: () => ({ data: METODOS, isPending: false, isError: false }),
  usePaymentProviders: () => ({ data: [] }),
  useSavePaymentMethod: () => holder.save,
  useDeletePaymentMethod: () => holder.remove,
}))

vi.mock('@/features/tenant/tenant-context', () => ({
  useTenant: () => ({
    tenant: { organization_id: 'o1' },
    activeCompanyId: 'c1',
    activeStore: { id: 's1', name: 'FerroMax' },
    can: () => true,
  }),
}))

const { MethodsSection } = await import('./MethodsSection')

beforeEach(() => {
  holder.remove.mutateAsync.mockClear()
  holder.save.mutateAsync.mockClear()
})

describe('borrar un medio de pago', () => {
  it('cada acción de fila dice de qué medio es', () => {
    renderWithProviders(<MethodsSection />)
    expect(screen.getByRole('button', { name: 'Editar: Yape' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Eliminar: Credito empresa' })).toBeInTheDocument()
  })

  it('la papelera NO borra: pide confirmación', async () => {
    renderWithProviders(<MethodsSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar: Yape' }))

    expect(holder.remove.mutateAsync).not.toHaveBeenCalled()
    const dialogo = screen.getByRole('dialog', { name: '¿Eliminar este medio de pago?' })
    expect(within(dialogo).getByText('Yape')).toBeInTheDocument()
  })

  it('publicado, ofrece ocultarlo, y ocultar no borra', async () => {
    renderWithProviders(<MethodsSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar: Yape' }))
    await userEvent.click(screen.getByRole('button', { name: 'Ocultar del checkout' }))

    expect(holder.remove.mutateAsync).not.toHaveBeenCalled()
    expect(holder.save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm-yape', code: 'yape', isActive: false }),
    )
  })

  it('confirmar sí borra ese medio y solo ese', async () => {
    renderWithProviders(<MethodsSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar: Yape' }))
    const dialogo = screen.getByRole('dialog')
    await userEvent.click(within(dialogo).getByRole('button', { name: /eliminar/i }))

    expect(holder.remove.mutateAsync).toHaveBeenCalledWith('m-yape')
  })

  it('ya oculto, no ofrece «ocultar»', async () => {
    renderWithProviders(<MethodsSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar: Credito empresa' }))
    expect(screen.queryByRole('button', { name: 'Ocultar del checkout' })).not.toBeInTheDocument()
  })
})
