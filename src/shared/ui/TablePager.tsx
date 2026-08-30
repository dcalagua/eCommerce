import FirstPageRoundedIcon from '@mui/icons-material/FirstPageRounded'
import KeyboardArrowLeftRoundedIcon from '@mui/icons-material/KeyboardArrowLeftRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import LastPageRoundedIcon from '@mui/icons-material/LastPageRounded'
import { Box, Button, IconButton, Stack, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { R, T } from '@/theme/tokens'
import { pageSlots } from './pageSlots'

/**
 * Paginación con números.
 *
 * Dos flechas y un contador obligan a pulsar seis veces para llegar a la página
 * siete, y no dicen en qué punto de la lista estás. Con números, primera y
 * última, cualquier destino está a un clic.
 *
 * Vive en `shared/ui` porque toda tabla larga de la app tiene el mismo problema.
 */
export function TablePager({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  /** Base 0, como el resto de la app. */
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const { t } = useI18n()
  const pages = Math.max(Math.ceil(total / pageSize), 1)
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min((page + 1) * pageSize, total)

  const go = (next: number) => onPageChange(Math.min(Math.max(next, 0), pages - 1))

  return (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 2,
        flexWrap: 'wrap',
        px: 2,
        py: 1.5,
        borderTop: '1px solid var(--border)',
      }}
    >
      {/* `aria-live`: al cambiar de pagina el foco sigue en el boton pulsado y
          nada anunciaria que el tramo mostrado ha cambiado. */}
      <Typography
        data-testid="pager-summary"
        aria-live="polite"
        sx={{ fontSize: 12.5, color: 'var(--muted)' }}
      >
        {t('common.pager.showing')} <strong className="tnum">{from}–{to}</strong>{' '}
        {t('common.pager.of')} <strong className="tnum">{total}</strong>
      </Typography>

      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        <IconButton
          size="small"
          disabled={page === 0}
          onClick={() => go(0)}
          aria-label={t('common.pager.first')}
        >
          <FirstPageRoundedIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          disabled={page === 0}
          onClick={() => go(page - 1)}
          aria-label={t('common.pager.previous')}
        >
          <KeyboardArrowLeftRoundedIcon fontSize="small" />
        </IconButton>

        {pageSlots(page, pages).map((slot, index) =>
          slot === 'gap' ? (
            <Box
              // El hueco no es interactivo y no tiene identidad propia: la clave
              // es su posición, que es justo lo que el índice representa aquí.
              key={`gap-${index}`}
              aria-hidden
              sx={{ px: 0.5, color: 'var(--muted)', fontSize: T.body }}
            >
              …
            </Box>
          ) : (
            <Button
              key={slot}
              size="small"
              onClick={() => go(slot)}
              aria-label={`${t('common.pager.page')} ${slot + 1}`}
              aria-current={slot === page ? 'page' : undefined}
              sx={{
                minWidth: 32,
                px: 1,
                borderRadius: `${R.sm}px`,
                fontWeight: slot === page ? 800 : 600,
                color: slot === page ? '#fff' : 'var(--text)',
                bgcolor: slot === page ? 'var(--accent)' : 'transparent',
                '&:hover': {
                  bgcolor: slot === page ? 'var(--accent-deep)' : 'var(--neutral-soft)',
                },
              }}
            >
              {slot + 1}
            </Button>
          ),
        )}

        <IconButton
          size="small"
          disabled={page >= pages - 1}
          onClick={() => go(page + 1)}
          aria-label={t('common.pager.next')}
        >
          <KeyboardArrowRightRoundedIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          disabled={page >= pages - 1}
          onClick={() => go(pages - 1)}
          aria-label={t('common.pager.last')}
        >
          <LastPageRoundedIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Stack>
  )
}
