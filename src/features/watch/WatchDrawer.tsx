import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import { Badge, Box, Drawer, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { AppIcon } from '@/shared/ui/AppIcon'
import { T } from '@/theme/tokens'
import { WatchList } from './WatchList'
import { useWatch } from './useWatch'

const TITLE_ID = 'ebim-watch-title'

/**
 * El centro de vigilancia como cajón lateral: el mismo listado que el bloque
 * del dashboard, disponible desde cualquier pantalla.
 */
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
        <WatchList query={watch} onNavigate={onClose} />
      </Box>
    </Drawer>
  )
}
