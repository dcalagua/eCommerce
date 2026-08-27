import { Card, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { EmptyState } from '@/shared/ui/states'

/**
 * Pantallas sueltas fuera de la vitrina de una tienda.
 *
 * El catálogo y la ficha viven en `StoreHomePage.tsx` y `StoreProductPage.tsx`
 * (P05); el carrito, el checkout y la confirmación en `StoreCartPage.tsx`,
 * `StoreCheckoutPage.tsx` y `StoreOrderPage.tsx` (P06). Aquí queda solo la
 * portada del dominio raíz.
 */
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
