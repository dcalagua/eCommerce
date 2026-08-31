import { Card, Grid, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Button } from '@mui/material'
import { AppIcon, type AppIconTone } from '@/shared/ui/AppIcon'
import { T } from '@/theme/tokens'

export interface Insight {
  id: string
  tone: AppIconTone
  icon: ReactNode
  title: string
  body: string
  action?: { label: string; to: string }
}

/**
 * Aviso del resumen: lo que hay que MIRAR hoy, no una cifra más.
 *
 * Solo se pinta si hay algo que decir. Un banner permanente que dice «todo va
 * bien» enseña al usuario a ignorar esa zona de la pantalla, y el día que
 * aparezca un aviso de verdad tampoco lo leerá.
 *
 * Cada aviso lleva icono **y** texto, nunca color a secas: los tonos de la
 * paleta no separan lo suficiente para distinguirse por sí solos —el validador
 * deja `--red` y `--amber` en ΔE 1,8 bajo deuteranopía—, así que lo que
 * distingue un aviso de otro es lo que dice.
 *
 * ## Por qué van en rejilla y no apilados a todo lo ancho
 *
 * Un aviso son dos líneas cortas y un botón. A pantalla completa el botón se va
 * al otro extremo del monitor y entre el texto y él queda medio metro de nada:
 * el ojo tiene que recorrer ese vacío para saber qué hacer con el aviso. En dos
 * columnas el texto y su acción caben en el mismo golpe de vista, y dos avisos
 * ocupan una banda en vez de dos. Con un solo aviso se deja a todo el ancho:
 * una tarjeta suelta a media pantalla parece un hueco de carga.
 */
export function InsightBanner({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) return null

  const span = insights.length === 1 ? 12 : 6

  return (
    <Grid container spacing={1.5}>
      {insights.map((insight) => (
        <Grid item xs={12} md={span} key={insight.id}>
          <Card sx={{ height: '100%', px: 2, py: 1.25 }}>
            <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
              <AppIcon tone={insight.tone} size="sm">
                {insight.icon}
              </AppIcon>
              <Stack sx={{ flex: 1, minWidth: 0, gap: 0 }}>
                <Typography sx={{ fontSize: T.body, fontWeight: 800, lineHeight: 1.35 }}>
                  {insight.title}
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.35 }}>
                  {insight.body}
                </Typography>
              </Stack>
              {insight.action && (
                <Button
                  component={RouterLink}
                  to={insight.action.to}
                  size="small"
                  variant="outlined"
                  sx={{ flexShrink: 0 }}
                >
                  {insight.action.label}
                </Button>
              )}
            </Stack>
          </Card>
        </Grid>
      ))}
    </Grid>
  )
}
