import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import type { HomeVideo } from '../homeVideos'

vi.mock('../hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks')>()),
  // Firmar es del Storage: aquí cada ruta «firmada» es ella misma.
  useSignedStoreAssets: (refs: readonly (string | null)[]) =>
    Object.fromEntries(refs.filter((r): r is string => Boolean(r)).map((r) => [r, `https://firmado.test/${r}`])),
}))

import { VideoCarousel } from './VideoCarousel'

const ORG = '11111111-1111-4111-8111-111111111111'
const TIENDA = '22222222-2222-4222-8222-222222222222'
const video = (n: number, title: string | null = `Video ${n}`): HomeVideo => ({
  path: `${ORG}/${TIENDA}/content/video-00000000-0000-4000-8000-00000000000${n}.mp4`,
  title,
  duration: 40,
})

const activo = () => screen.getAllByRole('button', { name: /^Video \d de \d$/ }).findIndex((b) => b.getAttribute('aria-current') === 'true')
const videos = () => Array.from(document.querySelectorAll('video'))

beforeEach(() => {
  // jsdom no reproduce: basta con que `play` y `pause` existan.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
})

describe('carrusel de videos de la portada', () => {
  it('al terminar uno pasa al siguiente, y después del último vuelve al primero', () => {
    renderWithProviders(<VideoCarousel videos={[video(1), video(2), video(3)]} />)
    expect(videos()).toHaveLength(3)
    expect(activo()).toBe(0)

    fireEvent.ended(videos()[0] as HTMLVideoElement)
    expect(activo()).toBe(1)
    fireEvent.ended(videos()[1] as HTMLVideoElement)
    expect(activo()).toBe(2)
    fireEvent.ended(videos()[2] as HTMLVideoElement)
    expect(activo()).toBe(0)
  })

  it('arranca sin sonido y el comprador puede activarlo', async () => {
    const user = userEvent.setup()
    renderWithProviders(<VideoCarousel videos={[video(1), video(2)]} />)
    expect(videos().every((v) => v.muted)).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Activar sonido' }))
    expect(screen.getByRole('button', { name: 'Silenciar' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('las flechas y los puntos eligen el video', async () => {
    const user = userEvent.setup()
    renderWithProviders(<VideoCarousel videos={[video(1), video(2), video(3)]} />)
    await user.click(screen.getByRole('button', { name: 'Video anterior' }))
    expect(activo()).toBe(2)
    await user.click(screen.getByRole('button', { name: 'Video 2 de 3' }))
    expect(activo()).toBe(1)
  })

  it('con un solo video, ese video en bucle y sin flechas', () => {
    renderWithProviders(<VideoCarousel videos={[video(1)]} />)
    expect(videos()[0]).toHaveAttribute('loop')
    expect(screen.queryByRole('button', { name: 'Video siguiente' })).toBeNull()
  })

  it('sin videos no pinta nada', () => {
    const { container } = renderWithProviders(<VideoCarousel videos={[]} />)
    expect(container.querySelector('[data-video-carousel]')).toBeNull()
  })
})
