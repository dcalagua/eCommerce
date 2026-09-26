import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import { Box, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { offerBadge, vigenciaTexto } from '../offer'
import type { StorePromotion } from '../promotions'

/**
 * Las campañas como DOS BANNERS lado a lado (Resumen v2 · contrato V5,
 * `promotions: 'banners'`).
 *
 * La primera sobre el tinte suave del acento y la segunda sobre el fondo
 * invertido: dos pesos para dos campañas, sin un color que no sea de la tienda.
 * Con una sola campaña ocupa el ancho entero. Más de dos no caben en esta
 * composición: la tienda que quiera enseñarlas todas elige el carrusel.
 */
export function PromoBanners({
  promotions,
  storeSlug,
  currency,
  assets = {},
}: {
  promotions: readonly StorePromotion[]
  storeSlug: string
  currency: string
  assets?: Record<string, string>
}) {
  const { t } = useI18n()
  const dos = promotions.slice(0, 2)
  if (dos.length === 0) return null

  return (
    <Box
      component="section"
      id="ofertas"
      aria-label={t('store.promos.title')}
      data-promotions-presentation="banners"
      sx={{
        display: 'grid',
        gap: { xs: 1.5, md: 2 },
        gridTemplateColumns: { xs: '1fr', md: dos.length > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr' },
        scrollMarginTop: 96,
      }}
    >
      {dos.map((promo, indice) => (
        <Banner
          key={promo.id}
          promo={promo}
          storeSlug={storeSlug}
          currency={currency}
          oscuro={indice === 1}
          imageSrc={fuenteDe(promo.imageUrl, assets)}
        />
      ))}
    </Box>
  )
}

function fuenteDe(referencia: string | null, firmadas: Record<string, string>) {
  if (!referencia) return null
  if (/^https?:\/\//i.test(referencia)) return referencia
  return firmadas[referencia] ?? null
}

function Banner({
  promo,
  storeSlug,
  currency,
  oscuro,
  imageSrc,
}: {
  promo: StorePromotion
  storeSlug: string
  currency: string
  oscuro: boolean
  imageSrc: string | null
}) {
  const { t, locale } = useI18n()
  const badge = offerBadge(promo, t, locale, currency)
  const vigencia = vigenciaTexto(promo.endsAt, t, locale)
  // A los productos que alcanza la campaña; al catálogo si es de pedido entero.
  const destino = promo.categorySlug
    ? `/s/${storeSlug}?c=${encodeURIComponent(promo.categorySlug)}`
    : promo.brandCode
      ? `/s/${storeSlug}?b=${encodeURIComponent(promo.brandCode)}`
      : `/s/${storeSlug}?ver=todo&oferta=1`

  return (
    <Stack
      direction="row"
      data-banner={oscuro ? 'contrast' : 'soft'}
      sx={{
        position: 'relative',
        overflow: 'hidden',
        alignItems: 'center',
        gap: 2,
        minHeight: { md: 184 },
        p: { xs: 2, md: 3 },
        borderRadius: 'var(--sf-radius)',
        bgcolor: oscuro ? 'var(--text)' : 'var(--accent-soft)',
        color: oscuro ? 'var(--card)' : 'var(--text)',
      }}
    >
      <Stack sx={{ flex: 1, minWidth: 0, gap: 0.75, position: 'relative', zIndex: 1 }}>
        {vigencia ? (
          <Typography
            sx={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: oscuro ? 'inherit' : 'var(--accent-deep)',
              opacity: oscuro ? 0.8 : 1,
            }}
          >
            {vigencia.texto}
          </Typography>
        ) : null}
        <Typography component="h3" sx={{ fontSize: { xs: 19, md: 24 }, fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.02em' }}>
          {promo.name}
        </Typography>
        {promo.description ? (
          <Typography sx={{ fontSize: 13.5, opacity: 0.85, maxWidth: 360 }}>{promo.description}</Typography>
        ) : null}
        <Box
          component={Link}
          to={destino}
          sx={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            mt: 0.5,
            fontSize: 13.5,
            fontWeight: 800,
            color: oscuro ? 'inherit' : 'var(--accent-deep)',
            textDecoration: 'none',
            '&::after': { content: '""', position: 'absolute', inset: 0 },
            '&:hover': { textDecoration: 'underline' },
            '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: 3 },
          }}
        >
          {t('store.promos.see')}
          <ArrowForwardRoundedIcon aria-hidden sx={{ fontSize: 16 }} />
        </Box>
      </Stack>

      {imageSrc ? (
        <Box
          component="img"
          src={imageSrc}
          alt=""
          loading="lazy"
          sx={{
            width: { xs: 96, md: 150 },
            height: { xs: 96, md: 150 },
            objectFit: 'cover',
            borderRadius: 'var(--sf-radius-sm)',
            flexShrink: 0,
          }}
        />
      ) : badge ? (
        <Box
          aria-hidden
          sx={{
            flexShrink: 0,
            width: { xs: 84, md: 112 },
            height: { xs: 84, md: 112 },
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            borderRadius: '50%',
            background: 'var(--hero-grad)',
            color: '#fff',
            fontSize: { xs: 18, md: 24 },
            fontWeight: 800,
            lineHeight: 1.05,
            px: 1,
          }}
        >
          {badge}
        </Box>
      ) : null}
    </Stack>
  )
}
