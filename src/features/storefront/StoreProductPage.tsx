import AddRoundedIcon from '@mui/icons-material/AddRounded'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import RemoveRoundedIcon from '@mui/icons-material/RemoveRounded'
import ShoppingCartRoundedIcon from '@mui/icons-material/ShoppingCartRounded'
import {
  Box,
  Button,
  Card,
  Chip,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { useDocumentMeta } from '@/shared/seo/useDocumentMeta'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { R, T } from '@/theme/tokens'
import { StorefrontNotFoundError } from './api'
import { ProductPageSkeleton } from './components/ProductPageSkeleton'
import { notFoundMeta, productMeta } from './seo'
import { MAX_LINE_QUANTITY } from './cart/cart'
import { track } from './analytics'
import { useCart } from './cart/cart-context'
import { ProductGallery } from './components/ProductGallery'
import { ProductGrid } from './components/ProductGrid'
import {
  useGallery,
  usePublicProduct,
  usePublicProducts,
  usePublicVariants,
  useStorefront,
  useThumbnails,
} from './hooks'
import {
  defaultVariant,
  discountPercent,
  pickRelated,
  type CatalogQuery,
  type PublicProduct,
  type PublicVariant,
} from './types'

/**
 * Ficha de producto: galería, precio, disponibilidad, descripción, cantidad,
 * botón de compra y relacionados.
 *
 * El botón añade al carrito de ESTA tienda con el precio que el catálogo acaba
 * de devolver. Ese precio es de escaparate: el que se cobra lo vuelve a leer la
 * base al confirmar el pedido.
 */
/** Filas que se piden para escoger los cuatro relacionados que se pintan. */
const RELATED_FETCH = 12

export function StoreProductPage() {
  const { t, locale } = useI18n()
  const { store, storeSlug } = useStorefront()
  const { productSlug } = useParams<{ productSlug: string }>()

  const product = usePublicProduct(store.store_id, productSlug)
  const gallery = useGallery(product.data?.product_id ?? null)
  const variants = usePublicVariants(product.data)

  // Relacionados «simples»: el resto de su categoría. Si no tiene categoría o
  // no llega para llenar la fila, `pickRelated` completa con el catálogo.
  const relatedQuery: CatalogQuery = useMemo(
    () => ({
      storeId: product.data ? store.store_id : null,
      search: '',
      categorySlug: product.data?.category_slug ?? null,
      availability: 'all',
      sort: 'recent',
      // Se piden doce para escoger cuatro. Hasta P14 esta consulta iba SIN
      // techo: para pintar una fila de relacionados el navegador se descargaba
      // la categoría entera —en un catálogo de dos mil referencias, dos mil
      // filas por ficha visitada—. Doce da margen de sobra para descartar el
      // producto abierto y sigue eligiendo los mismos cuatro, porque el orden
      // (`published_at desc`) no cambia al recortar.
      limit: RELATED_FETCH,
    }),
    [product.data, store.store_id],
  )
  const catalog = usePublicProducts(relatedQuery)
  const related = product.data ? pickRelated(catalog.data ?? [], product.data) : []
  const relatedThumbs = useThumbnails(related)

  // `product_view` (P13-SaaS). Se emite cuando la ficha ya se resolvió y por
  // producto, no por render: sin la dependencia en el id, cada cambio de
  // variante o de galería contaría una vista nueva y el numerador del embudo
  // subiría solo. Dispara y olvida: si falla, la ficha no se entera.
  const viewedProductId = product.data?.product_id ?? null
  useEffect(() => {
    if (!storeSlug || !viewedProductId) return
    track(storeSlug, { type: 'product_view', product_id: viewedProductId })
  }, [storeSlug, viewedProductId])

  /**
   * SEO de la ficha (P15-SaaS).
   *
   * La imagen que se declara es la PRIMARIA ya firmada, si llegó: una URL de
   * bucket privado sin firmar no la puede leer ni un buscador ni el previo de
   * un chat, y anunciarla sería prometer una foto que nadie va a ver.
   *
   * Y una ficha que no resuelve —despublicada, de otra tienda, inventada— se
   * marca `noindex`: la SPA responde 200 igual, y sin esto el «no encontramos
   * este producto» entraría al índice como si fuera catálogo.
   */
  const heroImage = gallery.data?.find((image) => image.url)?.url ?? null
  useDocumentMeta(
    product.data
      ? productMeta({ store, storeSlug, locale, pathname: `/s/${storeSlug}` }, product.data, heroImage)
      : product.isError
        ? notFoundMeta({
            title: t('store.product.notFound'),
            pathname: `/s/${storeSlug}/product/${productSlug ?? ''}`,
            siteName: store.name,
            locale,
          })
        : null,
  )

  // Esqueleto con la FORMA de la ficha, no un aro girando en el centro: al
  // llegar los datos la galería y la columna de compra caen donde ya estaba el
  // hueco, en vez de empujar la página hacia abajo.
  if (product.isPending) return <ProductPageSkeleton />

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
  const hasVariants = item.kind === 'variant'

  return (
    <Stack sx={{ gap: { xs: 2.5, md: 4 } }}>
      <Box>
        <Button
          component={Link}
          to={`/s/${storeSlug}`}
          startIcon={<ArrowBackRoundedIcon />}
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
            {/* Con variantes el precio de la ficha es un "desde" hasta que el
                comprador elige: el maestro puede costar 60 y la talla XL 70,
                y anunciar 60 a secas es un precio que no se va a cobrar. */}
            {hasVariants && item.variant_count > 1 && (
              <Typography sx={{ color: 'var(--muted)', fontWeight: 700 }}>
                {t('store.product.priceFrom')}
              </Typography>
            )}
            <Typography sx={{ fontSize: 24, fontWeight: 800 }}>
              {formatMoney(
                Number(hasVariants ? (item.price_from ?? item.price) : item.price),
                item.currency,
                locale,
              )}
            </Typography>
            {!hasVariants && discount !== null && item.compare_at_price && (
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

          <AddToCart
            product={item}
            available={available}
            variants={hasVariants ? (variants.data ?? []) : []}
            variantsPending={hasVariants && variants.isPending}
          />

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
 * Elección de variante + cantidad + «Agregar al carrito».
 *
 * Sin stock no hay botón habilitado: la disponibilidad la manda `in_stock`, que
 * la vista pública deriva del inventario real —de la variante o de los
 * componentes del kit, según el tipo—. Y aunque alguien lo forzara, la base
 * vuelve a comprobar el stock al crear el pedido.
 *
 * Con variantes, el botón exige elegir una. NO se elige "la primera" en
 * silencio: preseleccionar es cómodo, pero comprar sin haber elegido es recibir
 * la talla que no era.
 */
function AddToCart({
  product,
  available,
  variants,
  variantsPending,
}: {
  product: PublicProduct
  available: boolean
  variants: PublicVariant[]
  variantsPending: boolean
}) {
  const { t, locale } = useI18n()
  const { storeSlug } = useStorefront()
  const { add } = useCart()
  const [quantity, setQuantity] = useState(1)
  const [variantId, setVariantId] = useState('')

  const hasVariants = product.kind === 'variant'

  // Preselección: la marcada por defecto, o la primera disponible. Se aplica
  // cuando llegan las variantes y no antes, para no fijar una elección sobre
  // una lista vacía.
  useEffect(() => {
    if (!hasVariants || variants.length === 0) return
    setVariantId((current) =>
      current && variants.some((variant) => variant.variant_id === current)
        ? current
        : (defaultVariant(variants)?.variant_id ?? ''),
    )
  }, [hasVariants, variants])

  const selected = variants.find((variant) => variant.variant_id === variantId) ?? null
  const canBuy = available && (!hasVariants || (selected !== null && selected.in_stock !== false))

  return (
    <Stack sx={{ gap: 1.5, mt: 1 }}>
      {hasVariants && (
        <TextField
          select
          size="small"
          label={t('store.product.chooseVariant')}
          value={variantId}
          disabled={variantsPending || variants.length === 0}
          onChange={(event) => setVariantId(event.target.value)}
          sx={{ maxWidth: 320 }}
        >
          <MenuItem value="">{t('store.product.variantRequired')}</MenuItem>
          {variants.map((variant) => (
            <MenuItem
              key={variant.variant_id}
              value={variant.variant_id}
              disabled={variant.in_stock === false}
            >
              {variant.name} · {formatMoney(Number(variant.price), variant.currency, locale)}
              {variant.in_stock === false && ` · ${t('store.product.variantOutOfStock')}`}
            </MenuItem>
          ))}
        </TextField>
      )}

      {hasVariants && selected && (
        <Typography sx={{ fontSize: 20, fontWeight: 800 }}>
          {formatMoney(Number(selected.price), selected.currency, locale)}
        </Typography>
      )}

      <Stack direction="row" sx={{ gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
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
            <RemoveRoundedIcon fontSize="small" />
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
            <AddRoundedIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Button
          variant="contained"
          startIcon={<ShoppingCartRoundedIcon />}
          disabled={!canBuy}
          onClick={() => {
            add(product, quantity, selected)
            // `add_to_cart` es el ÚNICO de los tres hechos de vitrina que
            // corresponde a una decisión y no a una visita, y por eso se emite
            // aquí y no en el carrito: el carrito se reescribe entero al
            // recotizar (P07) y contar allí convertiría un refresco de precio
            // en una intención de compra.
            track(storeSlug, {
              type: 'add_to_cart',
              product_id: product.product_id,
              ...(selected ? { variant_id: selected.variant_id } : {}),
              quantity,
            })
          }}
        >
          {t('store.product.addToCart')}
        </Button>
      </Stack>
    </Stack>
  )
}
