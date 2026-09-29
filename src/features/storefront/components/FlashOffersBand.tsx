import BoltRoundedIcon from '@mui/icons-material/BoltRounded'
import TimerOutlinedIcon from '@mui/icons-material/TimerOutlined'
import { Box, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { useCatalogCommercialPrices } from '../commerce/catalogPrices'
import type { PublicProduct } from '../types'
import { Countdown } from './Countdown'
import { ProductCard } from './ProductCard'

/**
 * La banda «OFERTAS RELÁMPAGO» (Resumen v2 · contrato V5, `offers: 'flash'`).
 *
 * Una franja con fondo INVERTIDO —la tinta del tema de fondo y la tarjeta de
 * texto—, así que en modo oscuro se aclara sola: no es un color, es contraste.
 * El acento de la tienda solo marca el rayo y el reloj.
 *
 * El reloj sale de la campaña vigente que ANTES termina. Sin fecha de fin, la
 * banda se llama «Ofertas de la semana» y no enseña reloj: prometer que algo
 * termina sin saber cuándo es una urgencia inventada.
 *
 * El «% vendido» del diseño no se pinta: el stock no es un dato público de la
 * vitrina y una barra inventada engaña.
 */
export function FlashOffersBand({
  offers,
  total,
  clockEndsAt,
  storeSlug,
  thumbnails,
  favorites,
  onToggleFavorite,
  onQuickView,
}: {
  offers: readonly PublicProduct[]
  /** Cuántas ofertas hay en total, para «Ver las N». */
  total: number
  clockEndsAt: string | null
  storeSlug: string
  thumbnails: Record<string, string>
  favorites?: ReadonlySet<string>
  onToggleFavorite?: (productId: string) => void
  onQuickView?: (slug: string) => void
}) {
  const { t } = useI18n()
  const seis = offers.slice(0, 6)
  const commercial = useCatalogCommercialPrices(storeSlug, seis)
  if (seis.length === 0) return null

  const titulo = clockEndsAt ? t('store.flash.title') : t('store.row.weekDeals')

  return (
    <Box
      component="section"
      aria-label={titulo}
      data-offers-presentation="flash"
      sx={{
        p: { xs: 1.5, md: 2.5 },
        borderRadius: 'var(--sf-radius)',
        bgcolor: 'var(--text)',
        color: 'var(--card)',
      }}
    >
      <Stack
        direction="row"
        sx={{ alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: { xs: 1.5, md: 2 } }}
      >
        <Box
          aria-hidden
          sx={{
            width: 36,
            height: 36,
            display: 'grid',
            placeItems: 'center',
            borderRadius: '50%',
            background: 'var(--hero-grad)',
            color: '#fff',
          }}
        >
          <BoltRoundedIcon sx={{ fontSize: 22 }} />
        </Box>
        <Typography component="h2" sx={{ fontSize: { xs: 20, md: 24 }, fontWeight: 800, letterSpacing: '-0.02em' }}>
          {titulo}
        </Typography>
        {clockEndsAt ? (
          <Stack
            direction="row"
            sx={{
              alignItems: 'center',
              gap: 0.5,
              px: 1.25,
              py: 0.375,
              borderRadius: 'var(--sf-radius-sm)',
              background: 'var(--hero-grad)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 800,
            }}
          >
            <TimerOutlinedIcon aria-hidden sx={{ fontSize: 16 }} />
            {t('store.flash.endsIn')} <Countdown endsAt={clockEndsAt} variant="inline" />
          </Stack>
        ) : null}
        <Box
          component={Link}
          to={`/s/${storeSlug}?ver=todo&oferta=1`}
          sx={{
            ml: 'auto',
            fontSize: 13.5,
            fontWeight: 800,
            color: 'inherit',
            textDecoration: 'none',
            whiteSpace: 'nowrap',
            '&:hover': { textDecoration: 'underline' },
          }}
        >
          {t('store.flash.seeAll').replace('{n}', String(Math.max(total, seis.length)))}
          <Box component="span" aria-hidden sx={{ ml: 0.5 }}>
            →
          </Box>
        </Box>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gap: { xs: 1, md: 1.5 },
          gridTemplateColumns: {
            xs: 'repeat(2, minmax(0, 1fr))',
            sm: 'repeat(3, minmax(0, 1fr))',
            lg: 'repeat(6, minmax(0, 1fr))',
          },
          gridAutoRows: '1fr',
          color: 'var(--text)',
        }}
      >
        {seis.map((product) => (
          <ProductCard
            key={product.product_id}
            product={product}
            storeSlug={storeSlug}
            commercialPrice={commercial.get(product.product_id) ?? null}
            favorite={favorites?.has(product.product_id) ?? false}
            imageUrl={product.primary_image_path ? (thumbnails[product.primary_image_path] ?? null) : null}
            {...(onQuickView ? { onQuickView } : {})}
            {...(onToggleFavorite ? { onToggleFavorite } : {})}
          />
        ))}
      </Box>
    </Box>
  )
}
