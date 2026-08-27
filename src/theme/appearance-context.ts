import { createContext, useContext } from 'react'
import { DEFAULT_APPEARANCE, type Appearance } from './appearance'
import type { ColorMode, Density } from './tokens'

export interface AppearanceContextValue {
  appearance: Appearance
  setMode: (mode: ColorMode) => void
  setDensity: (density: Density) => void
  toggleMode: () => void
  hydrate: (next: Partial<Appearance>) => void
}

export const AppearanceContext = createContext<AppearanceContextValue>({
  appearance: DEFAULT_APPEARANCE,
  setMode: () => {},
  setDensity: () => {},
  toggleMode: () => {},
  hydrate: () => {},
})

export function useAppearance(): AppearanceContextValue {
  return useContext(AppearanceContext)
}
