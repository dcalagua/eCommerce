import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import { Box, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { AppIcon } from '@/shared/ui/AppIcon'
import { T } from '@/theme/tokens'
import { WatchList } from './WatchList'
import { useWatch } from './useWatch'

/**
 * El centro de vigilancia dentro del Resumen.
 *
 * Es el MISMO listado del cajón lateral —mismas reglas, mismas tarjetas, mismo
 * silencio— puesto donde se entra cada mañana. Se calla del todo cuando no hay
 * nada que mirar: un bloque fijo que la mayoría de los días dice «todo bien»
 * enseña a ignorarlo, y el día que diga algo tampoco se leerá.
 */
export function WatchSection() {
  const { t } = useI18n()
  const watch = useWatch()
  const total = watch.data?.items.length ?? 0
  const critical = watch.data?.critical ?? 0

  if (watch.isPending || watch.isError || total === 0) return null

  return (
    <Box
      sx={{
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        bgcolor: 'var(--card)',
        p: { xs: 1.5, md: 2 },
      }}
    >
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', mb: 1.5 }}>
        <AppIcon tone="accent" size="sm">
          <MonitorHeartRoundedIcon fontSize="small" />
        </AppIcon>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800 }}>
              {t('watch.title')}
            </Typography>
            {critical > 0 && (
              <Chip
                size="small"
                color="error"
                variant="outlined"
                label={t('watch.criticalCount').replace('{n}', String(critical))}
              />
            )}
          </Stack>
          <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>{t('watch.subtitle')}</Typography>
        </Box>
        <Typography sx={{ fontSize: 12, color: 'var(--muted)', display: { xs: 'none', sm: 'block' } }}>
          {t('watch.deterministic')}
        </Typography>
        <Tooltip title={t('common.refresh')}>
          <span>
            <IconButton
              aria-label={t('common.refresh')}
              onClick={() => void watch.refetch()}
              disabled={watch.isFetching}
              size="small"
            >
              <RefreshRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <WatchList query={watch} />
    </Box>
  )
}
