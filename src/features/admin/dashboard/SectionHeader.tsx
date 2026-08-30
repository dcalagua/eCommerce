import { Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { T } from '@/theme/tokens'

/**
 * Rótulo de sección del resumen.
 *
 * Un panel largo sin secciones es una lista de tarjetas y el ojo no sabe dónde
 * empieza un tema y acaba otro. El rótulo agrupa —catálogo, ventas, operación—
 * y da los descansos que hacen legible una pantalla densa.
 *
 * Va como `h2` de verdad: quien navega con lector de pantalla salta por
 * encabezados, y una sección que solo se distingue por ser gris y pequeña no
 * existe para esa persona.
 */
export function SectionHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1 }}>
      <Stack sx={{ color: 'var(--muted)', display: 'flex' }} aria-hidden>
        {icon}
      </Stack>
      <Typography
        component="h2"
        sx={{
          fontSize: T.label,
          fontWeight: 800,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        {title}
      </Typography>
    </Stack>
  )
}
