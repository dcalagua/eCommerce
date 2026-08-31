import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { ProductMedia } from './ProductMedia'

const URL = 'https://firmado.test/foto.png'

describe('cómo encaja la foto en su caja', () => {
  it('en la rejilla RECORTA: es lo que mantiene todas las tarjetas iguales', () => {
    renderWithProviders(<ProductMedia url={URL} alt="Silla" />)

    expect(screen.getByRole('img', { name: 'Silla' })).toHaveStyle({ objectFit: 'cover' })
  })

  it('en la ficha se ve ENTERA: recortarla esconde lo que se vino a mirar', () => {
    // El caso que lo destapó: el tenant había subido un logotipo apaisado como
    // foto de producto. Con `cover` salía ampliado y descentrado, y parecía un
    // fallo de la tienda en vez de una foto que no era de estudio.
    renderWithProviders(<ProductMedia url={URL} alt="Silla" fit="contain" />)

    const image = screen.getByRole('img', { name: 'Silla' })
    expect(image).toHaveStyle({ objectFit: 'contain' })
    // Centrada de verdad: sin esto el hueco sobrante se acumula a un lado.
    expect(image).toHaveStyle({ objectPosition: 'center' })
  })

  it('sin foto no deja un hueco vacío: pinta el marcador neutral', () => {
    // Y NO un logotipo ni una imagen de archivo: nada que le ponga a la tienda
    // una identidad que no eligió.
    renderWithProviders(<ProductMedia url={null} alt="Silla" />)

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
