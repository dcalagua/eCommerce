import { Box, Button, Skeleton, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { PublicProduct } from '../types'
import { ProductCard } from './ProductCard'
import { ScrollRow } from './ScrollRow'

/**
 * Una fila de productos con su título y su «Ver todo».
 *
 * La portada dejó de ser una rejilla infinita de catálogo. Una rejilla es lo
 * que se quiere cuando YA se sabe qué se busca; quien acaba de entrar necesita
 * saber qué hay, y eso se enseña mejor en filas cortas con nombre —novedades,
 * ofertas, lo de siempre— que en 400 productos ordenados por relevancia.
 *
 * Cada fila lleva su puerta al catálogo completo: «Ver todo» es lo que abre la
 * rejilla con sus filtros. Antes esa rejilla estaba siempre puesta y no había
 * forma de enseñar nada por encima sin empujarla fuera de la pantalla.
 */
export function ProductRow({
  title,
  products,
  storeSlug,
  thumbnails,
  seeAllHref,
  loading = false,
  onPrefetch,
  onQuickView,
  favorites,
  onToggleFavorite,
}: {
  title: string
  products: readonly PublicProduct[]
  storeSlug: string
  thumbnails: Record<string, string>
  seeAllHref: string
  loading?: boolean
  onPrefetch?: (slug: string) => void
  onQuickView?: (slug: string) => void
  favorites?: ReadonlySet<string>
  onToggleFavorite?: (productId: string) => void
}) {
  const { t } = useI18n()
  if (!loading && products.length === 0) return null

  return (
    <Stack component="section" aria-label={title} sx={{ gap: 1.25 }}>
      <Stack direction="row" sx={{ gap: 1.5, alignItems: 'center' }}>
        <Typography
          component="h2"
          sx={{ fontSize: { xs: 19, md: 22 }, fontWeight: 800, letterSpacing: '-0.02em' }}
        >
          {title}
        </Typography>

        {/* La puerta al catálogo, al lado del título y no al final de la fila:
            al final hay que desplazarse hasta el borde para encontrarla, que es
            justo lo que se quiere evitar. */}
        <Button
          component={Link}
          to={seeAllHref}
          size="small"
          sx={{
            textTransform: 'none',
            fontWeight: 700,
            borderRadius: 'var(--sf-pill)',
            border: '1px solid var(--sf-line-strong)',
            color: 'var(--text)',
            px: 1.75,
            '&:hover': { borderColor: 'var(--accent)', bgcolor: 'transparent' },
          }}
        >
          {t('store.row.seeAll')}
        </Button>
      </Stack>

      <ScrollRow ariaLabel={title} gap={1.5}>
        {loading
          ? Array.from({ length: 6 }, (_, i) => (
              <Box key={i} sx={{ width: 208, flexShrink: 0 }}>
                <Skeleton variant="rounded" height={260} sx={{ borderRadius: 'var(--sf-radius)' }} />
              </Box>
            ))
          : products.map((product) => (
              <Box key={product.product_id} sx={{ width: 208, flexShrink: 0, display: 'flex' }}>
                <ProductCard
                  product={product}
                  storeSlug={storeSlug}
                  {...(onQuickView ? { onQuickView } : {})}
                  {...(onToggleFavorite ? { onToggleFavorite } : {})}
                  favorite={favorites?.has(product.product_id) ?? false}
                  imageUrl={
                    product.primary_image_path
                      ? (thumbnails[product.primary_image_path] ?? null)
                      : null
                  }
                  onPrefetch={onPrefetch}
                />
              </Box>
            ))}
      </ScrollRow>
    </Stack>
  )
}
