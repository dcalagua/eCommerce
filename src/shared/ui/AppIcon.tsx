import { Box } from '@mui/material'
import type { ReactNode } from 'react'
import { R } from '@/theme/tokens'

export type AppIconTone = 'accent' | 'neutral' | 'warning' | 'danger' | 'info'

/**
 * Icono con envoltura: la pieza que quita el aspecto «vectorial suelto».
 *
 * Un glifo de trazo fino flotando junto a un texto se lee como un adorno. El
 * mismo glifo sobre una pastilla de color tenue se lee como una etiqueta: gana
 * peso, ancla la fila y da ritmo a una lista de tarjetas.
 *
 * **El color de fondo es un tinte, no un color de dato.** Los tonos de aquí
 * nombran una intención (aviso, error) y llevan SIEMPRE texto al lado: el
 * validador de paleta descarta usar estos mismos tokens para codificar
 * categorías —`--red` y `--amber` quedan a ΔE 1,8 en deuteranopía—, así que un
 * icono de color nunca es la única señal de nada.
 *
 * Por defecto es decorativo (`aria-hidden`): en casi todos los sitios la
 * etiqueta de al lado ya nombra la cosa, y un icono anunciado sería ruido
 * repetido. Cuando el icono va solo, se pasa `label` y deja de ser decorativo.
 */
export function AppIcon({
  children,
  tone = 'accent',
  size = 'md',
  label,
}: {
  children: ReactNode
  tone?: AppIconTone
  size?: 'sm' | 'md' | 'lg'
  /** Solo cuando el icono viaja SIN texto: lo saca del modo decorativo. */
  label?: string
}) {
  const box = size === 'sm' ? 28 : size === 'lg' ? 44 : 36

  const tones: Record<AppIconTone, { bg: string; fg: string }> = {
    accent: { bg: 'var(--accent-soft)', fg: 'var(--accent-deep)' },
    neutral: { bg: 'var(--neutral-soft)', fg: 'var(--muted)' },
    warning: { bg: 'var(--amber-soft)', fg: 'var(--amber)' },
    danger: { bg: 'var(--red-soft)', fg: 'var(--red)' },
    info: { bg: 'var(--blue-soft)', fg: 'var(--blue)' },
  }

  const { bg, fg } = tones[tone]

  return (
    <Box
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      sx={{
        width: box,
        height: box,
        flexShrink: 0,
        // Squircle y no círculo: acompaña al radio de las tarjetas del design
        // system en vez de introducir una geometría nueva.
        borderRadius: `${R.md}px`,
        display: 'grid',
        placeItems: 'center',
        bgcolor: bg,
        color: fg,
        '& .MuiSvgIcon-root': { fontSize: size === 'sm' ? 16 : size === 'lg' ? 24 : 20 },
      }}
    >
      {children}
    </Box>
  )
}
