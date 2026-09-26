import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import BoltRoundedIcon from '@mui/icons-material/BoltRounded'
import FavoriteBorderRoundedIcon from '@mui/icons-material/FavoriteBorderRounded'
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded'
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded'
import { Box, IconButton, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { useCatalogCommercialPrices, type CommercialPrice } from '../commerce/catalogPrices'
import type { StorePromotion } from '../promotions'
import { discountPercent, type PublicProduct } from '../types'
import { Countdown } from './Countdown'
import { ProductMedia } from './ProductMedia'

/**
 * La portada «FERIA DE OFERTAS» (Resumen v2 · tema Retail, `heroVariant: 'bento'`).
 *
 * Dos piezas, como en el diseño:
 *
 *  1. **El bloque de la campaña**, en el color de la tienda: el nombre de la
 *     campaña vigente, «hasta −N %» con el mayor descuento REAL, su texto, la
 *     cuenta regresiva si la campaña tiene fecha de fin, y la puerta a todas
 *     las ofertas.
 *  2. **Cuatro ofertas** en rejilla de 2×2, cada una con su foto, corazón,
 *     porcentaje, precio tachado y —si la cuenta de empresa tiene convenio— su
 *     precio de convenio.
 *
 * Nada se inventa: sin campaña, el bloque habla de las ofertas; sin fecha de
 * fin, no hay reloj; sin descuento, no hay «hasta −N %». El COLOR es el de la
 * tienda (`--hero-grad`); el tema solo pone la forma.
 */
export function StoreBentoHero({
  products,
  promotion,
  clockEndsAt,
  maxDiscount,
  storeSlug,
  thumbnails,
  favorites,
  onToggleFavorite,
}: {
  /** Las ofertas de la portada; se pintan hasta cuatro. */
  products: readonly PublicProduct[]
  /** La campaña que da nombre y texto al bloque. Sin ella, se habla de las ofertas. */
  promotion: StorePromotion | null
  /** Fin REAL de la campaña que antes termina. Sin fecha, no hay reloj. */
  clockEndsAt: string | null
  /** El mayor descuento real a la vista. 0 = no se dice «hasta». */
  maxDiscount: number
  storeSlug: string
  thumbnails: Record<string, string>
  favorites?: ReadonlySet<string>
  onToggleFavorite?: (productId: string) => void
}) {
  const { t } = useI18n()
  const cuatro = products.slice(0, 4)
  const commercial = useCatalogCommercialPrices(storeSlug, cuatro)
  const kicker = promotion?.name ?? t('store.feria.kicker')
  const texto = promotion?.description ?? t('store.feria.subtitle')

  return (
    <Box
      data-hero-variant="bento"
      sx={{
        display: 'grid',
        gap: { xs: 1.5, md: 2 },
        gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 5fr) minmax(0, 7fr)' },
        alignItems: 'stretch',
      }}
    >
      <Box
        component="section"
        aria-label={kicker}
        data-feria-block
        sx={{
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: { xs: 1.5, md: 2 },
          p: { xs: 2.5, md: 4 },
          minHeight: { md: 360 },
          borderRadius: 'var(--sf-radius)',
          background: 'var(--hero-grad)',
          color: '#fff',
          '&::before, &::after': {
            content: '""',
            position: 'absolute',
            borderRadius: '50%',
            background: 'color-mix(in srgb, #fff 9%, transparent)',
            pointerEvents: 'none',
          },
          '&::before': { width: 260, height: 260, right: -70, top: -90 },
          '&::after': { width: 220, height: 220, right: 40, bottom: -120 },
        }}
      >
        <Box
          sx={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1.25,
            py: 0.375,
            borderRadius: 'var(--sf-pill)',
            bgcolor: '#fff',
            color: 'var(--accent-deep)',
            fontSize: 11.5,
            fontWeight: 800,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            position: 'relative',
          }}
        >
          <BoltRoundedIcon aria-hidden sx={{ fontSize: 15 }} />
          {kicker}
        </Box>

        <Typography
          component="h1"
          sx={{ position: 'relative', lineHeight: 0.95, fontWeight: 800, letterSpacing: '-0.03em' }}
        >
          {maxDiscount > 0 ? (
            <>
              <Box component="span" sx={{ fontSize: { xs: 20, md: 26 }, mr: 1, verticalAlign: 'bottom' }}>
                {t('store.feria.upTo')}
              </Box>
              <Box component="span" className="tnum" sx={{ fontSize: { xs: 64, md: 96 } }}>
                {`−${maxDiscount}%`}
              </Box>
            </>
          ) : (
            <Box component="span" sx={{ fontSize: { xs: 32, md: 44 } }}>
              {t('store.feria.title')}
            </Box>
          )}
        </Typography>

        <Typography sx={{ position: 'relative', fontSize: { xs: 14, md: 15.5 }, opacity: 0.92, maxWidth: 420 }}>
          {texto}
        </Typography>

        <Box sx={{ position: 'relative' }}>
          <Countdown endsAt={clockEndsAt} />
        </Box>

        <Box
          component={Link}
          to={`/s/${storeSlug}?ver=todo&oferta=1`}
          sx={{
            position: 'relative',
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.75,
            px: 2.25,
            py: 1.125,
            borderRadius: 'var(--sf-radius-sm)',
            bgcolor: '#fff',
            color: 'var(--accent-deep)',
            fontWeight: 800,
            fontSize: 14,
            textDecoration: 'none',
            boxShadow: '0 6px 18px -8px rgba(0,0,0,.45)',
            '&:hover': { transform: 'translateY(-1px)' },
            '&:focus-visible': { outline: '2px solid #fff', outlineOffset: 3 },
            '@media (prefers-reduced-motion: reduce)': { '&:hover': { transform: 'none' } },
          }}
        >
          {t('store.feria.seeAll')}
          <ArrowForwardRoundedIcon aria-hidden sx={{ fontSize: 17 }} />
        </Box>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gap: { xs: 1.25, md: 2 },
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          gridAutoRows: '1fr',
        }}
      >
        {cuatro.map((product) => (
          <FeriaOfferCard
            key={product.product_id}
            product={product}
            storeSlug={storeSlug}
            imageUrl={product.primary_image_path ? (thumbnails[product.primary_image_path] ?? null) : null}
            commercialPrice={commercial.get(product.product_id) ?? null}
            favorite={favorites?.has(product.product_id) ?? false}
            {...(onToggleFavorite ? { onToggleFavorite } : {})}
          />
        ))}
      </Box>
    </Box>
  )
}

/**
 * Una oferta de la portada, en horizontal: foto a la izquierda y, al lado, el
 * porcentaje, el nombre, el precio de antes tachado y el de ahora. Con precio
 * de convenio, la cifra grande es la SUYA y se marca «Convenio».
 */
function FeriaOfferCard({
  product,
  storeSlug,
  imageUrl,
  commercialPrice,
  favorite,
  onToggleFavorite,
}: {
  product: PublicProduct
  storeSlug: string
  imageUrl: string | null
  commercialPrice: CommercialPrice | null
  favorite: boolean
  onToggleFavorite?: (productId: string) => void
}) {
  const { t, locale } = useI18n()
  const descuento = discountPercent(product)
  const precio = commercialPrice ? commercialPrice.amount : Number(product.price)
  const antes = product.compare_at_price && descuento !== null ? Number(product.compare_at_price) : commercialPrice ? Number(product.price) : null

  return (
    <Stack
      direction="row"
      data-feria-offer={product.product_id}
      sx={{
        position: 'relative',
        gap: 1.5,
        p: { xs: 1.25, md: 1.5 },
        alignItems: 'center',
        minWidth: 0,
        borderRadius: 'var(--sf-radius)',
        bgcolor: 'var(--card)',
        border: '1px solid var(--sf-line)',
        boxShadow: 'var(--sf-shadow)',
        '&:has(a:focus-visible)': { outline: '2px solid var(--accent)', outlineOffset: 2 },
      }}
    >
      <Box
        sx={{
          position: 'relative',
          width: { xs: 96, md: 120 },
          flexShrink: 0,
          borderRadius: 'var(--sf-radius-sm)',
          overflow: 'hidden',
          bgcolor: 'var(--accent-soft)',
        }}
      >
        <ProductMedia url={imageUrl} alt={product.primary_image_alt ?? product.name} fit="contain" ratio="1 / 1" />
        {onToggleFavorite ? (
          <IconButton
            size="small"
            aria-pressed={favorite}
            aria-label={`${favorite ? t('store.favorite.remove') : t('store.favorite.add')}: ${product.name}`}
            onClick={() => onToggleFavorite(product.product_id)}
            sx={{
              position: 'absolute',
              top: 6,
              right: 6,
              zIndex: 1,
              width: 28,
              height: 28,
              bgcolor: 'var(--card)',
              color: favorite ? 'var(--sf-heart)' : 'var(--muted)',
              boxShadow: 'var(--sf-shadow)',
              '&:hover': { bgcolor: 'var(--card)' },
            }}
          >
            {favorite ? <FavoriteRoundedIcon sx={{ fontSize: 16 }} /> : <FavoriteBorderRoundedIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        ) : null}
      </Box>

      <Stack sx={{ minWidth: 0, gap: 0.375 }}>
        {descuento !== null ? (
          <Box
            sx={{
              alignSelf: 'flex-start',
              px: 0.875,
              borderRadius: 'var(--sf-pill)',
              bgcolor: 'var(--sf-discount-bg, var(--accent-deep))',
              color: 'var(--sf-discount-fg, #fff)',
              fontSize: 12,
              fontWeight: 800,
              lineHeight: 1.7,
            }}
          >
            {`−${descuento}%`}
          </Box>
        ) : null}
        <Typography
          component={Link}
          to={`/s/${storeSlug}/product/${product.slug}`}
          sx={{
            fontSize: 14,
            fontWeight: 700,
            lineHeight: 1.3,
            color: 'var(--text)',
            textDecoration: 'none',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            '&::after': { content: '""', position: 'absolute', inset: 0 },
            '&:focus-visible': { outline: 'none' },
          }}
        >
          {product.name}
        </Typography>
        {antes !== null ? (
          <Typography component="s" className="tnum" sx={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
            {formatMoney(antes, product.currency, locale)}
          </Typography>
        ) : null}
        <Typography className="tnum" sx={{ fontSize: { xs: 20, md: 24 }, fontWeight: 800, lineHeight: 1.1, color: 'var(--accent-deep)' }}>
          {formatMoney(precio, product.currency, locale)}
        </Typography>
        {commercialPrice ? (
          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.375, color: 'var(--accent-deep)' }}>
            <VerifiedRoundedIcon aria-hidden sx={{ fontSize: 13 }} />
            <Typography sx={{ fontSize: 11, fontWeight: 800 }}>
              {commercialPrice.label === 'enterprise' ? t('store.product.agreementPriceCard') : t('store.product.tradePriceCard')}
            </Typography>
          </Stack>
        ) : null}
      </Stack>
    </Stack>
  )
}
