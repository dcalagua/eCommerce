import { Box } from '@mui/material'
import { R, T } from '@/theme/tokens'

/** Ancla del contenido principal. Un único sitio: el enlace y el `<main>`. */
export const CONTENT_ANCHOR = 'contenido'

/**
 * «Ir al contenido» (WCAG 2.4.1 · Bypass Blocks).
 *
 * Tiene que ser el PRIMER elemento enfocable del documento y estar oculto
 * hasta que recibe el foco: si se ve siempre, es ruido para quien navega con
 * ratón; si no aparece al enfocarlo, es una trampa para quien navega con
 * teclado —salta a un sitio y no sabe dónde está—.
 *
 * Se esconde con `clip` y no con `display: none` ni `visibility: hidden`: esos
 * dos lo sacan del orden de tabulación y el enlace deja de existir justo para
 * quien lo necesita.
 *
 * El destino lleva `tabIndex={-1}` en el `<main>`; sin eso el navegador mueve
 * el scroll pero no el foco, y el siguiente Tab devuelve al principio.
 */
export function SkipToContentLink({ label }: { label: string }) {
  return (
    <Box
      component="a"
      href={`#${CONTENT_ANCHOR}`}
      onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
        // La vitrina usa el router: un `#hash` normal navegaría a
        // `/s/slug#contenido` y dejaría una entrada de historial por cada
        // salto. Se mueve el foco a mano y se deja la URL como estaba.
        event.preventDefault()
        const target = document.getElementById(CONTENT_ANCHOR)
        // Mover el FOCO es lo obligatorio; desplazar la vista es la comodidad
        // que lo acompaña. `scrollIntoView` no existe en todos los entornos
        // —jsdom es uno—, y que falte no puede impedir el salto: se llama
        // opcionalmente para que el fallo del adorno no se lleve por delante lo
        // que la pauta exige.
        target?.focus()
        target?.scrollIntoView?.({ block: 'start' })
      }}
      sx={{
        position: 'absolute',
        left: 8,
        top: 8,
        zIndex: 10,
        width: 1,
        height: 1,
        overflow: 'hidden',
        clip: 'rect(0 0 0 0)',
        clipPath: 'inset(50%)',
        whiteSpace: 'nowrap',
        bgcolor: 'var(--card)',
        color: 'var(--accent-deep)',
        border: '2px solid var(--accent-deep)',
        borderRadius: `${R.md}px`,
        fontSize: T.bodyStrong,
        fontWeight: 800,
        textDecoration: 'none',
        '&:focus, &:focus-visible': {
          width: 'auto',
          height: 'auto',
          clip: 'auto',
          clipPath: 'none',
          px: 2,
          py: 1,
        },
      }}
    >
      {label}
    </Box>
  )
}
