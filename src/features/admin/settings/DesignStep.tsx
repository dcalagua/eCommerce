import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import { Box, Button, Collapse, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { R, TS } from '@/theme/tokens'

/**
 * Un paso del taller de diseño (Resumen v2 · «Diseño de tienda» por pasos).
 *
 * La cabecera es un BOTÓN con `aria-expanded`: se abre y se cierra con el
 * teclado igual que con el ratón, y un lector de pantalla anuncia si está
 * abierto. Cerrado enseña su resumen —lo que se eligió—, así que el taller se
 * lee de arriba abajo sin abrir nada. Abierto lleva el borde del acento: es
 * donde está la decisión.
 *
 * El contenido se DESMONTA al cerrar: cinco pasos abiertos a la vez es el
 * scroll largo que este diseño viene a quitar.
 */
export function DesignStep({
  id,
  numero,
  titulo,
  resumen,
  abierto,
  hecho,
  onAlternar,
  siguiente,
  children,
}: {
  id: string
  numero: number
  titulo: string
  /** Lo que se eligió en el paso, dicho en una línea. */
  resumen: string
  abierto: boolean
  hecho: boolean
  onAlternar: () => void
  /** Texto e intención del botón «Siguiente» al pie del paso abierto. */
  siguiente?: { etiqueta: string; onClick: () => void } | null
  children: ReactNode
}) {
  const cuerpo = `paso-${id}`

  return (
    <Box
      id={`diseno-${id}`}
      data-design-step={id}
      data-open={abierto ? 'true' : 'false'}
      sx={{
        borderRadius: `${R.lg}px`,
        border: abierto ? '2px solid var(--accent)' : '1px solid var(--border)',
        bgcolor: 'var(--card)',
        scrollMarginTop: 96,
      }}
    >
      <Stack
        component="button"
        type="button"
        direction="row"
        onClick={onAlternar}
        aria-expanded={abierto}
        aria-controls={cuerpo}
        sx={{
          width: '100%',
          alignItems: 'center',
          gap: 1.5,
          px: 2,
          py: 1.5,
          border: 0,
          bgcolor: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
          color: 'inherit',
          borderRadius: `${R.lg}px`,
          '&:focus-visible': { outline: '2px solid var(--accent-deep)', outlineOffset: 2 },
        }}
      >
        <Box
          aria-hidden
          sx={{
            width: 28,
            height: 28,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            borderRadius: '50%',
            fontSize: 12.5,
            fontWeight: 800,
            bgcolor: abierto ? 'var(--accent)' : hecho ? 'var(--accent-soft)' : 'var(--neutral-soft)',
            color: abierto ? '#fff' : hecho ? 'var(--accent-deep)' : 'var(--muted)',
          }}
        >
          {hecho && !abierto ? <CheckRoundedIcon sx={{ fontSize: 17 }} /> : numero}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h3" sx={{ fontSize: TS.bodyStrong, fontWeight: 800, lineHeight: 1.3 }}>
            {titulo}
          </Typography>
          <Typography
            sx={{ fontSize: TS.label, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {resumen}
          </Typography>
        </Box>
        <ExpandMoreRoundedIcon
          aria-hidden
          sx={{
            color: 'var(--muted)',
            transform: abierto ? 'rotate(180deg)' : 'none',
            transition: 'transform .15s ease',
            '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
          }}
        />
      </Stack>

      <Collapse in={abierto} unmountOnExit>
        <Stack id={cuerpo} sx={{ gap: 2, px: 2, pb: 2 }}>
          {children}
          {siguiente ? (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                type="button"
                variant="contained"
                onClick={siguiente.onClick}
                endIcon={<ArrowForwardRoundedIcon />}
                sx={{ textTransform: 'none', fontWeight: 800 }}
              >
                {siguiente.etiqueta}
              </Button>
            </Box>
          ) : null}
        </Stack>
      </Collapse>
    </Box>
  )
}
