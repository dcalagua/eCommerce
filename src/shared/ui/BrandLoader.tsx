import { Box, Stack, Typography } from '@mui/material'
import { useT } from '@/shared/i18n/i18n-context'
import { EbimMark } from '@/shared/ui/EbimMark'
import { T } from '@/theme/tokens'

/**
 * Espera con el isotipo de la suite.
 *
 * ## Por que no un `CircularProgress`
 *
 * El aro de MUI dice «algo esta pasando» y nada mas. Una espera que se repite
 * —bajar por un catalogo de seiscientas referencias son varias— es de los pocos
 * momentos en los que la marca se mira de verdad, y el isotipo girando cuesta
 * exactamente lo mismo que el aro.
 *
 * Reutiliza `eb-logo-anim` de `tokens.css`, que es la animacion de suite
 * —«gira y para», no un giro continuo— y que ya trae su apagado bajo
 * `prefers-reduced-motion`. Repetirla aqui con otra curva habria dado dos
 * marcas distintas girando distinto en la misma aplicacion.
 *
 * ## Accesibilidad
 *
 * `role="status"` con `aria-live="polite"`: quien no ve la pantalla se entera
 * de que hay algo cargando sin que le interrumpa lo que estuviera leyendo. El
 * isotipo va dentro de un contenedor `aria-hidden` porque `EbimMark` se anuncia
 * como imagen «EBIM», y ahi lo que importa es «cargando», no la marca.
 */
export function BrandLoader({
  label,
  size = 34,
  /** Sin texto: para huecos pequeños donde el rótulo estorbaría. */
  compact = false,
}: {
  label?: string
  size?: number
  compact?: boolean
}) {
  const t = useT()
  const text = label ?? t('common.loading')

  return (
    <Stack
      role="status"
      aria-live="polite"
      sx={{ alignItems: 'center', justifyContent: 'center', gap: 1.25, py: compact ? 1.5 : 3 }}
    >
      <Box className="eb-logo-anim" aria-hidden sx={{ lineHeight: 0 }}>
        <EbimMark size={size} />
      </Box>
      {compact ? (
        // El texto sigue existiendo para el lector de pantalla aunque no se
        // pinte: un `status` mudo no anuncia nada.
        <Box component="span" sx={visuallyHidden}>
          {text}
        </Box>
      ) : (
        <Typography
          sx={{
            fontSize: T.label,
            fontWeight: 800,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
          }}
        >
          {text}
        </Typography>
      )}
    </Stack>
  )
}

/** Fuera de la vista, dentro del árbol de accesibilidad. */
const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const
