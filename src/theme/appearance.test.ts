import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_APPEARANCE,
  applyAppearanceToDom,
  persistAppearance,
  readStoredAppearance,
  STORAGE_KEYS,
} from './appearance'
import { createEbimTheme } from './createEbimTheme'
import { ACCENT_HEX } from './tokens'

describe('apariencia', () => {
  beforeEach(() => {
    localStorage.clear()
    const root = document.documentElement
    root.removeAttribute('data-accent')
    root.removeAttribute('data-density')
  })

  it('usa el default de suite: forest + equilibrada', () => {
    expect(DEFAULT_APPEARANCE.accent).toBe('forest')
    expect(DEFAULT_APPEARANCE.density).toBe('equilibrada')
    expect(DEFAULT_APPEARANCE.mode).toBe('light')
  })

  it('omite los defaults al persistir (convención de suite)', () => {
    persistAppearance(DEFAULT_APPEARANCE)
    expect(localStorage.getItem(STORAGE_KEYS.accent)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEYS.density)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEYS.mode)).toBe('light')
  })

  it('persiste y relee los valores no-default', () => {
    persistAppearance({ mode: 'dark', accent: 'teal', density: 'compacta' })
    expect(readStoredAppearance()).toEqual({ mode: 'dark', accent: 'teal', density: 'compacta' })
  })

  it('ignora valores corruptos de localStorage', () => {
    localStorage.setItem(STORAGE_KEYS.accent, 'neon')
    localStorage.setItem(STORAGE_KEYS.density, 'gigante')
    const stored = readStoredAppearance()
    expect(stored.accent).toBe('forest')
    expect(stored.density).toBe('equilibrada')
  })

  it('refleja modo, acento y densidad en el <html>', () => {
    applyAppearanceToDom({ mode: 'dark', accent: 'cobalt', density: 'comoda' })
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.getAttribute('data-accent')).toBe('cobalt')
    expect(root.getAttribute('data-density')).toBe('comoda')
  })
})

describe('createEbimTheme', () => {
  it('el accent del tenant manda sobre el preset de casa (contrato §4.4)', () => {
    const theme = createEbimTheme({
      mode: 'light',
      accent: 'forest',
      density: 'equilibrada',
      tenantAccent: '#D11F2E',
    })
    expect(theme.palette.primary.main).toBe('#D11F2E')
    expect(theme.palette.accentDeep).toBe('#D11F2E')
  })

  it('sin tenant cae al acento de casa', () => {
    const theme = createEbimTheme({ mode: 'light', accent: 'forest', density: 'equilibrada' })
    expect(theme.palette.primary.main).toBe(ACCENT_HEX.forest.light)
  })

  it('usa accent-deep para texto/links, nunca el accent puro (regla AA)', () => {
    const theme = createEbimTheme({ mode: 'light', accent: 'forest', density: 'equilibrada' })
    expect(theme.palette.accentDeep).toBe(ACCENT_HEX.forest.lightDeep)
    expect(theme.palette.accentDeep).not.toBe(theme.palette.primary.main)
  })

  it('la densidad cambia las alturas de control y fila', () => {
    const compacta = createEbimTheme({ mode: 'light', accent: 'forest', density: 'compacta' })
    const comoda = createEbimTheme({ mode: 'light', accent: 'forest', density: 'comoda' })
    const height = (t: typeof compacta) =>
      (t.components?.MuiButton?.styleOverrides?.root as { minHeight: number }).minHeight
    expect(height(compacta)).toBe(32)
    expect(height(comoda)).toBe(40)
  })
})
