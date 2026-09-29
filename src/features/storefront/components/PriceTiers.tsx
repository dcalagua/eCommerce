import BusinessRoundedIcon from '@mui/icons-material/BusinessRounded'
import { Box, ButtonBase, Stack, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { TS } from '@/theme/tokens'
import type { PriceTier } from '../api'

/**
 * Precio por volumen en la ficha (lámina 31).
 *
 * Las escalas PÚBLICAS de la lista de precios de la tienda —las mismas que
 * aplica el carrito a quien no tiene convenio—. Se marca la que corresponde a
 * la cantidad elegida, y pulsar una lleva la cantidad a su mínimo: es la forma
 * más corta de decir «si llevas 10, pagas esto».
 *
 * Sin escalas (una sola fila) no se pinta nada: un recuadro con un único precio
 * repetiría el de arriba.
 */
export function PriceTiers({
  tiers,
  currency,
  quantity,
  onChoose,
}: {
  tiers: readonly PriceTier[]
  currency: string
  quantity: number
  onChoose: (quantity: number) => void
}) {
  const { t, locale } = useI18n()
  if (tiers.length < 2) return null

  // La escala vigente es la de mayor mínimo que no supera la cantidad.
  const vigente = [...tiers].reverse().find((tier) => quantity >= tier.minQuantity) ?? tiers[0]

  return (
    <Box
      component="section"
      data-price-tiers={tiers.length}
      aria-label={t('store.product.tiers.title')}
      sx={{
        p: 1.75,
        border: '1px solid var(--sf-line)',
        borderRadius: 'var(--sf-radius-sm)',
        bgcolor: 'var(--card)',
      }}
    >
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', mb: 1.25 }}
      >
        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75 }}>
          <BusinessRoundedIcon aria-hidden sx={{ fontSize: 18, color: 'var(--accent-deep)' }} />
          <Typography sx={{ fontSize: TS.body, fontWeight: 700 }}>{t('store.product.tiers.title')}</Typography>
        </Stack>
        <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>{t('store.product.tiers.note')}</Typography>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gap: 1,
          gridTemplateColumns: `repeat(${Math.min(tiers.length, 4)}, minmax(0, 1fr))`,
        }}
      >
        {tiers.map((tier, indice) => {
          const siguiente = tiers[indice + 1]
          const rango = siguiente
            ? t('store.product.tiers.range')
                .replace('{from}', String(tier.minQuantity))
                .replace('{to}', String(siguiente.minQuantity - 1))
            : t('store.product.tiers.from').replace('{from}', String(tier.minQuantity))
          const precio = formatMoney(tier.unitPrice, currency, locale)
          const activa = tier === vigente
          return (
            <ButtonBase
              key={tier.minQuantity}
              aria-pressed={activa}
              aria-label={t('store.product.tiers.choose')
                .replace('{n}', String(tier.minQuantity))
                .replace('{price}', precio)}
              onClick={() => onChoose(tier.minQuantity)}
              sx={{
                display: 'grid',
                justifyItems: 'start',
                gap: 0.25,
                px: 1.25,
                py: 1,
                borderRadius: 'calc(var(--sf-radius-sm) - 4px)',
                border: '1.5px solid',
                borderColor: activa ? 'var(--accent)' : 'transparent',
                bgcolor: activa ? 'var(--accent-soft)' : 'var(--neutral-soft)',
                textAlign: 'left',
                '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: 2 },
              }}
            >
              <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>{rango}</Typography>
              <Typography
                className="tnum"
                sx={{ fontSize: 15, fontWeight: 700, color: activa ? 'var(--accent-deep)' : 'var(--text)' }}
              >
                {precio}
              </Typography>
            </ButtonBase>
          )
        })}
      </Box>
    </Box>
  )
}
