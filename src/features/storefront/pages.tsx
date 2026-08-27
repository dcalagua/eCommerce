import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined'
import { Card, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { PageHeader } from '@/shared/ui/PageHeader'
import { EmptyState } from '@/shared/ui/states'

/**
 * Pantallas sueltas de la vitrina.
 *
 * El catálogo y la ficha viven en `StoreHomePage.tsx` y `StoreProductPage.tsx`
 * desde P05. Carrito y pago siguen siendo la estructura de rutas con su estado
 * vacío: son P06 y esta fase no toca pagos.
 */

export function StoreCartPage() {
  const { t } = useI18n()
  return (
    <>
      <PageHeader title={t('store.cart.title')} />
      <Card>
        <EmptyState title={t('store.cart.empty')} icon={<ShoppingCartOutlinedIcon fontSize="small" />} />
      </Card>
    </>
  )
}

export function StoreCheckoutPage() {
  const { t } = useI18n()
  return (
    <>
      <PageHeader title={t('store.checkout.title')} />
      <Card>
        <EmptyState />
      </Card>
    </>
  )
}

export function LandingPage() {
  const { t } = useI18n()
  return (
    <Card sx={{ m: { xs: 2, md: 6 } }}>
      <EmptyState
        title="eCommerce by EBIM"
        description={t('auth.valueProp')}
      />
      <Typography sx={{ textAlign: 'center', pb: 3, color: 'var(--muted)', fontSize: 12.5 }}>
        /login · /app · /s/:storeSlug
      </Typography>
    </Card>
  )
}
