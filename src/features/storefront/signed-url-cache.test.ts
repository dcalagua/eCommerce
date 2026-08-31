import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearSignedUrls, signedUrls, SIGN_TTL_SECONDS } from './signed-url-cache'

const BUCKET = 'product-images'

afterEach(() => {
  clearSignedUrls(BUCKET)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function signer(urls: Record<string, string>) {
  return vi.fn(async (missing: string[]) =>
    Object.fromEntries(missing.filter((path) => path in urls).map((path) => [path, urls[path]!])),
  )
}

describe('caché de URLs firmadas', () => {
  it('la segunda vez NO vuelve a firmar: es lo que hace que el navegador reuse su caché', async () => {
    const sign = signer({ 'a/silla.jpg': 'https://firmado.test/a?token=1' })

    const first = await signedUrls(BUCKET, ['a/silla.jpg'], sign)
    const second = await signedUrls(BUCKET, ['a/silla.jpg'], sign)

    expect(sign).toHaveBeenCalledTimes(1)
    // La URL es la MISMA cadena: si cambiara, para el navegador sería otra
    // imagen y volvería a descargarla, que es justo lo que se evita.
    expect(second['a/silla.jpg']).toBe(first['a/silla.jpg'])
  })

  it('solo pide lo que falta, no el lote entero', async () => {
    const sign = signer({
      'a/uno.jpg': 'https://firmado.test/uno',
      'a/dos.jpg': 'https://firmado.test/dos',
    })

    await signedUrls(BUCKET, ['a/uno.jpg'], sign)
    await signedUrls(BUCKET, ['a/uno.jpg', 'a/dos.jpg'], sign)

    expect(sign).toHaveBeenNthCalledWith(2, ['a/dos.jpg'])
  })

  it('re-firma antes de que caduque, para que nada se quede a medio cargar', async () => {
    vi.useFakeTimers()
    const sign = signer({ 'a/silla.jpg': 'https://firmado.test/a' })

    await signedUrls(BUCKET, ['a/silla.jpg'], sign)
    // Justo dentro del margen de renovación: la firma aún vale, pero le queda
    // menos de media hora, así que se pide otra.
    vi.advanceTimersByTime((SIGN_TTL_SECONDS - 20 * 60) * 1000)
    await signedUrls(BUCKET, ['a/silla.jpg'], sign)

    expect(sign).toHaveBeenCalledTimes(2)
  })

  it('sin almacenamiento sigue funcionando: la caché es una mejora, no un requisito', async () => {
    const sign = signer({ 'a/silla.jpg': 'https://firmado.test/a' })
    vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })

    const map = await signedUrls(BUCKET, ['a/silla.jpg'], sign)

    expect(map['a/silla.jpg']).toBe('https://firmado.test/a')
  })

  it('una ruta que la firma no devuelve no se inventa', async () => {
    const sign = signer({})
    const map = await signedUrls(BUCKET, ['a/perdida.jpg'], sign)
    expect(map['a/perdida.jpg']).toBeUndefined()
  })
})
