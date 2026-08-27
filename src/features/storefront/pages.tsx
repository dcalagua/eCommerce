import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined'
import { Card, Typography } from '@mui/material'
import { useParams } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { PageHeader } from '@/shared/ui/PageHeader'
import { EmptyState } from '@/shared/ui/states'

/**
 * Pantallas de la vitrina. En P01 son la estructura de rutas con sus estados;
 * el catálogo real llega con el backend (P05/P06).
 */

export function StoreHomePage() {
  const { t } = useI18n()
  return (
    <>
      <PageHeader title={t('store.home.title')} />
      <Card>
        <EmptyState />
      </Card>
    </>
  )
}

export function StoreProductPage() {
  const { productSlug } = useParams<{ productSlug: string }>()
  return (
    <>
      <PageHeader title={productSlug ?? ''} />
      <Card>
        <EmptyState />
      </Card>
    </>
  )
}

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
