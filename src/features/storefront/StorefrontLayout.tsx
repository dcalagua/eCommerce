import PersonOutlineRoundedIcon from '@mui/icons-material/PersonOutlineRounded'
import ShoppingCartRoundedIcon from '@mui/icons-material/ShoppingCartRounded'
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
import { Link, Outlet, useLocation, useParams } from 'react-router-dom'
import { ErrorBoundary } from '@/app/ErrorBoundary'
import { useSessionContext } from '@/features/auth/session-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { EbimMark } from '@/shared/ui/EbimMark'
import { useDocumentMeta } from '@/shared/seo/useDocumentMeta'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { SkipToContentLink, CONTENT_ANCHOR } from '@/shared/ui/SkipToContentLink'
import { AppearanceProvider } from '@/theme/AppearanceProvider'
import { R, T } from '@/theme/tokens'
import { StorefrontNotFoundError } from './api'
import { notFoundMeta } from './seo'
import { initials } from './branding'
import { StoreQuickSearch } from './components/StoreQuickSearch'
import { CartDrawer } from './cart/CartDrawer'
import { CartProvider } from './cart/CartProvider'
import { useCart } from './cart/cart-context'
import { usePublicStore, useStoreNavigation, type StorefrontOutlet } from './hooks'
import type { PublicStore } from './types'
import './storefront.css'

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
  const { t, locale } = useI18n()
  const { pathname } = useLocation()
  const { data: store, isPending, isError, error, refetch } = usePublicStore(storeSlug)
  // La sesión no cambia NADA de lo que se ve del catálogo —la vitrina se lee
  // siempre con el cliente anónimo— pero sí decide de quién es el carrito: con
  // sesión, el del comprador; sin ella, el del token del navegador.
  const { status: sessionStatus } = useSessionContext()

  // Un slug que no resuelve responde 200 como todo en una SPA. Sin este
  // `noindex`, la pantalla de «no encontramos esa tienda» se indexa como si
  // fuera contenido: el «soft 404» clásico. Se declara ANTES de decidir qué
  // pintar para que también cubra el fallo de red.
  const failed = !isPending && (isError || !store)
  useDocumentMeta(
    failed
      ? notFoundMeta({ title: t('store.notFound'), pathname, siteName: 'eCommerce by EBIM', locale })
      : null,
  )

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
    // Desde P11-SaaS viajan con él los tokens de white-label: tipografía, radio
    // y densidad por defecto. Los cuatro se aplican en el MISMO render en el
    // que la tienda queda resuelta, así que no hay un primer pintado con la
    // marca de suite y otro con la del tenant — que es el «flash de branding»
    // que el encargo prohíbe.
    <AppearanceProvider
      tenantAccent={store.accent_color}
      tenantFont={store.font_family}
      tenantRadius={store.ui_radius}
      tenantDensity={store.ui_density}
    >
      {/* El carrito cuelga de la tienda YA RESUELTA: su `store_id` sale de
          `public_stores`, nunca de la URL ni de `localStorage`. Al cambiar de
          tienda, el provider se remonta y carga el carrito de esa tienda. */}
      <CartProvider
        storeId={store.store_id}
        storeSlug={storeSlug as string}
        currency={store.currency}
        authenticated={sessionStatus === 'authenticated'}
      >
        {/* `sf-scope`: las variables de piel de la vitrina (radios, sombras,
            superficies) viven solo bajo esta clase, asi que el backoffice
            —que comparte tokens de color— no se entera de nada. */}
        <Box
          className="sf-scope"
          sx={{
            // `100vh` primero y `100dvh` solo donde existe. El pie ya iba al
            // final de la columna, pero en vistas embebidas —el navegador
            // simple del editor, un iframe de previsualizacion— `dvh` calcula
            // MENOS que el alto real y quedaba una banda de fondo bajo el pie.
            // Con las dos, el que no entienda `dvh` se queda con `vh` y nadie
            // ve el hueco.
            minHeight: '100vh',
            '@supports (min-height: 100dvh)': { minHeight: '100dvh' },
            bgcolor: 'var(--bg)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Primer elemento enfocable del documento: sin él, llegar al
              catálogo con el teclado obliga a pasar por el logo, el menú, la
              cuenta y el carrito en CADA página. El destino ya existía
              (`id="contenido"`) y el texto también; faltaba el enlace. */}
          <SkipToContentLink label={t('store.skipToContent')} />
          <StoreHeader store={store} storeSlug={storeSlug as string} />

          <Container
            component="main"
            id={CONTENT_ANCHOR}
            // `tabIndex={-1}`: sin esto el salto mueve el scroll pero NO el
            // foco, y el siguiente Tab vuelve al principio de la cabecera.
            tabIndex={-1}
            maxWidth="lg"
            sx={{ flex: 1, py: { xs: 2.5, md: 4 }, '&:focus': { outline: 'none' } }}
          >
            <ErrorBoundary>
              <Outlet context={context} />
            </ErrorBoundary>
          </Container>

          <StoreFooter store={store} storeSlug={storeSlug as string} />
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
      className="sf-header"
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        // El desenfoque lo pone `storefront.css` donde el navegador lo soporta;
        // este color es el respaldo opaco, que es lo que garantiza que la
        // cabecera se lea sobre el catalogo con el que se solapa.
        bgcolor: 'var(--card)',
        borderBottom: '1px solid var(--sf-line)',
      }}
    >
      <Container maxWidth="lg" disableGutters>
        <Toolbar sx={{ gap: 1.5, px: { xs: 2, md: 3 }, minHeight: { xs: 60, md: 68 } }}>
          <Box
            component={Link}
            to={`/s/${storeSlug}`}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
              textDecoration: 'none',
              color: 'inherit',
              minWidth: 0,
              flexShrink: 0,
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
                  width: 34,
                  height: 34,
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

          {/* El buscador vive en la cabecera y no en el cuerpo del catalogo:
              es lo primero que se usa para llegar a un producto, y desde aqui
              esta en TODAS las pantallas de la tienda, no solo en la portada.
              Se oculta en movil, donde la barra no da para el logo, el menu,
              la cuenta, el carrito Y una caja de texto. */}
          <Box sx={{ display: { xs: 'none', md: 'flex' }, flex: 1, minWidth: 0, mx: 1 }}>
            <StoreQuickSearch storeSlug={storeSlug} />
          </Box>

          {/* Las paginas del CMS —quienes somos, envios, terminos— NO viven
              aqui. La cabecera de una tienda tiene tres trabajos: buscar,
              entrar a lo tuyo y ver el carrito; cada enlace que se le anade
              compite con esos tres y ninguno de ellos vende. Se leen una vez,
              casi siempre buscandolas, y su sitio de siempre es el pie. */}
          <AccountButton storeSlug={storeSlug} />
          <CartButton />
        </Toolbar>
      </Container>
    </Box>
  )
}

/**
 * Menú de páginas administrables (P11-SaaS).
 *
 * Existe porque una página que solo se alcanza escribiendo su URL es media
 * funcionalidad: el comercio la crea y nadie llega. Qué páginas salen aquí lo
 * decide `content_pages.show_in_nav`, y la lista la resuelve el servidor ya
 * filtrada por publicación, vigencia y canal.
 *
 * Se esconde en móvil: en una barra que ya lleva cuenta y carrito, tres enlaces
 * más empujan el nombre de la tienda fuera de la pantalla. Las páginas siguen
 * alcanzables desde los bloques de contenido y desde el pie.
 */
/**
 * Paginas de la tienda —quienes somos, envios, terminos—, en el PIE.
 *
 * Estaban en la cabecera y se las llevaba el sitio que necesitan el buscador,
 * la cuenta y el carrito. Son paginas que se consultan una vez y casi nunca de
 * memoria: al pie se las encuentra igual, y ademas es donde se buscan las
 * legales.
 *
 * Sigue siendo un `<nav>` con nombre: quien navega por regiones con un lector
 * de pantalla las encuentra por ahi, este arriba o abajo.
 */
function StorePagesNav({ storeSlug }: { storeSlug: string }) {
  const { t } = useI18n()
  const { data } = useStoreNavigation(storeSlug)
  if (!data || data.length === 0) return null

  return (
    <Stack
      component="nav"
      direction="row"
      aria-label={t('store.footer.pages')}
      sx={{ gap: { xs: 1.5, sm: 3 }, flexWrap: 'wrap' }}
    >
      {data.slice(0, 6).map((item) => (
        <MuiLink
          key={item.slug}
          component={Link}
          to={`/s/${storeSlug}/p/${item.slug}`}
          sx={{
            fontSize: T.body,
            fontWeight: 700,
            color: 'var(--muted)',
            textDecoration: 'none',
            '&:hover': { color: 'var(--accent-deep)', textDecoration: 'underline' },
          }}
        >
          {item.title}
        </MuiLink>
      ))}
    </Stack>
  )
}

/**
 * Entrada al área de cuenta (P05-SaaS). Solo aparece con sesión, y es
 * deliberado: un enlace a «tu cuenta» para un comprador anónimo lleva a un
 * sitio donde no hay nada suyo, y la vitrina se navega sin sesión a propósito.
 *
 * Qué cuenta es la suya lo decide el servidor (`my_business_accounts`); esto es
 * solo la puerta.
 */
function AccountButton({ storeSlug }: { storeSlug: string }) {
  const { t } = useI18n()
  const { status } = useSessionContext()
  if (status !== 'authenticated') return null

  return (
    <Button
      component={Link}
      to={`/s/${storeSlug}/account`}
      startIcon={<PersonOutlineRoundedIcon />}
      sx={{ flexShrink: 0 }}
    >
      <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
        {t('account.title')}
      </Box>
    </Button>
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
          <ShoppingCartRoundedIcon />
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

function StoreFooter({ store, storeSlug }: { store: PublicStore; storeSlug: string }) {
  const { t } = useI18n()
  const hasContact = Boolean(store.contact_phone || store.support_email || store.contact_address)

  return (
    <Box component="footer" sx={{ borderTop: '1px solid var(--border)', bgcolor: 'var(--card)', mt: 4 }}>
      <Container maxWidth="lg" sx={{ py: { xs: 3, md: 4 } }}>
        <Box sx={{ mb: 2.5 }}>
          <StorePagesNav storeSlug={storeSlug} />
        </Box>

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
            © {store.business_display_name?.trim() || store.name}
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
