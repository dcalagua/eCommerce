import { CssBaseline, ThemeProvider } from '@mui/material'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppearanceContext, type AppearanceContextValue } from './appearance-context'
import {
  DEFAULT_APPEARANCE,
  applyAppearanceToDom,
  persistAppearance,
  readStoredAppearance,
  type Appearance,
} from './appearance'
import { createEbimTheme } from './createEbimTheme'
import './tokens.css'

interface Props {
  children: ReactNode
  /** `accent_color` del tenant. El usuario nunca elige color (contrato §4.4). */
  tenantAccent?: string | null
  initial?: Appearance
}

export function AppearanceProvider({ children, tenantAccent = null, initial }: Props) {
  const [appearance, setAppearance] = useState<Appearance>(
    () => initial ?? (typeof window === 'undefined' ? DEFAULT_APPEARANCE : readStoredAppearance()),
  )

  useEffect(() => {
    applyAppearanceToDom(appearance)
    persistAppearance(appearance)
  }, [appearance])

  const value = useMemo<AppearanceContextValue>(
    () => ({
      appearance,
      /** Solo modo y densidad son elegibles por el usuario. */
      setMode: (mode) => setAppearance((prev) => ({ ...prev, mode })),
      setDensity: (density) => setAppearance((prev) => ({ ...prev, density })),
      toggleMode: () =>
        setAppearance((prev) => ({ ...prev, mode: prev.mode === 'dark' ? 'light' : 'dark' })),
      /** Hidratación desde `profiles.settings.appearance` al login (cross-device). */
      hydrate: (next) => setAppearance((prev) => ({ ...prev, ...next })),
    }),
    [appearance],
  )

  const theme = useMemo(
    () =>
      createEbimTheme({
        mode: appearance.mode,
        accent: appearance.accent,
        density: appearance.density,
        tenantAccent,
      }),
    [appearance, tenantAccent],
  )

  return (
    <AppearanceContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </AppearanceContext.Provider>
  )
}
