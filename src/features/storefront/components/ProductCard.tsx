import { Box, Card, Chip, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { R, T } from '@/theme/tokens'
import { discountPercent, type PublicProduct } from '../types'
import { ProductMedia } from './ProductMedia'

/**
 * Tarjeta de catálogo: foto, categoría, nombre, precio y disponibilidad.
 *
 * Toda la tarjeta es UN solo enlace, no un `div` con `onClick`: así el teclado
 * la alcanza con Tab, el lector de pantalla la anuncia como enlace y el
 * comprador puede abrirla en otra pestaña como en cualquier tienda.
 */
export function ProductCard({
  product,
  storeSlug,
  imageUrl = null,
  onPrefetch,
}: {
  product: PublicProduct
  storeSlug: string
  /** URL firmada de la imagen principal, o `null` para el marcador neutral. */
  imageUrl?: string | null
  /**
   * Aviso de intención (P15-SaaS). Se dispara al APUNTAR y al ENFOCAR, no al
   * pintar: adelantar las veinticuatro fichas de la rejilla serían veinticuatro
   * consultas que casi nadie usa. Y va también en `focus` para que quien navega
   * con teclado gane lo mismo que quien navega con ratón.
   */
  onPrefetch?: (slug: string) => void
}) {
  const { t, locale } = useI18n()
  const discount = discountPercent(product)
  const available = product.in_stock !== false

  return (
    <Card
      component={Link}
      to={`/s/${storeSlug}/product/${product.slug}`}
      onMouseEnter={() => onPrefetch?.(product.slug)}
      onFocus={() => onPrefetch?.(product.slug)}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        p: 1.25,
        gap: 1,
        textDecoration: 'none',
        color: 'inherit',
        borderRadius: `${R.lg}px`,
        // El movimiento es la unica senal de que la tarjeta es pulsable, asi
        // que se anula entero con prefers-reduced-motion en vez de acortarlo.
        transition: 'transform .18s ease, box-shadow .18s ease, border-color .18s ease',
        '&:hover': {
          borderColor: 'var(--accent)',
          boxShadow: 'var(--shadow-md)',
          transform: 'translateY(-4px)',
        },
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
          '&:hover': { transform: 'none' },
        },
        '&:hover .eb-card-media img': { transform: 'scale(1.06)' },
        '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: 2 },
      }}
    >
      <Box
        className="eb-card-media"
        sx={{
          position: 'relative',
          '& img': {
            transition: 'transform .35s ease',
            '@media (prefers-reduced-motion: reduce)': { transition: 'none', transform: 'none' },
          },
          // Agotado: la foto se apaga para que el estado se lea de un vistazo
          // en la rejilla, no solo al llegar a la linea de texto.
          ...(available ? {} : { '& img': { filter: 'grayscale(1)', opacity: 0.55 } }),
        }}
      >
        <ProductMedia url={imageUrl} alt={product.primary_image_alt ?? product.name} />
        {discount !== null && (
          <Chip
            label={`-${discount}%`}
            size="small"
            sx={{
              position: 'absolute',
              top: 8,
              left: 8,
              bgcolor: 'var(--accent)',
              color: '#FFFFFF',
              fontWeight: 800,
              fontSize: T.label,
              letterSpacing: '0.02em',
              boxShadow: '0 2px 8px rgba(0,0,0,0.28)',
            }}
          />
        )}
      </Box>

      <Stack sx={{ gap: 0.25, flex: 1 }}>
        {product.category_name && (
          <Typography
            sx={{
              fontSize: T.label,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              color: 'var(--muted)',
            }}
          >
            {product.category_name}
          </Typography>
        )}
        <Typography
          component="h3"
          sx={{
            fontSize: T.cardTitle,
            fontWeight: 700,
            lineHeight: 1.35,
            // Dos líneas y elipsis: los nombres largos no pueden descuadrar la
            // rejilla ni empujar el precio fuera de la tarjeta.
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {product.name}
        </Typography>
      </Stack>

      <Stack
        direction="row"
        sx={{ alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap', mt: 'auto' }}
      >
        <Typography sx={{ fontSize: T.cardTitle, fontWeight: 800, letterSpacing: '-0.01em' }}>
          {formatMoney(Number(product.price), product.currency, locale)}
        </Typography>
        {discount !== null && product.compare_at_price && (
          <Typography
            component="s"
            sx={{ fontSize: T.label, color: 'var(--muted)', fontWeight: 600 }}
          >
            {formatMoney(Number(product.compare_at_price), product.currency, locale)}
          </Typography>
        )}
      </Stack>

      <Typography
        sx={{
          fontSize: T.label,
          fontWeight: 700,
          color: available ? 'var(--accent-deep)' : 'var(--muted)',
        }}
      >
        {available ? t('store.availability.inStock') : t('store.availability.outOfStock')}
      </Typography>
    </Card>
  )
}
