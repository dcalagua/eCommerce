import ShoppingCartRoundedIcon from '@mui/icons-material/ShoppingCartRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import { Box, Button, Card, Chip, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { R, T } from '@/theme/tokens'
import { track } from '../analytics'
import { useCart } from '../cart/cart-context'
import { discountPercent, type PublicProduct } from '../types'
import { ProductMedia } from './ProductMedia'

/**
 * Tarjeta de catálogo: foto, categoría, nombre, precio, disponibilidad y compra.
 *
 * ## Por qué la tarjeta ya NO es un enlace entera
 *
 * Lo era, y con razón: un solo `<a>` se alcanza con Tab, se anuncia como enlace
 * y se abre en otra pestaña. Pero ahora lleva un botón de comprar, y un
 * `<button>` dentro de un `<a>` es HTML inválido: el navegador no sabe cuál de
 * los dos activar con Enter y un lector de pantalla anuncia un enlace que
 * contiene un botón, que no es nada.
 *
 * La solución es la de siempre para este caso: el enlace lo lleva el NOMBRE
 * —que es lo que de verdad nombra el destino, mucho mejor que «la tarjeta»— y
 * se estira sobre toda la tarjeta con un pseudo-elemento. Se conserva todo lo
 * que había: un clic en cualquier parte abre el producto, Tab llega, el lector
 * de pantalla anuncia «Silla de roble, enlace», y ctrl-clic o rueda abren la
 * ficha en otra pestaña. El botón se pone por encima de esa capa, así que
 * pulsarlo compra y no navega, sin necesidad de `stopPropagation`.
 *
 * ## Qué hace el botón
 *
 * Con variantes NO añade nada: elegir color o medida cambia precio y stock, y
 * meter «la primera» en el carrito es mandarle a alguien la talla que no era.
 * En ese caso lleva a elegir.
 */
export function ProductCard({
  product,
  storeSlug,
  imageUrl = null,
  onPrefetch,
  onQuickView,
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
  /**
   * Vista rápida. Si se pasa, el clic normal abre el diálogo en vez de navegar;
   * el `href` NO se quita, así que ctrl-clic, rueda y «abrir en pestaña nueva»
   * siguen llevando a la ficha, y un buscador la indexa. Sin JavaScript la
   * tarjeta es un enlace y ya está.
   */
  onQuickView?: (slug: string) => void
}) {
  const { t, locale } = useI18n()
  const { add } = useCart()
  const discount = discountPercent(product)
  const available = product.in_stock !== false
  const hasVariants = product.kind === 'variant'
  const to = `/s/${storeSlug}/product/${product.slug}`

  return (
    <Card
      onMouseEnter={() => onPrefetch?.(product.slug)}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        p: 1.25,
        gap: 1,
        borderRadius: `${R.lg}px`,
        // El movimiento es la única señal de que la tarjeta es pulsable, así
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
        // El foco se pinta en la tarjeta aunque lo reciba el enlace de dentro:
        // si no, con el teclado se ilumina solo el nombre y no se ve qué
        // tarjeta está seleccionada.
        '&:has(a:focus-visible)': { outline: '2px solid var(--accent)', outlineOffset: 2 },
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
          // en la rejilla, no solo al llegar a la línea de texto.
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
          <Box
            component={Link}
            to={to}
            onFocus={() => onPrefetch?.(product.slug)}
            onClick={(event: React.MouseEvent) => {
              if (!onQuickView) return
              // Se respetan los gestos de «abrir en otra parte»: si el visitante
              // pidió otra pestaña, abrirle un diálogo aquí sería ignorarlo.
              if (event.defaultPrevented) return
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              if (event.button !== 0) return
              event.preventDefault()
              onQuickView(product.slug)
            }}
            sx={{
              color: 'inherit',
              textDecoration: 'none',
              // La capa que hace pulsable la tarjeta entera. Va detrás de todo
              // (`zIndex: 0`) para que el botón de comprar quede por encima.
              '&::after': { content: '""', position: 'absolute', inset: 0, zIndex: 0 },
              '&:focus-visible': { outline: 'none' },
            }}
          >
            {product.name}
          </Box>
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

      {/* Por encima de la capa que hace pulsable la tarjeta: pulsar aquí compra,
          no navega. */}
      <Button
        fullWidth
        variant={available ? 'contained' : 'outlined'}
        size="small"
        disabled={!available}
        startIcon={hasVariants ? <TuneRoundedIcon /> : <ShoppingCartRoundedIcon />}
        onClick={() => {
          if (hasVariants) {
            onQuickView?.(product.slug)
            return
          }
          add(product, 1, null)
          // Se cuenta aquí igual que en la ficha: `add_to_cart` es una decisión,
          // y si solo se contara desde la ficha, el embudo perdería a todo el
          // que compra desde la rejilla.
          track(storeSlug, {
            type: 'add_to_cart',
            product_id: product.product_id,
            quantity: 1,
          })
        }}
        sx={{ position: 'relative', zIndex: 1, mt: 0.5, textTransform: 'none', fontWeight: 700 }}
      >
        {hasVariants ? t('store.product.chooseOptions') : t('store.product.addToCart')}
      </Button>
    </Card>
  )
}
