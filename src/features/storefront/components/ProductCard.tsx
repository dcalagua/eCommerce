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
}: {
  product: PublicProduct
  storeSlug: string
  /** URL firmada de la imagen principal, o `null` para el marcador neutral. */
  imageUrl?: string | null
}) {
  const { t, locale } = useI18n()
  const discount = discountPercent(product)
  const available = product.in_stock !== false

  return (
    <Card
      component={Link}
      to={`/s/${storeSlug}/product/${product.slug}`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        p: 1.25,
        gap: 1,
        textDecoration: 'none',
        color: 'inherit',
        borderRadius: `${R.lg}px`,
        '&:hover': { borderColor: 'var(--accent)' },
        '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: 2 },
      }}
    >
      <Box sx={{ position: 'relative' }}>
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
        <Typography sx={{ fontSize: T.bodyStrong, fontWeight: 800 }}>
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
