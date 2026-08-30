import { Box, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { T } from '@/theme/tokens'

export interface BarRow {
  /** Clave estable: no se usa para pintar, solo para React. */
  id: string
  label: string
  /** Valor que marca el largo de la barra. */
  value: number
  /** Lo que se lee al final de la fila: ya formateado por quien llama. */
  display: string
  icon?: ReactNode
}

/**
 * Barras horizontales para comparar magnitudes entre pocas categorías.
 *
 * **Un solo color para todas las barras, a propósito.** Los tokens de estado de
 * EBIM no sirven para codificar categorías: el validador de paleta da ΔE 1,8
 * entre `--red` y `--amber` en deuteranopía y 12,3 en visión normal —por debajo
 * del suelo de 15—, y el par acento/gris se queda en 10,1. Con esos números, una
 * barra por color sería ilegible para una parte de los usuarios y confusa para
 * el resto. La identidad la lleva la ETIQUETA, que además es lo que manda la
 * regla de accesibilidad: nunca solo color.
 *
 * Barras horizontales y no verticales porque las etiquetas son texto de largo
 * variable —«Silla plegable de abedul»— y en vertical habría que girarlas.
 *
 * El largo es proporcional al MÁXIMO de la serie, no al total: la pregunta que
 * responde es «cuál destaca», no «qué porción del todo es cada uno».
 */
export function BarList({ rows, emptyLabel }: { rows: BarRow[]; emptyLabel: string }) {
  if (rows.length === 0) {
    return (
      <Typography sx={{ fontSize: T.body, color: 'var(--muted)', py: 2 }}>{emptyLabel}</Typography>
    )
  }

  const max = Math.max(...rows.map((row) => row.value), 1)

  return (
    <Stack component="ul" sx={{ gap: 1.75, m: 0, p: 0, listStyle: 'none' }}>
      {rows.map((row) => {
        const percent = Math.max((row.value / max) * 100, row.value > 0 ? 2 : 0)
        return (
          <Stack component="li" key={row.id} sx={{ gap: 0.5 }}>
            <Stack
              direction="row"
              sx={{ alignItems: 'center', gap: 1, justifyContent: 'space-between' }}
            >
              <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                {row.icon}
                <Typography
                  sx={{
                    fontSize: T.body,
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.label}
                </Typography>
              </Stack>
              {/* El valor va SIEMPRE escrito. Una barra sin cifra obliga a
                  estimar contra un eje que aquí no existe. */}
              <Typography
                className="tnum"
                sx={{ fontSize: T.body, fontWeight: 800, whiteSpace: 'nowrap' }}
              >
                {row.display}
              </Typography>
            </Stack>
            <Box
              sx={{
                height: 8,
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
                  bgcolor: 'var(--accent)',
                }}
              />
            </Box>
          </Stack>
        )
      })}
    </Stack>
  )
}
