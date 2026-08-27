/**
 * Escalas de suite EBIM (handoff eExpense → eSupplier, esupplier-014).
 * Los colores viven en CSS vars (`tokens.css`) para que el theming por tenant
 * sea un cambio de variables, nunca de componentes.
 */

export const C = {
  accent: 'var(--accent)',
  /** AA: usar SIEMPRE para texto/links sobre fondo claro. Nunca `accent` puro. */
  accentDeep: 'var(--accent-deep)',
  accentSoft: 'var(--accent-soft)',
  accent2: 'var(--accent2)',
  ink: 'var(--text)',
  muted: 'var(--muted)',
  neutralSoft: 'var(--neutral-soft)',
  line: 'var(--border)',
  card: 'var(--card)',
  bg: 'var(--bg)',
  sidebar: 'var(--sidebar)',
  heroGrad: 'var(--hero-grad)',
  badgeGrad: 'var(--badge-grad)',
  amber: 'var(--amber)',
  amberSoft: 'var(--amber-soft)',
  red: 'var(--red)',
  redSoft: 'var(--red-soft)',
  blue: 'var(--blue)',
  blueSoft: 'var(--blue-soft)',
  client: 'var(--client)',
  white: '#FFFFFF',
} as const

/** Spacing base 4. */
export const S = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const

/** Radios. Card=lg(14); inputs/botones=md(12); hero=xl(18); chips=pill. */
export const R = { sm: 8, md: 12, lg: 14, xl: 18, pill: 999 } as const

/** Densidad (cableada a data-density). */
export const D = {
  controlH: 'var(--control-h)',
  rowH: 'var(--row-h)',
  padY: 'var(--pad-y)',
  padX: 'var(--pad-x)',
} as const

/** Escala tipográfica (px). DM Sans. */
export const T = {
  hero: 30,
  kpiBig: 28,
  figure: 26,
  kpiCard: 24,
  pageTitle: 21,
  cardTitle: 14.5,
  body: 13,
  bodyStrong: 13.5,
  label: 11,
  micro: 10,
} as const

/** Sombras (conmutan light/dark). */
export const SH = {
  sm: 'var(--shadow-sm)',
  md: 'var(--shadow-md)',
  lg: 'var(--shadow-lg)',
  hero: 'var(--shadow-hero)',
} as const

export const FONT_STACK = "'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"

/** Presets de acento de suite. El default de suite es `forest`. */
export const ACCENTS = ['forest', 'indigo', 'cobalt', 'teal', 'graphite'] as const
export type Accent = (typeof ACCENTS)[number]

export const COLOR_MODES = ['light', 'dark'] as const
export type ColorMode = (typeof COLOR_MODES)[number]

export const DENSITIES = ['comoda', 'equilibrada', 'compacta'] as const
export type Density = (typeof DENSITIES)[number]

/** Default de suite: forest + light + equilibrada. */
export const DEFAULT_ACCENT: Accent = 'forest'
export const DEFAULT_COLOR_MODE: ColorMode = 'light'
export const DEFAULT_DENSITY: Density = 'equilibrada'

/**
 * `accent-deep` resuelto por preset. MUI necesita valores reales (no CSS vars)
 * para calcular contraste; el resto del sistema usa las vars.
 */
export const ACCENT_HEX: Record<Accent, { light: string; lightDeep: string; dark: string; darkDeep: string }> = {
  forest: { light: '#5AA97F', lightDeep: '#3F8A66', dark: '#5AA97F', darkDeep: '#6FD29A' },
  indigo: { light: '#6366F1', lightDeep: '#4F46E5', dark: '#818CF8', darkDeep: '#A5B4FC' },
  cobalt: { light: '#2563EB', lightDeep: '#1D4ED8', dark: '#3B82F6', darkDeep: '#60A5FA' },
  teal: { light: '#0D9488', lightDeep: '#0F766E', dark: '#2DD4BF', darkDeep: '#5EEAD4' },
  graphite: { light: '#475569', lightDeep: '#334155', dark: '#94A3B8', darkDeep: '#CBD5E1' },
}

/** Densidad → alturas reales (para MUI, que no lee CSS vars al calcular). */
export const DENSITY_METRICS: Record<Density, { controlH: number; rowH: number; padY: number; padX: number }> = {
  comoda: { controlH: 40, rowH: 52, padY: 12, padX: 14 },
  equilibrada: { controlH: 36, rowH: 44, padY: 9, padX: 12 },
  compacta: { controlH: 32, rowH: 38, padY: 6, padX: 10 },
}
