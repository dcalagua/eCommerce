import AddIcon from '@mui/icons-material/Add'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import RemoveIcon from '@mui/icons-material/Remove'
import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined'
import { Box, Button, Card, Chip, Divider, IconButton, Stack, Typography } from '@mui/material'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { R, T } from '@/theme/tokens'
import { StorefrontNotFoundError } from './api'
import { MAX_LINE_QUANTITY } from './cart/cart'
import { useCart } from './cart/cart-context'
import { ProductGallery } from './components/ProductGallery'
import { ProductGrid } from './components/ProductGrid'
import {
  useGallery,
  usePublicProduct,
  usePublicProducts,
  useStorefront,
  useThumbnails,
} from './hooks'
import { discountPercent, pickRelated, type CatalogQuery, type PublicProduct } from './types'

/**
 * Ficha de producto: galería, precio, disponibilidad, descripción, cantidad,
 * botón de compra y relacionados.
 *
 * El botón añade al carrito de ESTA tienda con el precio que el catálogo acaba
 * de devolver. Ese precio es de escaparate: el que se cobra lo vuelve a leer la
 * base al confirmar el pedido.
 */
export function StoreProductPage() {
  const { t, locale } = useI18n()
  const { store, storeSlug } = useStorefront()
  const { productSlug } = useParams<{ productSlug: string }>()

  const product = usePublicProduct(store.store_id, productSlug)
  const gallery = useGallery(product.data?.product_id ?? null)

  // Relacionados «simples»: el resto de su categoría. Si no tiene categoría o
  // no llega para llenar la fila, `pickRelated` completa con el catálogo.
  const relatedQuery: CatalogQuery = useMemo(
    () => ({
      storeId: product.data ? store.store_id : null,
      search: '',
      categorySlug: product.data?.category_slug ?? null,
      availability: 'all',
      sort: 'recent',
    }),
    [product.data, store.store_id],
  )
  const catalog = usePublicProducts(relatedQuery)
  const related = product.data ? pickRelated(catalog.data ?? [], product.data) : []
  const relatedThumbs = useThumbnails(related)

  if (product.isPending) return <LoadingState />

  if (product.isError || !product.data) {
    if (product.error instanceof StorefrontNotFoundError) {
      return (
        <Card>
          <EmptyState
            title={t('store.product.notFound')}
            description={t('store.product.notFoundBody')}
            action={
              <Button component={Link} to={`/s/${storeSlug}`} variant="contained">
                {t('store.product.back')}
              </Button>
            }
          />
        </Card>
      )
    }
    return (
      <Card>
        <ErrorState error={product.error} onRetry={() => void product.refetch()} />
      </Card>
    )
  }

  const item = product.data
  const discount = discountPercent(item)
  const available = item.in_stock !== false

  return (
    <Stack sx={{ gap: { xs: 2.5, md: 4 } }}>
      <Box>
        <Button
          component={Link}
          to={`/s/${storeSlug}`}
          startIcon={<ArrowBackIcon />}
          sx={{ ml: -1 }}
        >
          {t('store.product.back')}
        </Button>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gap: { xs: 2, md: 4 },
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1.1fr) minmax(0, 1fr)' },
          alignItems: 'start',
        }}
      >
        <ProductGallery images={gallery.data ?? []} alt={item.name} />

        <Stack sx={{ gap: 1.25 }}>
          {item.category_name && (
            <Typography
              sx={{
                fontSize: T.label,
                fontWeight: 700,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                color: 'var(--muted)',
              }}
            >
              {item.category_name}
            </Typography>
          )}

          <Typography component="h1" sx={{ fontSize: { xs: 22, md: 26 }, fontWeight: 800 }}>
            {item.name}
          </Typography>

          <Stack direction="row" sx={{ gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <Typography sx={{ fontSize: 24, fontWeight: 800 }}>
              {formatMoney(Number(item.price), item.currency, locale)}
            </Typography>
            {discount !== null && item.compare_at_price && (
              <>
                <Typography component="s" sx={{ color: 'var(--muted)', fontWeight: 600 }}>
                  {formatMoney(Number(item.compare_at_price), item.currency, locale)}
                </Typography>
                <Chip
                  label={`-${discount}%`}
                  size="small"
                  sx={{ bgcolor: 'var(--accent)', color: '#FFFFFF', fontWeight: 800 }}
                />
              </>
            )}
          </Stack>

          <Typography
            sx={{
              fontSize: T.bodyStrong,
              fontWeight: 700,
              color: available ? 'var(--accent-deep)' : 'var(--muted)',
            }}
          >
            {available ? t('store.availability.inStock') : t('store.availability.outOfStock')}
          </Typography>

          <AddToCart product={item} available={available} />

          <Divider sx={{ my: 1 }} />

          <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800 }}>
            {t('store.product.description')}
          </Typography>
          <Typography
            sx={{
              fontSize: T.body,
              color: item.description ? 'var(--text)' : 'var(--muted)',
              whiteSpace: 'pre-line',
              lineHeight: 1.65,
            }}
          >
            {item.description?.trim() || t('store.product.noDescription')}
          </Typography>
        </Stack>
      </Box>

      {related.length > 0 && (
        <Box component="section">
          <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800, mb: 1.5 }}>
            {t('store.product.related')}
          </Typography>
          <ProductGrid products={related} storeSlug={storeSlug} thumbnails={relatedThumbs} />
        </Box>
      )}
    </Stack>
  )
}

/**
 * Cantidad + «Agregar al carrito».
 *
 * Sin stock no hay botón habilitado: la disponibilidad la manda `in_stock`, que
 * la vista pública deriva del inventario real. Y aunque alguien lo forzara, la
 * base vuelve a comprobar el stock al crear el pedido.
 */
function AddToCart({ product, available }: { product: PublicProduct; available: boolean }) {
  const { t } = useI18n()
  const { add } = useCart()
  const [quantity, setQuantity] = useState(1)

  return (
    <Stack direction="row" sx={{ gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mt: 1 }}>
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          gap: 0.5,
          border: '1px solid var(--border)',
          borderRadius: `${R.md}px`,
          px: 0.5,
        }}
      >
        <IconButton
          size="small"
          aria-label={t('store.cart.decrease')}
          disabled={quantity <= 1}
          onClick={() => setQuantity((value) => Math.max(1, value - 1))}
        >
          <RemoveIcon fontSize="small" />
        </IconButton>
        <Typography
          component="output"
          aria-live="polite"
          aria-label={t('store.cart.quantity')}
          sx={{ minWidth: 28, textAlign: 'center', fontWeight: 800 }}
        >
          {quantity}
        </Typography>
        <IconButton
          size="small"
          aria-label={t('store.cart.increase')}
          disabled={quantity >= MAX_LINE_QUANTITY}
          onClick={() => setQuantity((value) => Math.min(MAX_LINE_QUANTITY, value + 1))}
        >
          <AddIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Button
        variant="contained"
        startIcon={<ShoppingCartOutlinedIcon />}
        disabled={!available}
        onClick={() => add(product, quantity)}
      >
        {t('store.product.addToCart')}
      </Button>
    </Stack>
  )
}
