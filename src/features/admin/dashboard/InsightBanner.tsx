import { Card, Stack, Typography } from '@mui/material'
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
 */
export function InsightBanner({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) return null

  return (
    <Stack sx={{ gap: 1.25 }}>
      {insights.map((insight) => (
        <Card key={insight.id} sx={{ p: { xs: 1.75, md: 2 } }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
            <AppIcon tone={insight.tone}>{insight.icon}</AppIcon>
            <Stack sx={{ flex: 1, minWidth: 0, gap: 0.25 }}>
              <Typography sx={{ fontSize: T.body, fontWeight: 800 }}>{insight.title}</Typography>
              <Typography sx={{ fontSize: T.body, color: 'var(--muted)' }}>
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
      ))}
    </Stack>
  )
}
