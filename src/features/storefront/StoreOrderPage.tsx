import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import { Box, Button, Card, Chip, Divider, Stack, Typography } from '@mui/material'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { R, T } from '@/theme/tokens'
import { orderResultSchema, type OrderResult } from './checkout'
import { useStorefront } from './hooks'

/**
 * Confirmación del pedido.
 *
 * Los importes que se muestran son los que devolvió el SERVIDOR, no los que el
 * carrito calculó: si la base recalculó algo (precio cambiado, impuesto de la
 * tienda), lo que el comprador lee aquí es lo que realmente se registró.
 *
 * El pedido no se puede volver a consultar: un comprador anónimo no tiene
 * sesión y la RLS de `orders` no le deja leer nada. Por eso, si la pantalla se
 * recarga y se pierde el estado de navegación, se muestra el número —que sí
 * viene de la URL— y se le dice que lo guarde, en vez de fingir un error.
 */
export function StoreOrderPage() {
  const { t, locale } = useI18n()
  const { store, storeSlug } = useStorefront()
  const { orderNumber } = useParams<{ orderNumber: string }>()
  const location = useLocation()

  const parsed = orderResultSchema.safeParse(
    (location.state as { order?: unknown } | null)?.order,
  )
  const order: OrderResult | null = parsed.success ? parsed.data : null

  return (
    <Stack sx={{ gap: 2, maxWidth: 720, mx: 'auto' }}>
      <Card sx={{ p: { xs: 2.5, md: 4 }, textAlign: 'center' }}>
        <Box
          sx={{
            width: 52,
            height: 52,
            mx: 'auto',
            mb: 1.5,
            display: 'grid',
            placeItems: 'center',
            borderRadius: `${R.md}px`,
            bgcolor: 'var(--accent-soft)',
            color: 'var(--accent-deep)',
          }}
          aria-hidden
        >
          <CheckCircleOutlineIcon />
        </Box>

        <Typography component="h1" sx={{ fontSize: { xs: 20, md: 24 }, fontWeight: 800 }}>
          {t('store.order.title')}
        </Typography>
        <Typography sx={{ color: 'var(--muted)', mt: 0.75 }}>
          {t('store.order.body')}
        </Typography>

        <Typography sx={{ mt: 2, fontSize: T.label, color: 'var(--muted)', fontWeight: 700 }}>
          {t('store.order.number')}
        </Typography>
        <Typography sx={{ fontSize: 20, fontWeight: 800, letterSpacing: 0.5 }}>
          {order?.order_number ?? orderNumber}
        </Typography>

        <Chip
          label={t('store.order.pending')}
          size="small"
          sx={{ mt: 1.5, bgcolor: 'var(--amber-soft)', color: 'var(--text)', fontWeight: 700 }}
        />
      </Card>

      {order && (
        <Card sx={{ p: { xs: 2, md: 3 } }}>
          <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800, mb: 1.5 }}>
            {t('store.order.detail')}
          </Typography>

          <Stack component="ul" sx={{ listStyle: 'none', m: 0, p: 0, gap: 0.75 }}>
            {order.items.map((item) => (
              <Stack
                component="li"
                key={item.product_id}
                direction="row"
                sx={{ justifyContent: 'space-between', gap: 1 }}
              >
                <Typography sx={{ fontSize: T.body, color: 'var(--muted)', fontWeight: 600 }}>
                  {item.quantity} × {item.name}
                </Typography>
                <Typography sx={{ fontSize: T.body, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {formatMoney(Number(item.unit_price) * item.quantity, order.currency, locale)}
                </Typography>
              </Stack>
            ))}
          </Stack>

          <Divider sx={{ my: 1.5 }} />

          <Amount label={t('store.cart.subtotal')} value={order.subtotal} currency={order.currency} />
          <Amount label={t('store.order.tax')} value={order.tax_total} currency={order.currency} />
          <Divider sx={{ my: 1 }} />
          <Amount
            label={t('common.total')}
            value={order.grand_total}
            currency={order.currency}
            strong
          />
        </Card>
      )}

      <Card sx={{ p: { xs: 2, md: 3 } }}>
        <Typography sx={{ fontSize: T.body, color: 'var(--muted)' }}>
          {t('store.order.contactNote')}{' '}
          {store.support_email && (
            <Box component="span" sx={{ color: 'var(--accent-deep)', fontWeight: 700 }}>
              {store.support_email}
            </Box>
          )}
        </Typography>
        <Button component={Link} to={`/s/${storeSlug}`} variant="contained" sx={{ mt: 2 }}>
          {t('store.cart.continue')}
        </Button>
      </Card>
    </Stack>
  )
}

function Amount({
  label,
  value,
  currency,
  strong = false,
}: {
  label: string
  value: string
  currency: string
  strong?: boolean
}) {
  const { locale } = useI18n()
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', py: 0.25 }}>
      <Typography sx={{ fontWeight: strong ? 800 : 600, color: strong ? 'var(--text)' : 'var(--muted)' }}>
        {label}
      </Typography>
      <Typography sx={{ fontWeight: strong ? 800 : 700, fontSize: strong ? 16 : undefined }}>
        {formatMoney(Number(value), currency, locale)}
      </Typography>
    </Stack>
  )
}
