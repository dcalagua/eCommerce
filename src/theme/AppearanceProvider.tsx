import { CssBaseline, ThemeProvider } from '@mui/material'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppearanceContext, type AppearanceContextValue } from './appearance-context'
import {
  DEFAULT_APPEARANCE,
  applyAppearanceToDom,
  hasStoredDensity,
  persistAppearance,
  readStoredAppearance,
  type Appearance,
} from './appearance'
import { createEbimTheme } from './createEbimTheme'
import { DENSITIES } from './tokens'
import './tokens.css'

interface Props {
  children: ReactNode
  /** `accent_color` del tenant. El usuario nunca elige color (contrato §4.4). */
  tenantAccent?: string | null
  /**
   * Tokens de white-label de la tienda (P11-SaaS). Los tres llegan de
   * `store_settings` y **solo los usa la vitrina**: el backoffice sigue con la
   * apariencia que elige cada usuario.
   *
   * `tenantDensity` es un DEFAULT, no una imposición: si el usuario ya eligió
   * densidad en este dispositivo, la suya manda. La tienda decide cómo se ve
   * para quien llega sin preferencia; quien tiene una, la conserva.
   */
  tenantFont?: string | null
  tenantRadius?: string | null
  tenantDensity?: string | null
  initial?: Appearance
}

export function AppearanceProvider({
  children,
  tenantAccent = null,
  tenantFont = null,
  tenantRadius = null,
  tenantDensity = null,
  initial,
}: Props) {
  const [appearance, setAppearance] = useState<Appearance>(
    () => initial ?? (typeof window === 'undefined' ? DEFAULT_APPEARANCE : readStoredAppearance()),
  )

  // La densidad de la tienda solo se aplica si el visitante NO tiene una
  // elegida: pisarla convertiría una preferencia de accesibilidad en una
  // decisión del comercio.
  const effective = useMemo<Appearance>(() => {
    if (!tenantDensity || hasStoredDensity()) return appearance
    return (DENSITIES as readonly string[]).includes(tenantDensity)
      ? { ...appearance, density: tenantDensity as Appearance['density'] }
      : appearance
  }, [appearance, tenantDensity])

  useEffect(() => {
    applyAppearanceToDom(effective)
    persistAppearance(appearance)
  }, [appearance, effective])

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
        mode: effective.mode,
        accent: effective.accent,
        density: effective.density,
        tenantAccent,
        tenantFont,
        tenantRadius,
      }),
    [effective, tenantAccent, tenantFont, tenantRadius],
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
