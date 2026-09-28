import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import BoltRoundedIcon from '@mui/icons-material/BoltRounded'
import EventRoundedIcon from '@mui/icons-material/EventRounded'
import FavoriteBorderRoundedIcon from '@mui/icons-material/FavoriteBorderRounded'
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded'
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded'
import { Box, IconButton, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { useCatalogCommercialPrices, type CommercialPrice } from '../commerce/catalogPrices'
import { vigenciaTexto } from '../offer'
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
  imageSrc = null,
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
  /**
   * La foto de esa campaña, ya firmada. Va de FONDO del bloque, bajo un velo
   * del color de la tienda que deja leer el texto blanco. Antes el bloque la
   * ignoraba: el comercio subía la foto, se guardaba, y la portada seguía
   * pintando solo el degradado.
   */
  imageSrc?: string | null
  /** Fin REAL de la campaña que antes termina. Sin fecha, no hay reloj. */
  clockEndsAt: string | null
  /** El mayor descuento real a la vista. 0 = no se dice «hasta». */
  maxDiscount: number
  storeSlug: string
  thumbnails: Record<string, string>
  favorites?: ReadonlySet<string>
  onToggleFavorite?: (productId: string) => void
}) {
  const { t, locale } = useI18n()
  const cuatro = products.slice(0, 4)
  const commercial = useCatalogCommercialPrices(storeSlug, cuatro)
  const kicker = promotion?.name ?? t('store.feria.kicker')
  const texto = promotion?.description ?? t('store.feria.subtitle')
  // El reloj solo aparece en la recta final (`HORIZONTE_RELOJ_MS`). Antes de
  // eso la fecha de fin sigue siendo un dato real y se dice en una línea:
  // «Hasta el 30 de octubre». Sin fecha de fin, ni reloj ni línea.
  const vigencia = clockEndsAt ? null : vigenciaTexto(promotion?.endsAt ?? null, t, locale)
  const n = cuatro.length
  // El reparto sigue a lo que HAY. La rejilla 2×2 con dos ofertas dejaba dos
  // tarjetas altas y medio vacías; con una o dos, el bloque de la campaña se
  // ensancha y las ofertas se apilan en una columna.
  const pocas = n <= 2

  return (
    <Box
      data-hero-variant="bento"
      data-offer-count={n}
      sx={{
        display: 'grid',
        gap: { xs: 1.5, md: 2 },
        gridTemplateColumns: {
          xs: '1fr',
          lg: pocas ? 'minmax(0, 7fr) minmax(0, 5fr)' : 'minmax(0, 5fr) minmax(0, 7fr)',
        },
        alignItems: 'stretch',
      }}
    >
      <Box
        component="section"
        aria-label={kicker}
        data-feria-block
        data-feria-image={imageSrc ? 'si' : undefined}
        sx={{
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: { xs: 2, md: 2.5 },
          p: { xs: 2.5, md: 4 },
          minHeight: { md: 360 },
          borderRadius: 'var(--sf-radius)',
          // Sin foto: el degradado de la tienda y, encima, una luz suave arriba
          // a la izquierda, que da volumen sin añadir un color que no sea suyo.
          // Con foto: la foto de fondo bajo un velo del color de la tienda, más
          // denso a la izquierda, donde va el texto blanco (contraste AA).
          background: imageSrc
            ? `linear-gradient(90deg, color-mix(in srgb, var(--accent-deep) 92%, transparent) 0%, color-mix(in srgb, var(--accent-deep) 72%, transparent) 55%, rgba(0,0,0,.28) 100%), url("${imageSrc.replace(/"/g, '%22')}") center / cover no-repeat`
            : 'radial-gradient(120% 90% at 0% 0%, rgba(255,255,255,.14) 0%, transparent 55%), var(--hero-grad)',
          color: '#fff',
          boxShadow: '0 18px 40px -24px rgba(0,0,0,.55)',
          '&::before, &::after': {
            // Los círculos decorativos se quitan sobre una foto: taparían lo
            // que el comercio eligió enseñar.
            display: imageSrc ? 'none' : 'block',
            content: '""',
            position: 'absolute',
            borderRadius: '50%',
            pointerEvents: 'none',
          },
          '&::before': {
            width: 280,
            height: 280,
            right: -80,
            top: -100,
            background: 'color-mix(in srgb, #fff 10%, transparent)',
          },
          '&::after': {
            width: 200,
            height: 200,
            right: 60,
            bottom: -110,
            border: '28px solid color-mix(in srgb, #fff 8%, transparent)',
          },
        }}
      >
        <Stack sx={{ position: 'relative', gap: { xs: 1.25, md: 1.75 } }}>
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
          sx={{
            display: 'flex',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            columnGap: 1.25,
            lineHeight: 0.95,
            fontWeight: 800,
            letterSpacing: '-0.03em',
            textShadow: '0 2px 18px rgba(0,0,0,.18)',
          }}
        >
          {maxDiscount > 0 ? (
            <>
              <Box component="span" sx={{ fontSize: { xs: 20, md: 26 }, opacity: 0.95 }}>
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

        <Typography
          sx={{
            fontSize: { xs: 14, md: 15.5 },
            opacity: 0.92,
            maxWidth: 440,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {texto}
        </Typography>
        </Stack>

        {/* Abajo, en una fila: CUÁNTO queda y la PUERTA. Separados del
            titular, que es lo que se lee primero. */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          sx={{
            position: 'relative',
            gap: { xs: 1.75, sm: 2.5 },
            alignItems: { xs: 'flex-start', sm: 'flex-end' },
            justifyContent: 'space-between',
            flexWrap: 'wrap',
          }}
        >
          {clockEndsAt ? (
            <Stack sx={{ gap: 0.75 }}>
              <Typography
                sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.85 }}
              >
                {t('store.feria.endsIn')}
              </Typography>
              <Countdown endsAt={clockEndsAt} />
            </Stack>
          ) : vigencia ? (
            <Stack
              direction="row"
              data-campaign-ends
              sx={{
                alignItems: 'center',
                gap: 0.75,
                px: 1.5,
                py: 0.75,
                borderRadius: 'var(--sf-pill)',
                bgcolor: 'rgba(255, 255, 255, 0.14)',
                border: '1px solid rgba(255, 255, 255, 0.24)',
                fontSize: 13.5,
                fontWeight: 700,
              }}
            >
              <EventRoundedIcon aria-hidden sx={{ fontSize: 17 }} />
              {vigencia.texto}
            </Stack>
          ) : null}

        <Box
          component={Link}
          to={`/s/${storeSlug}?ver=todo&oferta=1`}
          sx={{
            position: 'relative',
            alignSelf: { xs: 'flex-start', sm: 'flex-end' },
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
        </Stack>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gap: { xs: 1.25, md: 2 },
          gridTemplateColumns: {
            xs: '1fr',
            sm: n === 1 ? '1fr' : 'repeat(2, minmax(0, 1fr))',
            lg: pocas ? '1fr' : 'repeat(2, minmax(0, 1fr))',
          },
          gridAutoRows: '1fr',
          // Con tres, la última ocupa la fila entera en vez de dejar un hueco.
          ...(n === 3 ? { '& > :nth-of-type(3)': { gridColumn: { sm: '1 / -1' } } } : {}),
        }}
      >
        {cuatro.map((product) => (
          <FeriaOfferCard
            key={product.product_id}
            vertical={n === 1}
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
  vertical = false,
}: {
  /** Oferta única: foto arriba y más grande, para llenar la columna sin huecos. */
  vertical?: boolean
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
      direction={vertical ? { xs: 'row', sm: 'column' } : 'row'}
      data-feria-offer={product.product_id}
      sx={{
        position: 'relative',
        gap: 1.5,
        p: { xs: 1.25, md: 1.5 },
        alignItems: vertical ? { xs: 'center', sm: 'stretch' } : 'center',
        justifyContent: 'center',
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
          width: vertical ? { xs: 96, sm: '100%' } : { xs: 96, md: 120 },
          maxWidth: vertical ? { sm: 240 } : undefined,
          alignSelf: vertical ? { sm: 'center' } : undefined,
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
