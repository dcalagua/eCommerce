import { createTheme, type Theme } from '@mui/material/styles'
import {
  ACCENT_HEX,
  DENSITY_METRICS,
  FONT_STACK,
  R,
  T,
  type Accent,
  type ColorMode,
  type Density,
} from './tokens'

declare module '@mui/material/styles' {
  interface Palette {
    /** Color de texto/links accesible (~4.5:1). Ver contrato EBIM §4.4 regla AA. */
    accentDeep: string
  }
  interface PaletteOptions {
    accentDeep?: string
  }
}

export interface EbimThemeInput {
  mode: ColorMode
  accent: Accent
  density: Density
  /** `accent_color` del tenant (Branding). Manda sobre el preset cuando existe. */
  tenantAccent?: string | null
}

/**
 * El color es 100% del tenant (contrato §4.4): si hay `tenantAccent` se usa como
 * `primary.main`; si no, cae al preset de casa. El usuario solo elige modo y densidad.
 */
export function createEbimTheme({ mode, accent, density, tenantAccent }: EbimThemeInput): Theme {
  const isDark = mode === 'dark'
  const preset = ACCENT_HEX[accent]
  const main = tenantAccent || (isDark ? preset.dark : preset.light)
  const deep = tenantAccent || (isDark ? preset.darkDeep : preset.lightDeep)
  const d = DENSITY_METRICS[density]

  return createTheme({
    palette: {
      mode,
      primary: { main },
      accentDeep: deep,
      background: {
        default: isDark ? '#0F1715' : '#F3F5F5',
        paper: isDark ? '#172320' : '#FFFFFF',
      },
      text: {
        primary: isDark ? '#EAF2EF' : '#0F1B1C',
        secondary: isDark ? '#9AADA6' : '#5C6B6C',
      },
      divider: isDark ? '#27332E' : '#E2E8E7',
      warning: { main: isDark ? '#F0C75A' : '#946200' },
      error: { main: isDark ? '#F08A82' : '#C0392B' },
      info: { main: isDark ? '#7FB2EE' : '#1E5FB0' },
    },
    shape: { borderRadius: R.md },
    typography: {
      fontFamily: FONT_STACK,
      fontSize: T.body,
      h1: { fontSize: T.hero, fontWeight: 800, letterSpacing: -0.6, lineHeight: 1.12 },
      h2: { fontSize: T.pageTitle, fontWeight: 800, letterSpacing: -0.4, lineHeight: 1.15 },
      h3: { fontSize: T.cardTitle, fontWeight: 700, letterSpacing: -0.2 },
      body1: { fontSize: T.body, fontWeight: 500 },
      body2: { fontSize: T.bodyStrong, fontWeight: 500 },
      button: { fontSize: T.body, fontWeight: 700, textTransform: 'none' },
      overline: { fontSize: T.label, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { backgroundColor: 'var(--bg)', color: 'var(--text)' },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none', borderRadius: R.lg },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: R.lg,
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-sm)',
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: R.md, minHeight: d.controlH, paddingInline: d.padX },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: { borderRadius: R.md },
          input: { paddingTop: d.padY, paddingBottom: d.padY },
        },
      },
      MuiChip: {
        styleOverrides: { root: { borderRadius: R.pill, fontWeight: 700 } },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { paddingTop: d.padY, paddingBottom: d.padY, paddingInline: d.padX },
          head: {
            fontSize: T.micro,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
          },
        },
      },
      MuiTableRow: { styleOverrides: { root: { height: d.rowH } } },
      MuiLink: {
        styleOverrides: { root: { color: deep, textDecorationColor: 'transparent' } },
      },
    },
  })
}
