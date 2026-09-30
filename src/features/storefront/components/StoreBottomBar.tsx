import FavoriteBorderRoundedIcon from '@mui/icons-material/FavoriteBorderRounded'
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded'
import HomeRoundedIcon from '@mui/icons-material/HomeRounded'
import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined'
import { Badge, Box } from '@mui/material'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { useCart } from '../cart/cart-context'

/**
 * Rediseño v3 · La barra inferior del teléfono.
 *
 * En los cuatro estilos del diseño (lámina «05 Móvil») la navegación del
 * teléfono vive ABAJO, donde llega el pulgar: Inicio, Catálogo, Favoritos y
 * Carrito. No es una función nueva: son cuatro destinos que ya existían, puestos
 * donde se alcanzan con una mano.
 *
 * ## Dónde NO aparece
 *
 * En la ficha, el carrito y el checkout. Las tres ya tienen su propia barra
 * inferior —la de comprar, la de pagar— y dos barras apiladas se comen un
 * cuarto de pantalla justo donde se cierra la venta.
 *
 * Su altura viaja como `--sf-bottom-bar` (storefront.css, con `:has`) para que
 * los botones flotantes y la holgura del pie suban lo mismo que ella.
 */
export function StoreBottomBar({ storeSlug }: { storeSlug: string }) {
  const { t } = useI18n()
  const { pathname, search } = useLocation()
  const { count, openCart } = useCart()

  const base = `/s/${storeSlug}`
  const resto = pathname.slice(base.length)
  if (/^\/(product|cart|checkout)(\/|$)/.test(resto)) return null

  const enCatalogo = resto === '' && /(?:^|[?&])(ver|c|q)=/.test(search)
  const enInicio = (resto === '' || resto === '/') && !enCatalogo

  return (
    <Box
      component="nav"
      aria-label={t('store.categories.title')}
      className="sf-bottombar"
      sx={{
        display: { xs: 'grid', md: 'none' },
        gridTemplateColumns: 'repeat(4, 1fr)',
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 3,
        height: 'calc(60px + env(safe-area-inset-bottom, 0px))',
        pb: 'env(safe-area-inset-bottom, 0px)',
        bgcolor: 'var(--card)',
        borderTop: '1px solid var(--sf-line-strong, var(--border))',
      }}
    >
      <Destino to={base} icon={<HomeRoundedIcon />} label={t('store.nav.home')} active={enInicio} />
      <Destino
        to={`${base}?ver=todo`}
        icon={<GridViewRoundedIcon />}
        label={t('store.catalog.title')}
        active={enCatalogo}
      />
      <Destino
        to={`${base}/favoritos`}
        icon={<FavoriteBorderRoundedIcon />}
        label={t('store.favorites.nav')}
        active={resto.startsWith('/favoritos')}
      />
      <Destino
        onClick={openCart}
        icon={
          <Badge
            badgeContent={count}
            sx={{ '& .MuiBadge-badge': { bgcolor: 'var(--accent-deep)', color: '#fff', fontSize: 10, fontWeight: 800, height: 16, minWidth: 16 } }}
          >
            <ShoppingCartOutlinedIcon />
          </Badge>
        }
        // Nombre DISTINTO del carrito de la cabecera: en el teléfono conviven
        // los dos, y dos controles que se llaman igual no se distinguen por voz.
        label={count > 0 ? `${t('store.cart.view')} (${count})` : t('store.cart.view')}
        visibleLabel={t('store.cart.title')}
      />
    </Box>
  )
}

function Destino({
  to,
  onClick,
  icon,
  label,
  visibleLabel,
  active = false,
}: {
  to?: string
  onClick?: () => void
  icon: ReactNode
  label: string
  visibleLabel?: string
  active?: boolean
}) {
  return (
    <Box
      {...(to ? { component: Link, to } : { component: 'button', type: 'button', onClick })}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.25,
        border: 0,
        bgcolor: 'transparent',
        cursor: 'pointer',
        textDecoration: 'none',
        font: 'inherit',
        fontSize: 11,
        fontWeight: active ? 800 : 600,
        color: active ? 'var(--text)' : 'var(--muted)',
        '& .MuiSvgIcon-root': { fontSize: 22 },
        '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: -4 },
      }}
    >
      {icon}
      <span aria-hidden>{visibleLabel ?? label}</span>
    </Box>
  )
}
