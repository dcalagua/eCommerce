import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOME_LAYOUT, THEME_PRESETS } from './presets'
import { THEME_PRESET_IDS } from './types'

/**
 * Las reglas que los cuatro temas no pueden romper.
 *
 * Este archivo no mira componentes: mira el CONTRATO y la hoja de estilos de la
 * vitrina. Es donde se comprueban las cosas que ninguna prueba de render puede
 * ver porque no son de una pantalla concreta, sino de cómo está construido el
 * tema entero.
 *
 * Las tres que más valen:
 *
 *  1. **`universal` solo pone su BASE.** Hasta el rediseño v3 era el suelo sin
 *     una sola regla; desde v3 (aprobado por el operador el 2026-09-30) cada
 *     estilo tiene su lienzo neutro, y universal también. Lo que sigue vetado
 *     es que meta color de marca o movimiento.
 *  2. **Ningún tema toca el ACENTO.** Es 100 % del tenant (contrato §4.4). Los
 *     NEUTROS (`--bg`, `--card`, `--text`, `--muted`) sí son del estilo desde
 *     v3, pero solo en bloques atados al modo y siempre en los dos: uno que los
 *     redefiniera sin modo rompería el oscuro sin que se note en claro.
 *  3. **Ningún tema mete movimiento.** El movimiento de la vitrina se apaga
 *     entero con `prefers-reduced-motion`, y esa promesa solo se sostiene si las
 *     animaciones viven donde ya se apagan.
 */

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'storefront.css'),
  'utf8',
)

function cuerpos(re: RegExp): string[] {
  const bloques: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(CSS)) !== null) bloques.push(match[1] ?? '')
  return bloques
}

/** Todo lo que cuelga de un atributo de tema, incluidos los descendientes. */
function bloquesDeTema(): string[] {
  return cuerpos(/\.sf-scope\[data-store-[^\]]+\][^{]*\{([^}]*)\}/g)
}

/**
 * Solo lo que se declara SOBRE la propia frontera.
 *
 * La distinción importa: ahí es donde un tema competiría con las reglas de modo
 * claro/oscuro, que declaran sobre ese mismo elemento y con más peso. Una regla
 * que apunta a un descendiente —la cabecera, por ejemplo— no compite con nadie.
 */
function bloquesDeLaFrontera(): string[] {
  return cuerpos(/\.sf-scope\[data-store-[^\]]+\]\s*\{([^}]*)\}/g)
}

// ---------------------------------------------------------------------------
// P09 · Universal es la línea base
// ---------------------------------------------------------------------------

describe('universal es el suelo, no un tema más', () => {
  it('sus reglas son solo base de estilo: ni acento ni movimiento', () => {
    const suyas = cuerpos(/data-store-theme='universal'\][^{]*\{([^}]*)\}/g)
    expect(suyas.length).toBeGreaterThan(0)
    for (const bloque of suyas) {
      expect(bloque).not.toMatch(/--accent[\w-]*:|--hero-grad:|\btransition\b|\banimation\b/)
    }
  })

  it('sus valores son los de la vitrina anterior al Theme Engine', () => {
    // Los mismos números que había cableados: `Container` en `lg`,
    // `ProductMedia` en `1 / 1` y `ProductGrid` repartiendo 2/3/4.
    expect(THEME_PRESETS.universal).toMatchObject({
      contentWidth: 'lg',
      imageRatio: 'square',
      sectionSpacing: 'comfortable',
      headerVariant: 'standard',
      productCardVariant: 'comfortable',
      gridColumns: { xs: 2, sm: 3, lg: 4 },
    })
  })

  it('el orden por defecto no enciende nada que no existiera', () => {
    const encendidas = DEFAULT_HOME_LAYOUT.sections
      .filter((s) => s.enabled)
      .map((s) => s.id)

    // `categories`, `featured`, `business-info` y `newsletter` quedan apagadas:
    // las dos primeras porque hoy se pintan en otro sitio, las dos últimas
    // porque todavía no tienen qué pintar.
    expect(encendidas).not.toContain('categories')
    expect(encendidas).not.toContain('featured')
    expect(encendidas).not.toContain('business-info')
    expect(encendidas).not.toContain('newsletter')
  })
})

// ---------------------------------------------------------------------------
// Lo que ningún tema puede hacer
// ---------------------------------------------------------------------------

describe('ningún tema le quita el color al comercio', () => {
  /**
   * Los tres últimos no son colores de marca y aun así están vetados, por un
   * motivo de CASCADA: se redefinen por modo claro/oscuro con selectores de más
   * peso, así que un tema que los pisara solo se notaría con el modo del
   * sistema sin elegir. El modo manda en profundidad; el tema, en geometría.
   */
  const COLORES_AJENOS = ['--accent:', '--accent-deep:', '--accent-soft:', '--accent2:']

  it.each(COLORES_AJENOS)('no redefine %s en ninguna regla de tema', (variable) => {
    for (const bloque of bloquesDeTema()) {
      expect(bloque).not.toContain(variable)
    }
  })

  /** Selector + cuerpo de cada bloque que declara sobre una frontera con tema. */
  function bloquesConSelector(): { selector: string; cuerpo: string }[] {
    const re = /([^{}]*\.sf-scope\[data-store-theme='[a-z]+'\])\s*\{([^}]*)\}/g
    const fuera: { selector: string; cuerpo: string }[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(CSS)) !== null) fuera.push({ selector: (m[1] ?? '').trim(), cuerpo: m[2] ?? '' })
    return fuera
  }

  const NEUTROS = ['--text:', '--muted:', '--card:', '--bg:']

  it.each(NEUTROS)('%s solo se redefine atado al modo claro u oscuro', (variable) => {
    for (const { selector, cuerpo } of bloquesConSelector()) {
      if (!cuerpo.includes(variable)) continue
      expect(selector).toMatch(/^(\/\*[\s\S]*?\*\/\s*)*:root(:not\(\[data-theme='dark'\]\)|\[data-theme='dark'\])/)
    }
  })

  it.each(THEME_PRESET_IDS)('%s define sus neutros en los DOS modos', (preset) => {
    const suyos = bloquesConSelector().filter(
      ({ selector, cuerpo }) => selector.includes(`data-store-theme='${preset}'`) && cuerpo.includes('--bg:'),
    )
    const claro = suyos.some(({ selector }) => selector.includes(":not([data-theme='dark'])"))
    const oscuro = suyos.some(({ selector }) => /:root\[data-theme='dark'\]/.test(selector))
    expect({ claro, oscuro }).toEqual({ claro: true, oscuro: true })
  })

  const PROFUNDIDAD = ['--sf-line:', '--sf-shadow:', '--sf-shadow-hover:', '--sf-media-bg:']

  it.each(PROFUNDIDAD)('no pisa %s sobre la propia frontera', (variable) => {
    for (const bloque of bloquesDeLaFrontera()) {
      expect(bloque).not.toContain(variable)
    }
  })

  it('hay bloques de tema de verdad que comprobar', () => {
    // Si esta hoja dejara de tener reglas de tema, las de arriba pasarían
    // vacías y no probarían nada.
    expect(bloquesDeTema().length).toBeGreaterThan(3)
  })
})

describe('ningún tema mete movimiento nuevo', () => {
  it('no declara transiciones ni animaciones', () => {
    for (const bloque of bloquesDeTema()) {
      expect(bloque).not.toMatch(/\btransition\b|\banimation\b/)
    }
  })
})

// ---------------------------------------------------------------------------
// Densidad y móvil
// ---------------------------------------------------------------------------

describe('la densidad nunca llega al teléfono', () => {
  it.each(THEME_PRESET_IDS)('%s reparte dos columnas en móvil', (preset) => {
    // Es el riesgo real de un tema denso: seis columnas están muy bien en un
    // escritorio y a 320 px son seis tarjetas de 45 px con el nombre cortado.
    expect(THEME_PRESETS[preset].gridColumns.xs).toBe(2)
  })

  it.each(THEME_PRESET_IDS)('%s crece de forma monótona', (preset) => {
    const { xs, sm, lg } = THEME_PRESETS[preset].gridColumns
    expect(sm).toBeGreaterThanOrEqual(xs)
    expect(lg).toBeGreaterThanOrEqual(sm)
  })

  it('el catálogo denso es el que más reparte, y el editorial el que menos', () => {
    expect(THEME_PRESETS.catalog.gridColumns.lg).toBeGreaterThan(
      THEME_PRESETS.universal.gridColumns.lg,
    )
    expect(THEME_PRESETS.premium.gridColumns.lg).toBeLessThan(
      THEME_PRESETS.universal.gridColumns.lg,
    )
  })
})
