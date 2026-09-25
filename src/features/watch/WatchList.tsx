import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded'
import PlaceRoundedIcon from '@mui/icons-material/PlaceRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import type { WatchFinding, WatchResult } from './api'
import { useDismissWatch, useRestoreWatch } from './useWatch'

/**
 * Las tarjetas del centro de vigilancia, en la forma del EBIM Crew de la suite:
 * una franja de color por severidad, el punto con su nombre, el módulo que lo
 * levantó, el título, dos líneas de contexto y dos acciones abajo a la derecha.
 *
 * Las mismas tarjetas se usan en el cajón lateral y en el bloque del dashboard:
 * dos sitios que enseñan cosas distintas son dos sitios que un día se
 * contradicen.
 *
 * ✕ silencia el aviso con la cifra que tenía. ✓ lleva a la pantalla donde se
 * arregla — no lo marca como resuelto, porque resuelto lo dirá el dato cuando
 * cambie, no un botón.
 */

function textOf(finding: WatchFinding, t: (key: MessageKey) => string): { title: string; body: string } {
  const title = t(`watch.finding.${finding.key}.title` as MessageKey)
  let body = t(`watch.finding.${finding.key}.body` as MessageKey)
  for (const [name, value] of Object.entries(finding.metrics)) {
    body = body.split(`{${name}}`).join(String(value))
  }
  return { title, body: body.split('{count}').join(String(finding.count)) }
}

export function WatchCard({
  finding,
  onNavigate,
  muted = false,
  why = null,
}: {
  finding: WatchFinding
  onNavigate?: () => void
  muted?: boolean
  /** Por qué va aquí, según el análisis de IA. Sin análisis, no hay línea. */
  why?: string | null
}) {
  const { t } = useI18n()
  const dismiss = useDismissWatch()
  const restore = useRestoreWatch()
  const { title, body } = textOf(finding, t)
  const critica = finding.severity === 'critica'
  const color = critica ? 'var(--danger)' : 'var(--warning)'

  return (
    <Box
      sx={{
        position: 'relative',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`,
        bgcolor: 'var(--card)',
        px: 1.75,
        py: 1.5,
        opacity: muted ? 0.6 : 1,
      }}
    >
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', mb: 0.75 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: color }} aria-hidden />
          <Typography sx={{ fontSize: 12, fontWeight: 700, color }}>
            {t(`watch.severity.${finding.severity}` as MessageKey)}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={0.4} sx={{ alignItems: 'center', color: 'var(--muted)' }}>
          <PlaceRoundedIcon sx={{ fontSize: 13 }} />
          <Typography sx={{ fontSize: 12 }}>
            {t(`watch.module.${finding.module}` as MessageKey)}
          </Typography>
        </Stack>
      </Stack>

      <Typography sx={{ fontWeight: 800, fontSize: 14.5, lineHeight: 1.35, mb: 0.4 }}>{title}</Typography>
      <Typography
        sx={{
          fontSize: 13,
          color: 'var(--muted)',
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {body}
        {finding.samples.length > 0 && ` · ${finding.samples.map((sample) => sample.label).join(', ')}`}
      </Typography>

      {why && (
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start', mt: 0.75 }}>
          <AutoAwesomeRoundedIcon sx={{ fontSize: 13, color: 'var(--accent-deep)', mt: '2px' }} />
          <Typography sx={{ fontSize: 12.5, color: 'var(--accent-deep)', lineHeight: 1.45 }}>{why}</Typography>
        </Stack>
      )}

      <Stack direction="row" spacing={0.25} sx={{ justifyContent: 'flex-end', mt: 0.75 }}>
        {muted ? (
          <Tooltip title={t('watch.restore')}>
            <span>
              <IconButton
                size="small"
                aria-label={`${t('watch.restore')}: ${title}`}
                disabled={restore.isPending}
                onClick={() => restore.mutate(finding.key)}
              >
                <UndoRoundedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        ) : (
          <Tooltip title={t('watch.dismiss')}>
            <span>
              <IconButton
                size="small"
                aria-label={`${t('watch.dismiss')}: ${title}`}
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate({ key: finding.key, fingerprint: finding.fingerprint })}
                sx={{ color: 'var(--muted)' }}
              >
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title={t('watch.open')}>
          <IconButton
            size="small"
            component={RouterLink}
            to={finding.href}
            onClick={onNavigate}
            aria-label={`${t('watch.open')}: ${title}`}
            sx={{ color: 'var(--accent-deep)' }}
          >
            <CheckRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  )
}

export function WatchList({
  query,
  onNavigate,
}: {
  query: {
    data: WatchResult | undefined
    isPending: boolean
    isError: boolean
    refetch: () => unknown
  }
  onNavigate?: () => void
}) {
  const { t } = useI18n()
  const [verSilenciados, setVerSilenciados] = useState(false)
  const items = query.data?.items ?? []
  const dismissed = query.data?.dismissed ?? []

  if (query.isPending) return <LoadingState label={t('common.loading')} />
  if (query.isError) {
    return <ErrorState description={t('watch.error')} onRetry={() => void query.refetch()} />
  }

  return (
    <Stack spacing={1.25} aria-live="polite">
      {items.length === 0 && (
        <EmptyState
          title={t('watch.empty.title')}
          description={t('watch.empty.body')}
          icon={<MonitorHeartRoundedIcon fontSize="small" />}
        />
      )}
      {items.map((finding) => (
        <WatchCard key={finding.key} finding={finding} onNavigate={onNavigate} />
      ))}

      {/* Lo silenciado se DICE, no se esconde: un panel en calma porque alguien
          tapó tres avisos es un panel que miente. */}
      {dismissed.length > 0 && (
        <Button
          size="small"
          variant="text"
          onClick={() => setVerSilenciados((v) => !v)}
          sx={{ alignSelf: 'flex-start' }}
        >
          {(verSilenciados ? t('watch.hideDismissed') : t('watch.showDismissed')).replace(
            '{n}',
            String(dismissed.length),
          )}
        </Button>
      )}
      {verSilenciados &&
        dismissed.map((finding) => (
          <WatchCard key={`muted-${finding.key}`} finding={finding} onNavigate={onNavigate} muted />
        ))}
    </Stack>
  )
}
