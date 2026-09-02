import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded'
import OpenInFullRoundedIcon from '@mui/icons-material/OpenInFullRounded'
import SellRoundedIcon from '@mui/icons-material/SellRounded'
import ShoppingCartRoundedIcon from '@mui/icons-material/ShoppingCartRounded'
import {
  Box,
  Button,
  Card,
  Chip,
  Dialog,
  DialogContent,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { AppBreadcrumbs } from '@/shared/ui/AppBreadcrumbs'
import { ErrorState } from '@/shared/ui/states'
import { R, TS } from '@/theme/tokens'
import { track } from '../analytics'
import { useCart } from '../cart/cart-context'
import { useGallery, usePublicProduct } from '../hooks'
import { discountPercent } from '../types'
import { ProductGallery } from './ProductGallery'
import { QuantityStepper } from './QuantityStepper'

/**
 * Vista rápida del producto, en un diálogo sobre el catálogo.
 *
 * **La ficha completa no desaparece: sigue en su URL.** Este diálogo resuelve
 * el caso frecuente —mirar la foto grande, el precio y la descripción sin
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
 *
 * Ancho `md` y no `lg`: a lo ancho de 1200 px la mitad derecha se quedaba en
 * blanco. El diálogo se dimensiona por lo que hay dentro, no por lo que cabe en
 * la pantalla.
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
  const [quantity, setQuantity] = useState(1)

  const product = usePublicProduct(storeId, slug ?? undefined)
  const gallery = useGallery(product.data?.product_id ?? null)

  // La cantidad vuelve a uno al cambiar de producto. Heredar la del anterior
  // es el camino corto a comprar seis de algo que se miraba de pasada.
  useEffect(() => setQuantity(1), [slug])

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
      slotProps={{
        paper: { sx: { borderRadius: 'var(--sf-radius)', bgcolor: 'var(--bg)', backgroundImage: 'none' } },
      }}
    >
      {/* Migas a la izquierda y cerrar a la derecha: dónde estás y por dónde
          sales, en la misma línea y sin competir con el nombre del producto. */}
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: 2.5,
          py: 1.5,
          bgcolor: 'var(--card)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <AppBreadcrumbs
          ariaLabel={t('store.product.breadcrumb')}
          items={[
            { label: t('store.catalog.title'), to: `/s/${storeSlug}` },
            ...(item?.category_name ? [{ label: item.category_name }] : []),
            ...(item ? [{ label: item.name }] : []),
          ]}
        />
        <Button
          onClick={onClose}
          endIcon={<CloseRoundedIcon />}
          sx={{
            textTransform: 'none',
            fontWeight: 700,
            color: 'var(--muted)',
            border: '1px solid var(--border)',
            borderRadius: `${R.md}px`,
            flexShrink: 0,
          }}
        >
          {t('store.product.close')}
        </Button>
      </Stack>

      <DialogContent sx={{ p: { xs: 1.5, md: 2.5 } }}>
        {product.isError && (
          <Card sx={{ p: 2 }}>
            <ErrorState error={product.error} onRetry={() => void product.refetch()} />
          </Card>
        )}

        {/* El esqueleto tiene la MISMA forma que el contenido real: si no, el
            diálogo cambia de tamaño al llegar los datos, y uno centrado se
            mueve entero. El PRECIO no se dibuja a propósito: es la única cifra
            de la ficha, y un rectángulo gris con su forma y su sitio se lee
            como un precio que aún no se sabe, o peor, como uno tachado. */}
        {product.isPending && slug !== null && (
          <Stack aria-hidden direction={{ xs: 'column', md: 'row' }} sx={{ gap: 2 }}>
            <Card
              sx={{
                p: 2,
                width: { md: 400 },
                flexShrink: 0,
                borderRadius: 'var(--sf-radius)',
                border: '1px solid var(--sf-line)',
                boxShadow: 'var(--sf-shadow)',
              }}
            >
              <Skeleton
                variant="rectangular"
                sx={{ width: '100%', aspectRatio: '4 / 3', borderRadius: `${R.md}px` }}
              />
            </Card>
            <Card sx={{ p: 2.5, flex: 1 }}>
              <Stack sx={{ gap: 1.25 }}>
                <Skeleton width="80%" height={30} />
                <Skeleton width="35%" height={16} />
                <Skeleton width="25%" height={18} sx={{ mt: 1 }} />
                <Stack direction="row" sx={{ gap: 1, mt: 1 }}>
                  <Skeleton variant="rounded" width={120} height={40} />
                  <Skeleton variant="rounded" width={190} height={40} />
                </Stack>
                <Skeleton variant="rounded" height={120} sx={{ mt: 2 }} />
              </Stack>
            </Card>
          </Stack>
        )}

        {item && (
          /* `flex-start` y no `stretch`: la tarjeta de la galería se estiraba
             hasta la altura de la columna derecha y dejaba un palmo de blanco
             bajo la foto, porque la foto tiene su proporción y no crece. */
          <Stack direction={{ xs: 'column', md: 'row' }} sx={{ gap: 2, alignItems: 'flex-start' }}>
            {/* Galería en su propia tarjeta, con las miniaturas dentro.
                400 px y no 300: a 300 la foto de la vista rápida se quedaba en
                una estampilla en la que no se distingue el acabado, que es
                justo lo que se mira antes de comprar. Lo que se pierde a la
                derecha es aire, no contenido. */}
            <Card
              sx={{
                p: 2,
                width: { md: 400 },
                flexShrink: 0,
                borderRadius: 'var(--sf-radius)',
                border: '1px solid var(--sf-line)',
                boxShadow: 'var(--sf-shadow)',
              }}
            >
              <ProductGallery images={gallery.data ?? []} alt={item.name} />
            </Card>

            <Stack sx={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Card
                sx={{
                  p: { xs: 2, md: 2.5 },
                  borderRadius: 'var(--sf-radius)',
                  border: '1px solid var(--sf-line)',
                  boxShadow: 'var(--sf-shadow)',
                }}
              >
                <Stack sx={{ gap: 1 }}>
                  {discount !== null && (
                    <Chip
                      size="small"
                      label={`-${discount}%`}
                      sx={{
                        alignSelf: 'flex-start',
                        bgcolor: 'var(--accent)',
                        color: '#FFFFFF',
                        fontWeight: 800,
                      }}
                    />
                  )}

                  <Typography
                    component="h2"
                    sx={{ fontSize: { xs: 20, md: 24 }, fontWeight: 800, lineHeight: 1.25 }}
                  >
                    {item.name}
                  </Typography>

                  {/* Marca y categoría en una línea tenue bajo el título: son
                      contexto, no titular. */}
                  <Typography sx={{ fontSize: TS.body, color: 'var(--muted)' }}>
                    {[item.brand_name, item.category_name].filter(Boolean).join(' / ') || '—'}
                  </Typography>

                  <Stack sx={{ gap: 0, mt: 0.5 }}>
                    {discount !== null && item.compare_at_price && (
                      <Typography
                        component="s"
                        sx={{ fontSize: TS.body, color: 'var(--muted)', fontWeight: 600 }}
                      >
                        {formatMoney(Number(item.compare_at_price), item.currency, locale)}
                      </Typography>
                    )}
                    <Typography sx={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em' }}>
                      {formatMoney(Number(item.price), item.currency, locale)}
                    </Typography>
                  </Stack>

                  <Chip
                    size="small"
                    label={
                      available
                        ? t('store.availability.inStock')
                        : t('store.availability.outOfStock')
                    }
                    sx={{
                      alignSelf: 'flex-start',
                      fontWeight: 800,
                      fontSize: TS.label,
                      bgcolor: available ? 'var(--accent-soft)' : 'var(--neutral-soft)',
                      color: available ? 'var(--accent-deep)' : 'var(--muted)',
                    }}
                  />

                  {/* Cantidad y compra, juntos y en una sola fila. Es UNA
                      decisión, así que se anuncian como un grupo. */}
                  <Stack
                    role="group"
                    aria-label={t('store.product.buyGroup')}
                    direction="row"
                    sx={{ gap: 1, mt: 1.5, flexWrap: 'wrap', alignItems: 'center' }}
                  >
                    {!hasVariants && (
                      <>
                        <QuantityStepper
                          value={quantity}
                          onChange={setQuantity}
                          disabled={!available}
                        />
                        <Button
                          variant="contained"
                          startIcon={<ShoppingCartRoundedIcon />}
                          disabled={!available}
                          onClick={() => {
                            add(item, quantity, null)
                            track(storeSlug, {
                              type: 'add_to_cart',
                              product_id: item.product_id,
                              quantity,
                            })
                            onClose()
                          }}
                          sx={{ textTransform: 'none', fontWeight: 700 }}
                        >
                          {t('store.product.addToCart')}
                        </Button>
                      </>
                    )}
                    <Button
                      component={Link}
                      to={`/s/${storeSlug}/product/${item.slug}`}
                      variant={hasVariants ? 'contained' : 'outlined'}
                      endIcon={<OpenInFullRoundedIcon />}
                      sx={{ textTransform: 'none', fontWeight: 700 }}
                    >
                      {hasVariants ? t('store.product.chooseOptions') : t('store.product.detail')}
                    </Button>
                  </Stack>
                </Stack>
              </Card>

              {/* Descripción a la izquierda y datos a la derecha, en un panel
                  aparte: lo que se lee cuando ya casi se ha decidido. */}
              <Card sx={{ p: { xs: 2, md: 2.5 }, bgcolor: 'var(--neutral-soft)' }}>
                <Box
                  sx={{
                    display: 'grid',
                    gap: { xs: 2, md: 3 },
                    gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) max-content' },
                  }}
                >
                  <Box>
                    <Typography
                      component="h3"
                      sx={{ fontSize: TS.cardTitle, fontWeight: 800, mb: 0.75 }}
                    >
                      {t('store.product.description')}
                    </Typography>
                    {/* Tope de medida: pasada de ~65 caracteres, la linea
                        obliga a buscar el principio de la siguiente con la
                        vista, y eso cansa antes de la tercera. */}
                    <Typography
                      sx={{
                        fontSize: TS.body,
                        color: 'var(--muted)',
                        lineHeight: 1.6,
                        whiteSpace: 'pre-line',
                        maxWidth: '62ch',
                      }}
                    >
                      {item.description?.trim() || t('store.product.noDescription')}
                    </Typography>
                  </Box>

                  <Stack sx={{ gap: 1.25 }}>
                    <FactRow icon={<SellRoundedIcon />} value={item.brand_name} />
                    <FactRow icon={<CategoryRoundedIcon />} value={item.category_name} />
                    <FactRow
                      icon={<Inventory2RoundedIcon />}
                      value={
                        available
                          ? t('store.availability.inStock')
                          : t('store.availability.outOfStock')
                      }
                    />
                  </Stack>
                </Box>
              </Card>
            </Stack>
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Un dato con su icono.
 *
 * Lo que no se sabe se dice —«Sin información disponible»— en vez de esconder
 * la fila: una lista a la que le faltan filas según el producto no se puede
 * recorrer con la vista, porque cada producto la tiene en otro sitio. El icono
 * va `aria-hidden`: el texto ya lo dice todo y anunciarlo sería leerlo dos veces.
 */
function FactRow({ icon, value }: { icon: ReactNode; value: string | null }) {
  const { t } = useI18n()

  return (
    <Stack direction="row" sx={{ gap: 1, alignItems: 'flex-start' }}>
      <Box
        aria-hidden
        sx={{
          color: 'var(--muted)',
          display: 'flex',
          mt: '1px',
          '& .MuiSvgIcon-root': { fontSize: 18 },
        }}
      >
        {icon}
      </Box>
      <Typography
        sx={{
          fontSize: TS.body,
          color: value ? 'var(--text)' : 'var(--muted)',
          fontWeight: value ? 600 : 400,
        }}
      >
        {value ?? t('store.product.noData')}
      </Typography>
    </Stack>
  )
}
