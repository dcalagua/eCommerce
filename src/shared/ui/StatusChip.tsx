import { Box } from '@mui/material'
import { T } from '@/theme/tokens'

export type StatusTone = 'default' | 'info' | 'success' | 'warning' | 'error'

/**
 * Etiqueta de estado.
 *
 * Sustituye al `Chip` de MUI en las tablas por una razón concreta: una fila con
 * tres estados llevaba un chip RELLENO y dos de contorno, así que tres datos del
 * mismo rango pesaban distinto y el relleno saturado se comía la fila. Aquí los
 * tres pesan igual —fondo tenue, texto del color, sin borde grueso— y lo que
 * distingue a uno de otro es lo que dice, no cuánto grita.
 *
 * El color **acompaña**, nunca informa a solas: el validador de paleta deja
 * `--red` y `--amber` en ΔE 1,8 bajo deuteranopía, así que la etiqueta de texto
 * no es opcional ni decorativa. Es la que lleva el significado.
 */
export function StatusChip({ tone = 'default', label }: { tone?: StatusTone; label: string }) {
  const tones: Record<StatusTone, { bg: string; fg: string }> = {
    default: { bg: 'var(--neutral-soft)', fg: 'var(--muted)' },
    info: { bg: 'var(--blue-soft)', fg: 'var(--blue)' },
    success: { bg: 'var(--accent-soft)', fg: 'var(--accent-deep)' },
    warning: { bg: 'var(--amber-soft)', fg: 'var(--amber)' },
    error: { bg: 'var(--red-soft)', fg: 'var(--red)' },
  }

  const { bg, fg } = tones[tone]

  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        px: 1,
        py: 0.375,
        borderRadius: 999,
        bgcolor: bg,
        color: fg,
        fontSize: T.label,
        fontWeight: 700,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Box>
  )
}
