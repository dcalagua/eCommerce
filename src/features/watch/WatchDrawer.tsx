import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import {
  Badge,
  Box,
  Button,
  Card,
  Chip,
  Drawer,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import { useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { AppIcon } from '@/shared/ui/AppIcon'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import type { WatchFinding } from './api'
import { useDismissWatch, useRestoreWatch, useWatch } from './useWatch'

const TITLE_ID = 'ebim-watch-title'

/**
 * Centro de vigilancia: qué está en rojo ahora mismo, de todos los módulos.
 *
 * Las tarjetas las calcula `public.watch_findings` con reglas de SQL; aquí solo
 * se traducen. Por eso el panel no espera a ninguna IA para decir que hay trece
 * pedidos sin cobrar: eso es una cuenta, no una opinión.
 *
 * Las dos acciones son las del contrato de la suite: la flecha LLEVA a la
 * pantalla donde se arregla y la X silencia el aviso con la cifra que tenía. Si
 * la cifra cambia, el aviso vuelve solo. Nada se resuelve desde aquí.
 */
function textOf(finding: WatchFinding, t: (key: MessageKey) => string): { title: string; body: string } {
  const title = t(`watch.finding.${finding.key}.title` as MessageKey)
  let body = t(`watch.finding.${finding.key}.body` as MessageKey)
  for (const [name, value] of Object.entries(finding.metrics)) {
    body = body.split(`{${name}}`).join(String(value))
  }
  return { title, body: body.split('{count}').join(String(finding.count)) }
}

function FindingCard({
  finding,
  onClose,
  muted = false,
}: {
  finding: WatchFinding
  onClose: () => void
  muted?: boolean
}) {
  const { t } = useI18n()
  const dismiss = useDismissWatch()
  const restore = useRestoreWatch()
  const { title, body } = textOf(finding, t)
  const critica = finding.severity === 'critica'

  return (
    <Card
      variant="outlined"
      sx={{
        p: 1.5,
        borderLeft: `3px solid ${critica ? 'var(--danger)' : 'var(--warning)'}`,
        opacity: muted ? 0.65 : 1,
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75 }}>
        <Chip
          size="small"
          color={critica ? 'error' : 'warning'}
          variant="outlined"
          label={t(`watch.severity.${finding.severity}` as MessageKey)}
        />
        <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>
          {t(`watch.module.${finding.module}` as MessageKey)}
        </Typography>
      </Stack>

      <Typography sx={{ fontWeight: 800, fontSize: 14, mb: 0.25 }}>{title}</Typography>
      <Typography sx={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{body}</Typography>

      {finding.samples.length > 0 && (
        <Typography sx={{ fontSize: 12, color: 'var(--muted)', mt: 0.5 }} className="tnum">
          {finding.samples.map((sample) => sample.label).join(' · ')}
        </Typography>
      )}

      <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end', mt: 1 }}>
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
            onClick={onClose}
            aria-label={`${t('watch.open')}: ${title}`}
            sx={{ color: 'var(--accent-deep)' }}
          >
            <ArrowForwardRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Card>
  )
}

export function WatchButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n()
  const watch = useWatch()
  const total = watch.data?.items.length ?? 0
  const critical = watch.data?.critical ?? 0

  return (
    <Tooltip title={t('watch.open.panel')}>
      <IconButton
        onClick={onOpen}
        aria-label={
          total > 0 ? t('watch.open.panelWith').replace('{n}', String(total)) : t('watch.open.panel')
        }
        aria-haspopup="dialog"
        sx={{ color: 'var(--accent-deep)' }}
      >
        <Badge
          // El color dice si hay algo crítico sin abrir el panel.
          color={critical > 0 ? 'error' : 'warning'}
          badgeContent={total}
          invisible={total === 0}
          max={99}
        >
          <MonitorHeartRoundedIcon fontSize="small" />
        </Badge>
      </IconButton>
    </Tooltip>
  )
}

export function WatchDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const watch = useWatch(open)
  const [verSilenciados, setVerSilenciados] = useState(false)
  const items = watch.data?.items ?? []
  const dismissed = watch.data?.dismissed ?? []

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        role: 'dialog',
        'aria-labelledby': TITLE_ID,
        sx: {
          width: { xs: '100%', sm: 420 },
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'var(--bg)',
        },
      }}
    >
      <Stack
        direction="row"
        spacing={1.25}
        sx={{ alignItems: 'center', px: 2, py: 1.5, bgcolor: 'var(--card)', borderBottom: '1px solid var(--border)' }}
      >
        <AppIcon tone="accent" size="sm">
          <MonitorHeartRoundedIcon fontSize="small" />
        </AppIcon>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id={TITLE_ID} component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800 }}>
            {t('watch.title')}
          </Typography>
          <Typography sx={{ fontSize: 12, color: 'var(--muted)' }} noWrap>
            {t('watch.subtitle')}
          </Typography>
        </Box>
        <Tooltip title={t('common.refresh')}>
          <span>
            <IconButton
              aria-label={t('common.refresh')}
              onClick={() => void watch.refetch()}
              disabled={watch.isFetching}
            >
              <RefreshRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <IconButton aria-label={t('common.close')} onClick={onClose}>
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 2, py: 2 }}>
        {watch.isPending && <LoadingState label={t('common.loading')} />}
        {watch.isError && <ErrorState description={t('watch.error')} onRetry={() => void watch.refetch()} />}

        {!watch.isPending && !watch.isError && (
          <Stack spacing={1.25} aria-live="polite">
            {items.length === 0 && (
              <EmptyState
                title={t('watch.empty.title')}
                description={t('watch.empty.body')}
                icon={<MonitorHeartRoundedIcon fontSize="small" />}
              />
            )}
            {items.map((finding) => (
              <FindingCard key={finding.key} finding={finding} onClose={onClose} />
            ))}

            {/* Lo silenciado se DICE, no se esconde: un panel en calma porque
                alguien tapó tres avisos es un panel que miente. */}
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
                <FindingCard key={`muted-${finding.key}`} finding={finding} onClose={onClose} muted />
              ))}
          </Stack>
        )}
      </Box>
    </Drawer>
  )
}
