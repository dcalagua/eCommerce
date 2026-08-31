import { Box, Card, Skeleton, Stack } from '@mui/material'
import { R } from '@/theme/tokens'
import type { PublicProduct } from '../types'
import { ProductCard } from './ProductCard'

/**
 * Rejilla del catálogo, mobile-first de verdad: **dos columnas ya en el móvil**
 * (que es como se ven las tiendas en el teléfono) y hasta cuatro en escritorio.
 * `auto-rows: 1fr` iguala la altura de las tarjetas sin medir nada en JS.
 */
const GRID_SX = {
  display: 'grid',
  gap: { xs: 1.5, md: 2 },
  gridTemplateColumns: {
    xs: 'repeat(2, minmax(0, 1fr))',
    sm: 'repeat(3, minmax(0, 1fr))',
    lg: 'repeat(4, minmax(0, 1fr))',
  },
  gridAutoRows: '1fr',
} as const

export function ProductGrid({
  products,
  storeSlug,
  thumbnails,
  onPrefetch,
  onQuickView,
}: {
  products: PublicProduct[]
  storeSlug: string
  thumbnails: Record<string, string>
  /** Se llama al apuntar o enfocar una tarjeta. Opcional a propósito: los
      relacionados de la ficha no lo pasan, porque ahí el siguiente clic es
      mucho menos probable que en la rejilla del catálogo. */
  onPrefetch?: (slug: string) => void
  /** Abre la vista rapida. Sin esto la tarjeta navega a la ficha, que es
      su comportamiento por defecto y el que conserva sin JavaScript. */
  onQuickView?: (slug: string) => void
}) {
  return (
    <Box sx={GRID_SX}>
      {products.map((product) => (
        <ProductCard
          key={product.product_id}
          product={product}
          storeSlug={storeSlug}
          {...(onQuickView ? { onQuickView } : {})}
          imageUrl={
            product.primary_image_path ? (thumbnails[product.primary_image_path] ?? null) : null
          }
          onPrefetch={onPrefetch}
        />
      ))}
    </Box>
  )
}

/**
 * Esqueleto con la MISMA rejilla que el catálogo real: si el esqueleto tuviera
 * otra forma, la página daría un salto al llegar los datos.
 */
export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <Box sx={GRID_SX} aria-hidden data-testid="catalog-skeleton">
      {Array.from({ length: count }, (_, index) => (
        <Card key={index} sx={{ p: 1.25, borderRadius: `${R.lg}px` }}>
          <Skeleton variant="rectangular" sx={{ aspectRatio: '1 / 1', borderRadius: `${R.md}px` }} />
          <Stack sx={{ gap: 0.5, mt: 1 }}>
            <Skeleton width="45%" height={12} />
            <Skeleton width="90%" height={18} />
            <Skeleton width="35%" height={18} />
          </Stack>
        </Card>
      ))}
    </Box>
  )
}
