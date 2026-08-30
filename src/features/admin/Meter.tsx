import { Box, Stack, Typography } from '@mui/material'
import { T } from '@/theme/tokens'

/**
 * Medidor: una razón contra un límite.
 *
 * Es la forma que corresponde a «9 publicados de 11», y **no** una tarta de dos
 * porciones: con dos segmentos el ojo compara ángulos para leer algo que un
 * largo resuelve mejor, y encima obligaría a dos colores adyacentes que esta
 * paleta no puede dar (el validador deja el par acento/gris en ΔE 10,1, bajo el
 * suelo de 15).
 *
 * Un solo tono sobre una pista neutra: la pista no es una serie, es superficie,
 * así que no hay dos colores compitiendo por significar cosas distintas.
 *
 * El porcentaje va escrito además de dibujado. Un medidor sin cifra obliga a
 * estimar, y estimar es justo lo que no debe hacer quien mira un panel.
 */
export function Meter({
  label,
  value,
  total,
  caption,
}: {
  label: string
  value: number
  total: number
  caption: string
}) {
  const safeTotal = total > 0 ? total : 0
  const percent = safeTotal === 0 ? 0 : Math.round((value / safeTotal) * 100)

  return (
    <Stack sx={{ gap: 0.75 }}>
      <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
        <Typography sx={{ fontSize: T.body, fontWeight: 600 }}>{label}</Typography>
        <Typography className="tnum" sx={{ fontSize: T.body, fontWeight: 800, whiteSpace: 'nowrap' }}>
          {/* Sin total no hay razón que afirmar: un 0 % inventado se lee como
              un dato, igual que un cero en las ventas. */}
          {safeTotal === 0 ? '—' : `${percent}%`}
        </Typography>
      </Stack>

      <Box
        role="meter"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={safeTotal}
        aria-valuetext={`${value} de ${safeTotal}`}
        sx={{ height: 10, borderRadius: 999, bgcolor: 'var(--neutral-soft)', overflow: 'hidden' }}
      >
        <Box
          sx={{
            width: `${safeTotal === 0 ? 0 : Math.max(percent, 2)}%`,
            height: '100%',
            borderRadius: 999,
            bgcolor: 'var(--accent)',
          }}
        />
      </Box>

      <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>{caption}</Typography>
    </Stack>
  )
}
