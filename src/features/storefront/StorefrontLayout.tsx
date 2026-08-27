import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined'
import { Box, Button, Container, Stack, Toolbar, Typography } from '@mui/material'
import { Link, Outlet, useParams } from 'react-router-dom'
import { ErrorBoundary } from '@/app/ErrorBoundary'
import { StoreNotFoundError } from '@/features/tenant/api'
import { useStoreBranding } from '@/features/tenant/useStoreBranding'
import { useI18n } from '@/shared/i18n/i18n-context'
import { EbimMark } from '@/shared/ui/EbimMark'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { AppearanceProvider } from '@/theme/AppearanceProvider'

/**
 * Vitrina pública. El tenant se resuelve por el slug de la URL contra una vista
 * pública de solo lectura — nunca por un parámetro que el cliente declare como
 * confiable. El comprador anónimo solo ve lo publicado.
 */
export function StorefrontLayout() {
  const { storeSlug } = useParams<{ storeSlug: string }>()
  const { t } = useI18n()
  const { data, isPending, isError, error, refetch } = useStoreBranding(storeSlug)

  if (isPending) return <LoadingState />

  if (isError) {
    if (error instanceof StoreNotFoundError) {
      return <EmptyState title={t('store.notFound')} description={t('store.notFoundBody')} />
    }
    return <ErrorState error={error} onRetry={() => void refetch()} />
  }

  const storeName = data?.name ?? storeSlug ?? ''

  return (
    // El acento del storefront es el `accent_color` del tenant, no el de casa.
    <AppearanceProvider tenantAccent={data?.accent_color ?? null}>
      <Box sx={{ minHeight: '100dvh', bgcolor: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
        <Toolbar
          component="header"
          sx={{ bgcolor: 'var(--card)', borderBottom: '1px solid var(--border)', gap: 2 }}
        >
          <Box
            component={Link}
            to={`/s/${storeSlug}`}
            sx={{ display: 'flex', alignItems: 'center', gap: 1.25, textDecoration: 'none', color: 'inherit', flex: 1 }}
          >
            {data?.logo_url ? (
              <Box component="img" src={data.logo_url} alt={storeName} sx={{ height: 28 }} />
            ) : (
              <EbimMark size={26} />
            )}
            <Typography sx={{ fontWeight: 800, fontSize: 15 }}>{storeName}</Typography>
          </Box>
          <Button
            component={Link}
            to={`/s/${storeSlug}/cart`}
            startIcon={<ShoppingCartOutlinedIcon />}
            aria-label={t('store.cart.title')}
          >
            {t('store.cart.title')}
          </Button>
        </Toolbar>

        <Container component="main" maxWidth="lg" sx={{ flex: 1, py: { xs: 3, md: 5 } }}>
          <ErrorBoundary>
            <Outlet context={{ storeSlug, branding: data }} />
          </ErrorBoundary>
        </Container>

        {/* El lockup "by EBIM" acompaña también a la vitrina, salvo white-label. */}
        <Box component="footer" sx={{ borderTop: '1px solid var(--border)', py: 2.5 }}>
          <Stack direction="row" spacing={1} sx={{ justifyContent: 'center', alignItems: 'center' }}>
            {!data?.white_label && <EbimMark size={14} />}
            <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>
              {data?.white_label ? storeName : 'eCommerce by EBIM'}
            </Typography>
          </Stack>
        </Box>
      </Box>
    </AppearanceProvider>
  )
}
