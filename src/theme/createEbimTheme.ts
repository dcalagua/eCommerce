import { createTheme, type Theme } from '@mui/material/styles'
import {
  ACCENT_HEX,
  DENSITY_METRICS,
  T,
  brandFontStack,
  brandRadiusScale,
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
  /**
   * Tokens de white-label del tenant (P11-SaaS). Los dos son OPCIONALES y con
   * valor nulo el tema es exactamente el de suite: un tenant que no los toca no
   * puede notar que existen.
   *
   * `tenantFont` es un TOKEN de `BRAND_FONTS`, nunca una pila CSS ni una URL:
   * un valor desconocido cae a la de suite en vez de acabar en un
   * `font-family` que el navegador interpreta.
   */
  tenantFont?: string | null
  tenantRadius?: string | null
}

/**
 * El color es 100% del tenant (contrato §4.4): si hay `tenantAccent` se usa como
 * `primary.main`; si no, cae al preset de casa. El usuario solo elige modo y densidad.
 */
export function createEbimTheme({
  mode,
  accent,
  density,
  tenantAccent,
  tenantFont = null,
  tenantRadius = null,
}: EbimThemeInput): Theme {
  const isDark = mode === 'dark'
  const preset = ACCENT_HEX[accent]
  const main = tenantAccent || (isDark ? preset.dark : preset.light)
  const deep = tenantAccent || (isDark ? preset.darkDeep : preset.lightDeep)
  const d = DENSITY_METRICS[density]
  // `R` deja de importarse del módulo y pasa a resolverse por token: con
  // `tenantRadius` nulo, `brandRadiusScale` devuelve EXACTAMENTE la escala de
  // suite, así que el tema de un tenant sin white-label no cambia ni un píxel.
  const R = brandRadiusScale(tenantRadius)
  const fontFamily = brandFontStack(tenantFont)

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
      fontFamily,
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
          root: {
            borderRadius: R.md,
            // Unico anillo de foco del campo: el propio fieldset a 2px con el
            // token AA (`accent-deep`). El outline global de :focus-visible esta
            // desactivado sobre el <input> (tokens.css) para no pintar un
            // segundo borde por dentro.
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderWidth: 2,
              borderColor: deep,
            },
            // Multilinea: MUI pone el padding vertical en el root y deja el textarea
            // a 0 (OutlinedInput.js:98/161). Hay que aplicarlo al root, no al textarea,
            // o se sumarian los dos y doblarian el alto.
            '&.MuiInputBase-multiline': { paddingTop: d.padY, paddingBottom: d.padY },
          },
          // Aire interior del campo, de la densidad activa. El alto NO se fija: sale
          // del padding, asi el control crece con la fuente y el textarea con su
          // contenido (minRows) en lugar de quedar recortado.
          input: { paddingTop: d.padY, paddingBottom: d.padY },
          inputMultiline: { paddingTop: 0, paddingBottom: 0 },
        },
      },
      MuiInputLabel: {
        styleOverrides: {
          // La etiqueta en reposo se situa en px desde el borde superior del control:
          // no puede centrarse con 50% porque es absolute respecto al FormControl,
          // que incluye el texto de ayuda. Etiqueta y valor miden ambos 1.4375em
          // (FormLabel.js:46 / InputBase.js:140), asi que el offset que la centra en
          // el control se reduce a `padding superior + borde`. MUI trae 16px fijos,
          // calibrados para su padding de 16.5px, y dejaban la etiqueta caida abajo.
          outlined: {
            transform: `translate(14px, ${d.padY + 1}px) scale(1)`,
            '&.MuiInputLabel-shrink': { transform: 'translate(14px, -9px) scale(0.75)' },
          },
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
            // Cabecera en gris solido. `color-mix` sobre el token `--muted` en
            // vez de un hex: asi el gris sale del tema y funciona igual en
            // claro que en oscuro, sin cablear dos colores.
            color: 'var(--text)',
            backgroundColor: 'color-mix(in srgb, var(--muted) 15%, var(--card))',
            borderBottom: '1px solid var(--border)',
          },
          // Solo lineas HORIZONTALES. Las verticales convierten la tabla en
          // una hoja de calculo y compiten con las etiquetas de estado, que ya
          // tienen forma propia. Vive en el tema y no en cada pantalla porque
          // son ~56 tablas: en linea, el proximo retoque del gris son 56
          // ediciones y una de ellas se queda sin hacer.
          body: { borderBottom: '1px solid var(--border)' },
        },
      },
      MuiTableRow: { styleOverrides: { root: { height: d.rowH } } },
      // La ultima fila no lleva raya: el borde de la tarjeta ya cierra la
      // tabla y dos lineas pegadas se leen como un error de pintado.
      MuiTableBody: {
        styleOverrides: { root: { '& tr:last-of-type td': { borderBottom: 0 } } },
      },
      MuiLink: {
        styleOverrides: { root: { color: deep, textDecorationColor: 'transparent' } },
      },
    },
  })
}
