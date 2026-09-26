import { describe, expect, it } from 'vitest'
import { BRAND_FONTS } from '@/theme/tokens'
import { THEME_FONTS, THEME_PRESETS, resolveStoreFont } from './presets'

/**
 * Resumen v2 · Cada tema PROPONE su tipografía; la tienda puede cambiarla.
 */
describe('la tipografía que propone cada tema', () => {
  it('cada tema propone una fuente de la lista cerrada', () => {
    for (const preset of Object.keys(THEME_PRESETS) as (keyof typeof THEME_PRESETS)[]) {
      expect(BRAND_FONTS).toContain(THEME_FONTS[preset])
    }
  })

  it('Universal conserva la de siempre: quien nunca eligió no ve cambiar su tienda', () => {
    expect(THEME_FONTS.universal).toBe('plus-jakarta')
  })

  it('cada uno de los otros tres tiene su propia letra', () => {
    expect(THEME_FONTS).toMatchObject({ retail: 'archivo', premium: 'jost', catalog: 'plex' })
  })

  it('sin elección de la tienda manda el tema; con elección, la tienda', () => {
    expect(resolveStoreFont(null, 'premium')).toBe('jost')
    expect(resolveStoreFont('', 'catalog')).toBe('plex')
    expect(resolveStoreFont('grotesk', 'premium')).toBe('grotesk')
  })

  it('un tema desconocido cae a Universal, no a una fuente inventada', () => {
    expect(resolveStoreFont(null, 'inventado')).toBe('plus-jakarta')
    expect(resolveStoreFont(undefined, undefined)).toBe('plus-jakarta')
  })
})
