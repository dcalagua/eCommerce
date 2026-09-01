import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_APPEARANCE,
  applyAppearanceToDom,
  applyTenantAccentToDom,
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


/**
 * El color del tenant en las variables CSS.
 *
 * `accent_color` llegaba solo al tema de MUI, y la mitad de la vitrina se pinta
 * con `var(--accent)`: una tienda con acento propio salia partida en dos —los
 * botones de su color y las pildoras del verde de suite—. Esto fija que el hex
 * manda en las dos mitades, que el color de TEXTO se deriva (nunca es el hex
 * pelado, contrato §4.4) y que al salir de la vitrina se retira.
 */
describe('el acento del tenant en las variables CSS', () => {
  it('escribe relleno, texto y superficie a partir del hex del comercio', () => {
    const root = document.createElement('div')

    applyTenantAccentToDom('#C8102E', 'light', root)

    expect(root.style.getPropertyValue('--accent')).toBe('#C8102E')
    // El de TEXTO no es el hex pelado: se oscurece para que se lea sobre
    // blanco aunque el comercio elija un color claro.
    expect(root.style.getPropertyValue('--accent-deep')).toContain('#C8102E')
    expect(root.style.getPropertyValue('--accent-deep')).not.toBe('#C8102E')
    expect(root.style.getPropertyValue('--accent-soft')).toContain('#C8102E')
  })

  it('en oscuro el color de texto se ACLARA, no se oscurece', () => {
    const claro = document.createElement('div')
    const oscuro = document.createElement('div')

    applyTenantAccentToDom('#C8102E', 'light', claro)
    applyTenantAccentToDom('#C8102E', 'dark', oscuro)

    expect(claro.style.getPropertyValue('--accent-deep')).not.toBe(
      oscuro.style.getPropertyValue('--accent-deep'),
    )
    expect(oscuro.style.getPropertyValue('--accent-deep')).toContain('#FFFFFF')
  })

  /**
   * El hero y las pastillas de campana son la MITAD de la piel de una vitrina.
   * Mientras salieron de `--hero-grad` de suite, un comercio que elegia rojo
   * veia sus botones rojos y media portada verde: el color solo llegaba al tema
   * de MUI, o sea a los rellenos, y a nada mas.
   */
  it('el degradado del hero y el de las pastillas tambien salen del hex', () => {
    const root = document.createElement('div')

    applyTenantAccentToDom('#C8102E', 'light', root)

    expect(root.style.getPropertyValue('--hero-grad')).toContain('#C8102E')
    expect(root.style.getPropertyValue('--badge-grad')).toContain('#C8102E')
    expect(root.style.getPropertyValue('--accent2')).toContain('#C8102E')
  })

  it('sin tenant las retira TODAS: el acento de suite vuelve sin recargar', () => {
    const root = document.createElement('div')
    applyTenantAccentToDom('#C8102E', 'light', root)

    applyTenantAccentToDom(null, 'light', root)

    // Poner y quitar leen la misma lista: una variable que se escribe y no se
    // borra deja el rojo de una tienda pintando el backoffice al salir.
    for (const name of ['--accent', '--accent-deep', '--accent-soft', '--accent2', '--hero-grad', '--badge-grad']) {
      expect(root.style.getPropertyValue(name), name).toBe('')
    }
  })
})
