import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'

const api = vi.hoisted(() => ({ fetchSkuIndex: vi.fn(), fetchImageCounts: vi.fn() }))
const images = vi.hoisted(() => ({ uploadProductImage: vi.fn() }))
const photo = vi.hoisted(() => ({ prepareProductPhoto: vi.fn() }))

vi.mock('../api/bulkImages', () => api)
vi.mock('../api/images', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/images')>()),
  ...images,
}))
vi.mock('@/shared/lib/productPhoto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/lib/productPhoto')>()),
  ...photo,
}))

import { BulkImagesAction } from './BulkImagesAction'

const SCOPE = { organizationId: 'org-1', companyId: 'co-1', storeId: 'store-1' }
const jpg = (name: string) => new File(['x'], name, { type: 'image/jpeg' })

// jsdom no trae URLs de objeto: las miniaturas solo necesitan una cadena.
const originales = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:miniatura')
  URL.revokeObjectURL = vi.fn()
})
afterAll(() => {
  URL.createObjectURL = originales.create
  URL.revokeObjectURL = originales.revoke
})

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchSkuIndex.mockResolvedValue(
    new Map([
      ['FMX-0158', 'p-158'],
      ['FMX-0200', 'p-200'],
      ['FMX-0300', 'p-300'],
    ]),
  )
  // FMX-0200 ya tiene una foto.
  api.fetchImageCounts.mockResolvedValue(new Map([['p-200', 1]]))
  photo.prepareProductPhoto.mockImplementation(async (file: File) => ({
    file,
    prepared: true,
    // La segunda foto de FMX-0158 viene sobre una mesa.
    warnings: file.name === 'FMX-0158-2.jpg' ? ['background'] : [],
  }))
  images.uploadProductImage.mockResolvedValue({})
})

async function elegir(files: File[]) {
  const user = userEvent.setup({ applyAccept: false })
  renderWithProviders(<BulkImagesAction scope={SCOPE} />)
  await user.click(screen.getByRole('button', { name: 'Subir imágenes' }))
  const dialog = await screen.findByRole('dialog', { name: 'Subir imágenes por SKU' })
  await user.upload(within(dialog).getByLabelText('Elegir fotos'), files)
  await within(dialog).findByRole('table', { name: 'Revisión de fotos' })
  return { user, dialog }
}

describe('subir imágenes por SKU', () => {
  it('empareja por nombre, avisa del fondo y no marca lo que no debe subirse', async () => {
    const { dialog } = await elegir([
      jpg('FMX-0158.jpg'),
      jpg('FMX-0158-2.jpg'),
      jpg('FMX-0200.jpg'),
      jpg('otro.jpg'),
      new File(['x'], 'notas.txt', { type: 'text/plain' }),
    ])

    // Solo la sociedad activa: el índice de SKU se pide con su id.
    expect(api.fetchSkuIndex).toHaveBeenCalledWith('co-1')
    expect(within(dialog).getByText(/Se ignoraron 1 archivos/)).toBeInTheDocument()

    const marcada = (nombre: string) =>
      (within(dialog).getByRole('checkbox', { name: `Incluir: ${nombre}` }) as HTMLInputElement).checked
    expect(marcada('FMX-0158.jpg')).toBe(true)
    // Fondo que no es blanco: sale desmarcada y se dice por qué.
    expect(marcada('FMX-0158-2.jpg')).toBe(false)
    expect(within(dialog).getByText('El fondo no es blanco: sale desmarcada.')).toBeInTheDocument()
    // Ya tenía foto: volver a subir la carpeta no duplica la galería.
    expect(marcada('FMX-0200.jpg')).toBe(false)
    // Sin producto: ni se puede marcar.
    expect(within(dialog).getByRole('checkbox', { name: 'Incluir: otro.jpg' })).toBeDisabled()
    // FMX-0300 no tiene foto ni la recibe.
    expect(within(dialog).getByText('1 productos seguirán sin foto aunque subas todas estas.')).toBeInTheDocument()
  })

  it('sube solo lo marcado, con el mismo camino que la ficha', async () => {
    const { user, dialog } = await elegir([jpg('FMX-0158.jpg'), jpg('FMX-0158-2.jpg'), jpg('FMX-0200.jpg')])

    // Quien sube decide: incluye también la del producto que ya tenía foto.
    await user.click(within(dialog).getByRole('checkbox', { name: 'Incluir: FMX-0200.jpg' }))
    await user.click(within(dialog).getByRole('button', { name: 'Subir 2 fotos' }))

    await within(dialog).findByText('Fotos subidas. Ya se ven en las fichas y en la tienda.')
    expect(images.uploadProductImage).toHaveBeenCalledTimes(2)
    expect(images.uploadProductImage).toHaveBeenCalledWith(
      expect.objectContaining({ ...SCOPE, productId: 'p-158', position: 0 }),
    )
    // Detrás de la foto que ya tenía.
    expect(images.uploadProductImage).toHaveBeenCalledWith(
      expect.objectContaining({ ...SCOPE, productId: 'p-200', position: 1 }),
    )
  })

  it('una foto que falla se marca y el resto sigue', async () => {
    images.uploadProductImage.mockImplementation(async ({ productId }: { productId: string }) => {
      if (productId === 'p-300') throw new Error('red')
      return {}
    })
    const { user, dialog } = await elegir([jpg('FMX-0158.jpg'), jpg('FMX-0300.jpg')])
    await user.click(within(dialog).getByRole('button', { name: 'Subir 2 fotos' }))

    await within(dialog).findByText('Algunas fotos no se subieron: revisa las marcadas con error.')
    await waitFor(() => expect(within(dialog).getByText('Subida: 1')).toBeInTheDocument())
    expect(within(dialog).getByText('Con error: 1')).toBeInTheDocument()
  })

  it('sin la opción de fondo blanco no se toca la foto', async () => {
    const user = userEvent.setup({ applyAccept: false })
    renderWithProviders(<BulkImagesAction scope={SCOPE} />)
    await user.click(screen.getByRole('button', { name: 'Subir imágenes' }))
    const dialog = await screen.findByRole('dialog', { name: 'Subir imágenes por SKU' })
    await user.click(within(dialog).getByRole('checkbox', { name: /Fondo blanco y formato cuadrado/ }))
    await user.upload(within(dialog).getByLabelText('Elegir fotos'), [jpg('FMX-0158.jpg')])
    await within(dialog).findByRole('table', { name: 'Revisión de fotos' })

    expect(photo.prepareProductPhoto).not.toHaveBeenCalled()
  })
})
