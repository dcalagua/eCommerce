import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined'
import {
  Badge,
  Box,
  Button,
  Container,
  Divider,
  Link as MuiLink,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material'
import type { ReactNode } from 'react'
import { Link, Outlet, useParams } from 'react-router-dom'
import { ErrorBoundary } from '@/app/ErrorBoundary'
import { useI18n } from '@/shared/i18n/i18n-context'
import { EbimMark } from '@/shared/ui/EbimMark'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { AppearanceProvider } from '@/theme/AppearanceProvider'
import { R, T } from '@/theme/tokens'
import { StorefrontNotFoundError } from './api'
import { initials } from './branding'
import { CartDrawer } from './cart/CartDrawer'
import { CartProvider } from './cart/CartProvider'
import { useCart } from './cart/cart-context'
import { usePublicStore, type StorefrontOutlet } from './hooks'
import type { PublicStore } from './types'

/**
 * Vitrina pública.
 *
 * El tenant se resuelve por el **slug de la URL** contra `public_stores`, que
 * solo devuelve tiendas activas — nunca por un parámetro que el cliente declare
 * confiable, ni por nada guardado en `localStorage`. Si el slug no resuelve, la
 * respuesta es un 404 de tienda, no una pantalla vacía sin explicar.
 *
 * Todo lo de identidad (logo, nombre, acento, banner, contacto) sale de
 * `store_settings`. Aquí no hay ni un color ni un nombre cableado: lo único de
 * casa es el lockup "by EBIM" del pie, y desaparece si la tienda es white-label.
 */
export function StorefrontLayout() {
  const { storeSlug } = useParams<{ storeSlug: string }>()
  const { t } = useI18n()
  const { data: store, isPending, isError, error, refetch } = usePublicStore(storeSlug)

  if (isPending) {
    return (
      <Shell>
        <LoadingState />
      </Shell>
    )
  }

  if (isError || !store) {
    const notFound = error instanceof StorefrontNotFoundError
    return (
      <Shell>
        {notFound ? (
          <EmptyState title={t('store.notFound')} description={t('store.notFoundBody')} />
        ) : (
          <ErrorState error={error} onRetry={() => void refetch()} />
        )}
      </Shell>
    )
  }

  const context: StorefrontOutlet = { storeSlug: storeSlug as string, store }

  return (
    // El acento de la vitrina es el `accent_color` del tenant, no el de casa.
    <AppearanceProvider tenantAccent={store.accent_color}>
      {/* El carrito cuelga de la tienda YA RESUELTA: su `store_id` sale de
          `public_stores`, nunca de la URL ni de `localStorage`. Al cambiar de
          tienda, el provider se remonta y carga el carrito de esa tienda. */}
      <CartProvider storeId={store.store_id} currency={store.currency}>
        <Box sx={{ minHeight: '100dvh', bgcolor: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
          <StoreHeader store={store} storeSlug={storeSlug as string} />

          <Container
            component="main"
            id="contenido"
            maxWidth="lg"
            sx={{ flex: 1, py: { xs: 2.5, md: 4 } }}
          >
            <ErrorBoundary>
              <Outlet context={context} />
            </ErrorBoundary>
          </Container>

          <StoreFooter store={store} />
          <CartDrawer storeSlug={storeSlug as string} />
        </Box>
      </CartProvider>
    </AppearanceProvider>
  )
}

/** Marco neutro para los estados en los que todavía no hay tienda que pintar. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <AppearanceProvider>
      <Box sx={{ minHeight: '100dvh', bgcolor: 'var(--bg)', display: 'grid', placeItems: 'center' }}>
        <Container maxWidth="sm">{children}</Container>
      </Box>
    </AppearanceProvider>
  )
}

function StoreHeader({ store, storeSlug }: { store: PublicStore; storeSlug: string }) {
  return (
    <Box
      component="header"
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        bgcolor: 'var(--card)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <Container maxWidth="lg" disableGutters>
        <Toolbar sx={{ gap: 1.5, px: { xs: 2, md: 3 } }}>
          <Box
            component={Link}
            to={`/s/${storeSlug}`}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
              textDecoration: 'none',
              color: 'inherit',
              flex: 1,
              minWidth: 0,
            }}
          >
            {store.logo_url ? (
              <Box
                component="img"
                src={store.logo_url}
                alt={store.name}
                sx={{ height: 30, maxWidth: 160, objectFit: 'contain' }}
              />
            ) : (
              // Sin logo: iniciales sobre el acento del tenant. Neutro y suyo,
              // en vez de plantar el isotipo EBIM como si fuera su marca.
              <Box
                aria-hidden
                sx={{
                  width: 30,
                  height: 30,
                  flexShrink: 0,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: `${R.sm}px`,
                  bgcolor: 'var(--accent-soft)',
                  color: 'var(--accent-deep)',
                  fontWeight: 800,
                  fontSize: T.label,
                }}
              >
                {initials(store.name)}
              </Box>
            )}
            <Typography
              component="span"
              sx={{ fontWeight: 800, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {store.name}
            </Typography>
          </Box>

          <CartButton />
        </Toolbar>
      </Container>
    </Box>
  )
}

/**
 * Botón del carrito. Abre el panel lateral en vez de navegar: el comprador ve
 * lo que lleva sin abandonar la ficha que estaba mirando. La página `/cart`
 * sigue estando a un clic desde el propio panel.
 */
function CartButton() {
  const { t } = useI18n()
  const { count, openCart } = useCart()

  return (
    <Button
      onClick={openCart}
      startIcon={
        <Badge badgeContent={count} color="primary" aria-hidden>
          <ShoppingCartOutlinedIcon />
        </Badge>
      }
      aria-label={`${t('store.cart.title')} (${count})`}
      sx={{ flexShrink: 0 }}
    >
      <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
        {t('store.cart.title')}
      </Box>
    </Button>
  )
}

function StoreFooter({ store }: { store: PublicStore }) {
  const { t } = useI18n()
  const hasContact = Boolean(store.contact_phone || store.support_email || store.contact_address)

  return (
    <Box component="footer" sx={{ borderTop: '1px solid var(--border)', bgcolor: 'var(--card)', mt: 4 }}>
      <Container maxWidth="lg" sx={{ py: { xs: 3, md: 4 } }}>
        {hasContact && (
          <>
            <Typography component="h2" sx={{ fontSize: T.label, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--muted)', mb: 1 }}>
              {t('store.contact.title')}
            </Typography>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              sx={{ gap: { xs: 0.75, sm: 3 }, flexWrap: 'wrap', fontSize: T.body }}
            >
              {store.support_email && (
                <MuiLink
                  href={`mailto:${store.support_email}`}
                  sx={{ color: 'var(--accent-deep)', fontWeight: 700, fontSize: T.body }}
                >
                  {store.support_email}
                </MuiLink>
              )}
              {store.contact_phone && (
                <MuiLink
                  href={`tel:${store.contact_phone.replace(/\s+/g, '')}`}
                  sx={{ color: 'var(--accent-deep)', fontWeight: 700, fontSize: T.body }}
                >
                  {store.contact_phone}
                </MuiLink>
              )}
              {store.contact_address && (
                <Typography sx={{ color: 'var(--muted)', fontSize: T.body }}>
                  {store.contact_address}
                </Typography>
              )}
            </Stack>
            <Divider sx={{ my: 2.5 }} />
          </>
        )}

        <Stack
          direction="row"
          sx={{ justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}
        >
          <Typography sx={{ fontSize: T.label, fontWeight: 700, color: 'var(--muted)' }}>
            © {store.name}
          </Typography>
          {/* El lockup de suite acompaña a la vitrina salvo white-label. */}
          {!store.white_label && (
            <Stack direction="row" sx={{ gap: 0.75, alignItems: 'center' }}>
              <EbimMark size={14} />
              <Typography sx={{ fontSize: T.label, fontWeight: 700, color: 'var(--muted)' }}>
                eCommerce by EBIM
              </Typography>
            </Stack>
          )}
        </Stack>
      </Container>
    </Box>
  )
}
