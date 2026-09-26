import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import { Box, Stack, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'

/**
 * La línea que el comprador empresa lee antes que el nombre: el SKU con el que
 * pide y si su empresa ya lo compró (Resumen v2).
 *
 * Mismo aspecto en la tarjeta y en la fila de lista. Sin SKU ni compra previa
 * no pinta nada: la tarjeta del consumidor no cambia ni un píxel.
 */
export function B2BProductMeta({ sku, purchased }: { sku: string | null | undefined; purchased: boolean }) {
  const { t } = useI18n()
  if (!sku && !purchased) return null
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, flexWrap: 'wrap', minWidth: 0 }}>
      {sku ? (
        <Typography
          data-sku={sku}
          className="tnum"
          sx={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}
          noWrap
        >
          {t('store.product.sku').replace('{sku}', sku)}
        </Typography>
      ) : null}
      {purchased ? (
        <Box
          data-purchased
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.25,
            px: 0.75,
            borderRadius: 'var(--sf-pill)',
            bgcolor: 'var(--accent-soft)',
            color: 'var(--accent-deep)',
            fontSize: 10.5,
            fontWeight: 800,
            lineHeight: 1.7,
          }}
        >
          <HistoryRoundedIcon aria-hidden sx={{ fontSize: 13 }} />
          {t('store.product.purchasedBefore')}
        </Box>
      ) : null}
    </Stack>
  )
}
