import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined'
import { Box, Button, Card, Divider, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { PageHeader } from '@/shared/ui/PageHeader'
import { EmptyState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { CartLineList } from './cart/CartLineList'
import { useCart } from './cart/cart-context'
import { useStorefront } from './hooks'

/**
 * Carrito a página completa: revisar con calma lo que el panel lateral enseña
 * de pasada. Las líneas son el mismo componente, así que sumar, restar y quitar
 * se comportan igual en los dos sitios.
 */
export function StoreCartPage() {
  const { t, locale } = useI18n()
  const { storeSlug } = useStorefront()
  const { cart, count, subtotal, currency } = useCart()

  if (cart.lines.length === 0) {
    return (
      <>
        <PageHeader title={t('store.cart.title')} />
        <Card>
          <EmptyState
            title={t('store.cart.empty')}
            description={t('store.cart.emptyBody')}
            icon={<ShoppingCartOutlinedIcon fontSize="small" />}
            action={
              <Button component={Link} to={`/s/${storeSlug}`} variant="contained">
                {t('store.cart.continue')}
              </Button>
            }
          />
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('store.cart.title')}
        subtitle={`${count} ${count === 1 ? t('store.cart.unit') : t('store.cart.units')}`}
      />

      <Box
        sx={{
          display: 'grid',
          gap: { xs: 2, md: 3 },
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1.6fr) minmax(0, 1fr)' },
          alignItems: 'start',
        }}
      >
        <Card sx={{ p: { xs: 1.5, md: 2.5 } }}>
          <CartLineList cart={cart} storeSlug={storeSlug} />
        </Card>

        <Card sx={{ p: { xs: 1.5, md: 2.5 } }}>
          <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800, mb: 1.5 }}>
            {t('store.cart.summary')}
          </Typography>
          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
            <Typography sx={{ fontWeight: 700 }}>{t('store.cart.subtotal')}</Typography>
            <Typography sx={{ fontWeight: 800 }}>
              {formatMoney(Number(subtotal), currency, locale)}
            </Typography>
          </Stack>
          <Typography sx={{ fontSize: T.label, color: 'var(--muted)', mt: 0.5 }}>
            {t('store.cart.taxNote')}
          </Typography>
          <Divider sx={{ my: 2 }} />
          <Stack sx={{ gap: 1 }}>
            <Button component={Link} to={`/s/${storeSlug}/checkout`} variant="contained" fullWidth>
              {t('store.cart.checkout')}
            </Button>
            <Button component={Link} to={`/s/${storeSlug}`} fullWidth>
              {t('store.cart.continue')}
            </Button>
          </Stack>
        </Card>
      </Box>
    </>
  )
}
