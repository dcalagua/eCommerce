import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import LocalOfferRoundedIcon from '@mui/icons-material/LocalOfferRounded'
import { Box, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { TS } from '@/theme/tokens'
import { discountPercent, type PublicProduct } from '../types'
import { ProductMedia } from './ProductMedia'
import { StoreFeaturedHero } from './StoreFeaturedHero'

/**
 * La portada en MOSAICO (Resumen v2 · contrato V4, `heroVariant: 'bento'`).
 *
 * La portada de producto ponía el título a la izquierda, una foto de 260 px y
 * el precio a la derecha: en una pantalla de 1320 px quedaba un hueco de medio
 * metro en el centro, justo lo primero que se ve de la tienda. Aquí la oferta
 * principal es la misma —el mismo carrusel, los mismos datos— y al lado van
 * dos piezas que ya existían en la portada y que nadie veía de entrada:
 *
 *  1. la siguiente oferta, con su foto y su precio tachado;
 *  2. la puerta a TODAS las ofertas, con cuántas hay y hasta cuánto rebajan.
 *
 * Nada se inventa: cifras y productos salen de las ofertas ya cargadas. Sin
 * una segunda oferta, la primera pieza no se pinta; sin ofertas no hay
 * mosaico, y la portada cae a la de siempre (lo decide el registro).
 */
export function StoreBentoHero({
  products,
  next,
  offersTotal,
  storeSlug,
  thumbnails,
}: {
  /** Las ofertas del carrusel principal, ya recortadas. */
  products: readonly PublicProduct[]
  /** Otra oferta que NO está en el carrusel, para la pieza de al lado. */
  next: PublicProduct | null
  /** Cuántas ofertas hay en total (no solo las de la portada). */
  offersTotal: number
  storeSlug: string
  thumbnails: Record<string, string>
}) {
  const { t, locale } = useI18n()
  const segunda = next
  const maxDescuento = Math.max(
    0,
    ...[...products, ...(next ? [next] : [])].map((product) => discountPercent(product) ?? 0),
  )

  return (
    <Box
      data-hero-variant="bento"
      sx={{
        display: 'grid',
        gap: { xs: 1.5, md: 2 },
        gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 340px' },
        alignItems: 'stretch',
      }}
    >
      <StoreFeaturedHero products={[...products]} storeSlug={storeSlug} thumbnails={thumbnails} />

      <Stack sx={{ gap: { xs: 1.5, md: 2 }, flexDirection: { xs: 'row', lg: 'column' }, minWidth: 0 }}>
        {segunda ? (
          <Box
            component={Link}
            to={`/s/${storeSlug}/product/${segunda.slug}`}
            data-bento-tile="offer"
            sx={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              p: { xs: 1.5, md: 2 },
              borderRadius: 'var(--sf-radius)',
              bgcolor: 'var(--card)',
              border: '1px solid var(--sf-line)',
              boxShadow: 'var(--sf-shadow)',
              textDecoration: 'none',
              color: 'var(--text)',
              transition: 'transform .18s ease, box-shadow .18s ease',
              '@media (hover: hover)': { '&:hover': { transform: 'translateY(-2px)', boxShadow: 'var(--sf-shadow-hover)' } },
              '@media (prefers-reduced-motion: reduce)': { transition: 'none', '&:hover': { transform: 'none' } },
              '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: 2 },
            }}
          >
            <Box
              sx={{
                position: 'relative',
                width: { xs: 84, md: 112 },
                flexShrink: 0,
                borderRadius: 'var(--sf-radius-sm)',
                overflow: 'hidden',
                bgcolor: 'var(--sf-media-bg, var(--neutral-soft))',
              }}
            >
              <ProductMedia
                url={segunda.primary_image_path ? (thumbnails[segunda.primary_image_path] ?? null) : null}
                alt=""
                fit="contain"
                ratio="1 / 1"
              />
              {discountPercent(segunda) !== null ? (
                <Box
                  sx={{
                    position: 'absolute',
                    top: 6,
                    left: 6,
                    px: 0.75,
                    borderRadius: 'var(--sf-pill)',
                    bgcolor: 'var(--sf-discount-bg, var(--accent-deep))',
                    color: 'var(--sf-discount-fg, #fff)',
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  -{discountPercent(segunda)}%
                </Box>
              ) : null}
            </Box>
            <Stack sx={{ minWidth: 0, gap: 0.25 }}>
              <Typography sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent-deep)' }}>
                {t('store.bento.alsoOnSale')}
              </Typography>
              <Typography
                sx={{
                  fontSize: TS.body,
                  fontWeight: 700,
                  lineHeight: 1.3,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {segunda.name}
              </Typography>
              <Stack direction="row" sx={{ alignItems: 'baseline', gap: 0.75 }}>
                <Typography className="tnum" sx={{ fontSize: 18, fontWeight: 800 }}>
                  {formatMoney(Number(segunda.price), segunda.currency, locale)}
                </Typography>
                {segunda.compare_at_price && discountPercent(segunda) !== null ? (
                  <Typography component="s" className="tnum" sx={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                    {formatMoney(Number(segunda.compare_at_price), segunda.currency, locale)}
                  </Typography>
                ) : null}
              </Stack>
            </Stack>
          </Box>
        ) : null}

        <Box
          component={Link}
          to={`/s/${storeSlug}?ver=todo&oferta=1`}
          data-bento-tile="all-offers"
          sx={{
            flex: 1,
            minWidth: 0,
            position: 'relative',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 0.5,
            p: { xs: 2, md: 2.5 },
            borderRadius: 'var(--sf-radius)',
            background: 'var(--hero-grad)',
            color: '#fff',
            textDecoration: 'none',
            '&::after': {
              content: '""',
              position: 'absolute',
              right: -40,
              bottom: -60,
              width: 180,
              height: 180,
              borderRadius: '50%',
              background: 'color-mix(in srgb, #fff 10%, transparent)',
              pointerEvents: 'none',
            },
            '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: 2 },
          }}
        >
          <LocalOfferRoundedIcon aria-hidden sx={{ fontSize: 22, opacity: 0.9 }} />
          <Typography sx={{ fontSize: { xs: 18, md: 22 }, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.15 }}>
            {t('store.bento.allOffers').replace('{n}', String(offersTotal))}
          </Typography>
          {maxDescuento > 0 ? (
            <Typography sx={{ fontSize: TS.label + 1, opacity: 0.9 }}>
              {t('store.bento.upTo').replace('{pct}', String(maxDescuento))}
            </Typography>
          ) : null}
          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mt: 0.5, fontWeight: 800, fontSize: TS.label + 1 }}>
            {t('store.bento.seeAll')}
            <ArrowForwardRoundedIcon aria-hidden sx={{ fontSize: 16 }} />
          </Stack>
        </Box>
      </Stack>
    </Box>
  )
}
