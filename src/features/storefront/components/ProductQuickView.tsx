import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import OpenInFullRoundedIcon from '@mui/icons-material/OpenInFullRounded'
import ShoppingCartRoundedIcon from '@mui/icons-material/ShoppingCartRounded'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  Divider,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { ErrorState } from '@/shared/ui/states'
import { R, T } from '@/theme/tokens'
import { useCart } from '../cart/cart-context'
import { useGallery, usePublicProduct } from '../hooks'
import { discountPercent } from '../types'
import { ProductGallery } from './ProductGallery'

/**
 * Vista rápida del producto, en un diálogo sobre el catálogo.
 *
 * **La ficha completa no desaparece: sigue en su URL.** Este diálogo resuelve
 * el caso frecuente —mirar una foto grande, el precio y la descripción sin
 * perder el sitio en la rejilla— y el caso completo se atiende donde siempre.
 * Que la tarjeta siga siendo un enlace de verdad a esa URL es lo que mantiene
 * el clic con rueda, el «abrir en pestaña nueva» y lo que indexa un buscador.
 *
 * Se abre con `?p=<slug>` en la URL y no con un estado del componente: así el
 * botón de atrás lo CIERRA, que es lo que todo el mundo intenta, y el enlace se
 * puede pegar en un chat.
 *
 * **Comprar variantes NO se hace aquí.** Elegir color o medida es una decisión
 * con consecuencias sobre el precio y el stock, y un diálogo que se cierra al
 * pulsar fuera es mal sitio para tomarla: esos productos llevan al detalle.
 */
export function ProductQuickView({
  storeId,
  storeSlug,
  slug,
  onClose,
}: {
  storeId: string
  storeSlug: string
  /** `null` = cerrado. Sale del parámetro `p` de la URL. */
  slug: string | null
  onClose: () => void
}) {
  const { t, locale } = useI18n()
  const { add } = useCart()

  const product = usePublicProduct(storeId, slug ?? undefined)
  const gallery = useGallery(product.data?.product_id ?? null)

  const item = product.data
  const available = item?.in_stock !== false
  const discount = item ? discountPercent(item) : null
  const hasVariants = item?.kind === 'variant'

  return (
    <Dialog
      open={slug !== null}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      aria-label={item?.name ?? t('store.product.quickView')}
      slotProps={{ paper: { sx: { borderRadius: `${R.lg}px` } } }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: 2.5,
          py: 1.5,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <Typography sx={{ fontSize: T.label, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {item?.category_name ?? t('store.product.quickView')}
        </Typography>
        <Button
          onClick={onClose}
          endIcon={<CloseRoundedIcon />}
          sx={{ textTransform: 'none', fontWeight: 700, color: 'var(--muted)' }}
        >
          {t('store.product.close')}
        </Button>
      </Stack>

      <DialogContent sx={{ p: 2.5 }}>
        {product.isError && (
          <ErrorState error={product.error} onRetry={() => void product.refetch()} />
        )}

        {/* El esqueleto tiene la MISMA forma que el contenido real: foto a la
            izquierda con su proporción, y a la derecha marca, nombre,
            disponibilidad, descripción y botones. Un rectángulo genérico haría
            que el diálogo cambiara de tamaño al llegar los datos, y un diálogo
            que crece se mueve entero porque está centrado en la pantalla.

            El PRECIO no se dibuja a propósito: es la única cifra de la ficha, y
            un rectángulo gris con su forma y su sitio se lee como un precio que
            aún no se sabe —o peor, como uno tachado—. Prefiere el hueco. */}
        {product.isPending && slug !== null && (
          <Stack aria-hidden direction={{ xs: 'column', sm: 'row' }} sx={{ gap: 3 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Skeleton
                variant="rectangular"
                sx={{ width: '100%', aspectRatio: '4 / 3', borderRadius: `${R.md}px` }}
              />
            </Box>
            <Stack sx={{ flex: 1, minWidth: 0, gap: 1.25 }}>
              <Skeleton width="35%" height={14} />
              <Skeleton width="85%" height={34} />
              <Skeleton width="25%" height={18} />
              <Skeleton width="100%" height={14} sx={{ mt: 1 }} />
              <Skeleton width="95%" height={14} />
              <Skeleton width="70%" height={14} />
              <Stack direction="row" sx={{ gap: 1, mt: 1 }}>
                <Skeleton variant="rounded" width={170} height={40} />
                <Skeleton variant="rounded" width={150} height={40} />
              </Stack>
            </Stack>
          </Stack>
        )}

        {item && (
          <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ gap: 3 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <ProductGallery images={gallery.data ?? []} alt={item.name} />
            </Box>

            <Stack sx={{ flex: 1, minWidth: 0, gap: 1.25 }}>
              {item.brand_name && (
                <Typography sx={{ fontSize: T.label, fontWeight: 800, color: 'var(--muted)' }}>
                  {item.brand_name}
                </Typography>
              )}

              <Typography component="h2" sx={{ fontSize: T.pageTitle, fontWeight: 800, lineHeight: 1.25 }}>
                {item.name}
              </Typography>

              <Stack direction="row" sx={{ gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <Typography sx={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em' }}>
                  {formatMoney(Number(item.price), item.currency, locale)}
                </Typography>
                {discount !== null && item.compare_at_price && (
                  <>
                    <Typography component="s" sx={{ fontSize: T.body, color: 'var(--muted)', fontWeight: 600 }}>
                      {formatMoney(Number(item.compare_at_price), item.currency, locale)}
                    </Typography>
                    <Chip
                      size="small"
                      label={`-${discount}%`}
                      sx={{ bgcolor: 'var(--accent)', color: '#FFFFFF', fontWeight: 800 }}
                    />
                  </>
                )}
              </Stack>

              <Typography
                sx={{
                  fontSize: T.body,
                  fontWeight: 700,
                  color: available ? 'var(--accent-deep)' : 'var(--muted)',
                }}
              >
                {available ? t('store.availability.inStock') : t('store.availability.outOfStock')}
              </Typography>

              {item.description && (
                <>
                  <Divider sx={{ my: 0.5 }} />
                  <Typography sx={{ fontSize: T.body, color: 'var(--muted)', lineHeight: 1.6 }}>
                    {item.description}
                  </Typography>
                </>
              )}

              <Stack direction="row" sx={{ gap: 1, mt: 'auto', pt: 1, flexWrap: 'wrap' }}>
                {/* Con variantes no se compra desde aqui: hay que elegir una. */}
                {!hasVariants && (
                  <Button
                    variant="contained"
                    startIcon={<ShoppingCartRoundedIcon />}
                    disabled={!available}
                    onClick={() => {
                      add(item, 1, null)
                      onClose()
                    }}
                  >
                    {t('store.product.addToCart')}
                  </Button>
                )}
                <Button
                  component={Link}
                  to={`/s/${storeSlug}/product/${item.slug}`}
                  variant={hasVariants ? 'contained' : 'outlined'}
                  endIcon={<OpenInFullRoundedIcon />}
                >
                  {t('store.product.detail')}
                </Button>
              </Stack>
            </Stack>
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  )
}
