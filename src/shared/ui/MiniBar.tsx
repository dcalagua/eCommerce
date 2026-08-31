import { Box } from '@mui/material'

/**
 * Barra de proporción para una celda de tabla.
 *
 * Una columna de números ordenados de mayor a menor dice cuál es el primero,
 * pero no si el primero dobla al segundo o le saca un 3 %. La barra responde
 * eso de un vistazo y no cuesta ni una fila más: va DEBAJO del número, en la
 * misma celda.
 *
 * Es DECORATIVA (`aria-hidden`): la cifra exacta está en la misma celda, así
 * que anunciar además un `meter` obligaría a escuchar dos veces el mismo dato.
 *
 * **Un solo tono, el del acento.** No codifica categoría —para eso la fila ya
 * tiene su nombre—; codifica magnitud, y la magnitud es una sola serie. El
 * largo es proporcional al MÁXIMO de la columna, no al total: la pregunta que
 * responde es «cuál destaca», no «qué porción del todo es».
 */
export function MiniBar({
  value,
  max,
  tone = 'accent',
}: {
  value: number
  max: number
  tone?: 'accent' | 'warning'
}) {
  const safeMax = max > 0 ? max : 0
  // Un valor > 0 nunca se pinta como nada: 2 % de ancho mínimo para que «poco»
  // y «cero» no se vean igual.
  const percent = safeMax === 0 ? 0 : Math.max((Math.max(value, 0) / safeMax) * 100, value > 0 ? 2 : 0)

  return (
    <Box
      aria-hidden
      sx={{
        mt: 0.5,
        height: 4,
        width: '100%',
        borderRadius: 999,
        bgcolor: 'var(--neutral-soft)',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          width: `${percent}%`,
          height: '100%',
          borderRadius: 999,
          bgcolor: tone === 'warning' ? 'var(--amber)' : 'var(--accent)',
        }}
      />
    </Box>
  )
}
