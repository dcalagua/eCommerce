import {
  ACCENTS,
  COLOR_MODES,
  DEFAULT_ACCENT,
  DEFAULT_COLOR_MODE,
  DEFAULT_DENSITY,
  DENSITIES,
  type Accent,
  type ColorMode,
  type Density,
} from './tokens'

/** Keys homologadas de suite: `<app>-color-mode` / `<app>-accent` / `<app>-density`. */
export const STORAGE_KEYS = {
  mode: 'ecommerce-color-mode',
  accent: 'ecommerce-accent',
  density: 'ecommerce-density',
} as const

export interface Appearance {
  mode: ColorMode
  accent: Accent
  density: Density
}

export const DEFAULT_APPEARANCE: Appearance = {
  mode: DEFAULT_COLOR_MODE,
  accent: DEFAULT_ACCENT,
  density: DEFAULT_DENSITY,
}

function readKey<T extends string>(key: string, allowed: readonly T[]): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : null
  } catch {
    return null
  }
}

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** Lee la apariencia del dispositivo (anti-flash). El servidor la hidrata al login. */
export function readStoredAppearance(): Appearance {
  return {
    mode: readKey(STORAGE_KEYS.mode, COLOR_MODES) ?? (prefersDark() ? 'dark' : DEFAULT_COLOR_MODE),
    accent: readKey(STORAGE_KEYS.accent, ACCENTS) ?? DEFAULT_ACCENT,
    density: readKey(STORAGE_KEYS.density, DENSITIES) ?? DEFAULT_DENSITY,
  }
}

/** Persiste omitiendo los defaults (convención de suite: el default no se guarda). */
export function persistAppearance(next: Appearance): void {
  try {
    localStorage.setItem(STORAGE_KEYS.mode, next.mode)
    if (next.accent === DEFAULT_ACCENT) localStorage.removeItem(STORAGE_KEYS.accent)
    else localStorage.setItem(STORAGE_KEYS.accent, next.accent)
    if (next.density === DEFAULT_DENSITY) localStorage.removeItem(STORAGE_KEYS.density)
    else localStorage.setItem(STORAGE_KEYS.density, next.density)
  } catch {
    /* almacenamiento no disponible: la apariencia sigue viva en memoria */
  }
}

/** Refleja la apariencia en el `<html>` para que las CSS vars se resuelvan. */
export function applyAppearanceToDom(next: Appearance, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', next.mode)
  if (next.accent === DEFAULT_ACCENT) root.removeAttribute('data-accent')
  else root.setAttribute('data-accent', next.accent)
  if (next.density === DEFAULT_DENSITY) root.removeAttribute('data-density')
  else root.setAttribute('data-density', next.density)
}
