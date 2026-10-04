import { describe, expect, it } from 'vitest'
import { evaluateHomeVideo, sanitizeHomeVideos, storedSeconds } from './homeVideos'

const ORG = '11111111-1111-4111-8111-111111111111'
const TIENDA = '22222222-2222-4222-8222-222222222222'
const ruta = (ext = 'mp4') => `${ORG}/${TIENDA}/content/video-33333333-3333-4333-8333-333333333333.${ext}`

describe('requisitos de un video de portada', () => {
  it('MP4 o WebM de 30 s a 1 min y hasta 30 MB pasa', () => {
    expect(evaluateHomeVideo({ type: 'video/mp4', bytes: 12e6, seconds: 45 })).toEqual([])
    expect(evaluateHomeVideo({ type: 'video/webm', bytes: 12e6, seconds: 29.97 })).toEqual([])
  })

  it('dice qué falla', () => {
    expect(evaluateHomeVideo({ type: 'video/quicktime', bytes: 1, seconds: 40 })).toEqual(['type'])
    expect(evaluateHomeVideo({ type: 'video/mp4', bytes: 40 * 1024 * 1024, seconds: 40 })).toEqual(['weight'])
    expect(evaluateHomeVideo({ type: 'video/mp4', bytes: 1, seconds: 12 })).toEqual(['short'])
    expect(evaluateHomeVideo({ type: 'video/mp4', bytes: 1, seconds: 95 })).toEqual(['long'])
    expect(evaluateHomeVideo({ type: 'video/mp4', bytes: 1, seconds: null })).toEqual(['unreadable'])
  })

  it('guarda segundos enteros dentro de 30..60', () => {
    expect(storedSeconds(29.97)).toBe(30)
    expect(storedSeconds(60.4)).toBe(60)
  })
})

describe('la lista guardada, limpia', () => {
  it('descarta lo que no es un video de la tienda', () => {
    const lista = sanitizeHomeVideos([
      { path: ruta(), title: 'Colección', duration: 40 },
      { path: 'https://otro.test/v.mp4', duration: 40 },
      { path: ruta('mov'), duration: 40 },
      { path: ruta('webm'), duration: 90 },
      'basura',
    ])
    expect(lista).toEqual([{ path: ruta(), title: 'Colección', duration: 40 }])
  })

  it('no es una lista: ninguna', () => {
    expect(sanitizeHomeVideos(null)).toEqual([])
    expect(sanitizeHomeVideos({})).toEqual([])
  })
})
