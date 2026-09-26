import FavoriteBorderRoundedIcon from '@mui/icons-material/FavoriteBorderRounded'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded'
import ShoppingCartRoundedIcon from '@mui/icons-material/ShoppingCartRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded'
import {
  Box,
  Button,
  Card,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from '@mui/material'
import { visuallyHidden } from '@mui/utils'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { TS } from '@/theme/tokens'
import { track } from '../analytics'
import { useAddToCart } from '../cart/useAddToCart'
import type { CommercialPrice } from '../commerce/catalogPrices'
import { useStorefrontTheme } from '../theme/useStorefrontTheme'
import type { ProductCardVariant } from '../theme/types'
import { discountPercent, type PublicProduct } from '../types'
import { ProductMedia } from './ProductMedia'
import { QuantityStepper } from './QuantityStepper'

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
 * ## La jerarquía, de arriba abajo
 *
 * Cuatro niveles y ni uno más, porque la rejilla se recorre en diagonal y con
 * el rabillo del ojo: **categoría** en versalitas diminutas y gris (contexto,
 * casi un susurro), **nombre** en el cuerpo de la tarjeta, **precio** como la
 * cifra grande —es la que decide, y antes competía en tamaño con el nombre— y
 * **estado** en una pastilla suave. Lo que hace moderna a una tarjeta no es el
 * radio de la esquina, es que esos cuatro pesos se distingan sin leerlos.
 *
 * La foto va sobre su propio fondo (`--sf-media-bg`), un tono por debajo de la
 * tarjeta: separa imagen de texto sin dibujar una caja, y una foto con fondo
 * blanco —la mitad del catálogo— deja de fundirse con la tarjeta.
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
  favorite,
  onToggleFavorite,
  reduced = false,
  variant,
  commercialPrice = null,
  b2b = false,
  rank,
  purchased = false,
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
  /**
   * Estado del corazón. Se pasa desde arriba en vez de leerlo aquí: la rejilla
   * carga los favoritos UNA vez, y una tarjeta que consultara los suyos serían
   * veinticuatro consultas para pintar veinticuatro corazones.
   */
  favorite?: boolean
  /** Sin esto no se pinta el corazón: quien no ofrece guardar, no lo enseña. */
  onToggleFavorite?: (productId: string) => void
  /**
   * La misma tarjeta, REDUCIDA para una fila (antes `compact`).
   *
   * En la rejilla del catálogo la tarjeta es el sitio donde se decide comprar,
   * y por eso lleva estado y botón. En una fila de la portada es un escaparate:
   * se recorre de lado, se mira y se entra. Allí el botón de comprar y la
   * pastilla de disponibilidad convierten seis productos en media pantalla
   * cada uno, y lo que se pierde es lo único que la fila tenía que hacer —
   * enseñar QUE HAY.
   *
   * Lo que se quita es lo que se decide DENTRO de la ficha; no se quita ni el
   * precio ni el descuento, que es lo que hace que alguien entre.
   *
   * ## Por qué dejó de llamarse `compact` (Storefront V3 · P05)
   *
   * Porque conflictaba con el contrato. `productCardVariant: 'compact'` es una
   * DENSIDAD que elige el tema —la de Retail y Catalog— y este booleano es una
   * decisión de la FILA: «esta tarjeta es un anuncio, no un mostrador». Con el
   * mismo nombre, la fila que giraba forzaba `compact` y Premium acababa con
   * tarjetas de catálogo denso en su portada editorial. Son dos ejes distintos y
   * ahora se llaman distinto.
   */
  reduced?: boolean
  /**
   * La presentación que pide el TEMA. Sin ella se lee del contexto de la
   * vitrina, que es lo que hace que la rejilla, las filas y el cajón del
   * asistente coincidan sin que nadie tenga que acordarse de pasarla.
   *
   * Se acepta como prop para la vista previa del backoffice y para las pruebas,
   * que necesitan pintar las tres sin montar cuatro tiendas.
   */
  variant?: ProductCardVariant
  /**
   * El precio de ESTA sesión, si el servidor lo cotizó para la colección y
   * mejora el público (N03, `useCatalogCommercialPrices`). La tarjeta no lo
   * pide ni lo calcula: lo pinta. El carrito sigue recibiendo el producto tal
   * cual y vuelve a cotizar con el servidor.
   */
  commercialPrice?: CommercialPrice | null
  /**
   * Comprador empresa: la tarjeta pide CUÁNTOS antes de agregar.
   *
   * Quien repone 24 cajas no debería pulsar 24 veces ni ir al carrito a
   * corregir la cifra. El consumidor sigue con el botón de una unidad, que es
   * lo que espera de una tienda.
   */
  b2b?: boolean
  /** Puesto en un ranking de ventas (1 = el más vendido). Sin él, no hay insignia. */
  rank?: number
  /** Resumen v2 · Su empresa ya lo pidió en esta tienda. Solo se pinta con `b2b`. */
  purchased?: boolean
}) {
  const { t, locale } = useI18n()
  const [cantidad, setCantidad] = useState(1)
  const { agregar, pending } = useAddToCart()
  /**
   * La presentación, resuelta una vez (Storefront V3 · P05).
   *
   * Del contexto del tema, con la prop como excepción. No hay ni un
   * `if (theme === 'premium')` en este archivo: lo que hay son tres
   * presentaciones nombradas, y quien elige es el contrato.
   */
  const { style } = useStorefrontTheme()
  const presentacion = variant ?? style.productCardVariant
  const denso = presentacion === 'compact'
  const editorial = presentacion === 'editorial'
  const discount = discountPercent(product)
  const available = product.in_stock !== false
  const hasVariants = product.kind === 'variant'
  const to = `/s/${storeSlug}/product/${product.slug}`

  return (
    <Card
      className="eb-card"
      data-card-variant={presentacion}
      data-card-reduced={reduced ? 'true' : undefined}
      onMouseEnter={() => onPrefetch?.(product.slug)}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        p: denso ? 1 : editorial ? 0 : { xs: 'var(--sf-card-pad)', md: 'var(--sf-card-pad-md)' },
        gap: denso ? 0.75 : 'var(--sf-card-gap)',
        borderRadius: 'var(--sf-radius)',
        /**
         * La superficie, que es lo que distingue `editorial` de lejos (V3 · P05).
         *
         * En `comfortable` y `compact` la separación entre tarjetas la da la
         * sombra, no el borde: una línea nítida alrededor de cada una convierte
         * la rejilla en una cuadrícula.
         *
         * En `editorial` no hay ninguna de las dos. La tarjeta desaparece y lo
         * que queda es la fotografía sobre el fondo de la página, con el texto
         * debajo: es la diferencia que se ve en una captura sin inspeccionar
         * nada, y es lo que pide una tienda que vende por contemplación. El
         * relieve aparece solo al apuntar o al enfocar — ahí sí hace falta saber
         * qué tarjeta está activa.
         */
        border: editorial ? '1px solid transparent' : '1px solid var(--sf-line)',
        boxShadow: editorial ? 'none' : 'var(--sf-shadow)',
        bgcolor: editorial ? 'transparent' : undefined,
        // El movimiento es la única señal de que la tarjeta es pulsable, así
        // que se anula entero con prefers-reduced-motion en vez de acortarlo.
        transition: 'transform .18s ease, box-shadow .18s ease, border-color .18s ease',
        '&:hover': {
          borderColor: 'var(--sf-line-strong)',
          boxShadow: 'var(--sf-shadow-hover)',
          transform: 'translateY(-3px)',
        },
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
          '&:hover': { transform: 'none' },
        },
        '&:hover .eb-card-media img': { transform: 'scale(1.05)' },
        // El foco se pinta en la tarjeta aunque lo reciba el enlace de dentro:
        // si no, con el teclado se ilumina solo el nombre y no se ve qué
        // tarjeta está seleccionada.
        '&:has(a:focus-visible)': { outline: '2px solid var(--accent)', outlineOffset: 2 },
        // Resumen v2 · La tarjeta mide su propio ancho: en una rejilla estrecha
        // el botón suelta el icono antes que cortar «Agregar».
        containerType: 'inline-size',
      }}
    >
      {/* La foto flota sobre la tarjeta, sin caja propia.
          Con fondo y relleno propios, un frasco fotografiado sobre blanco
          —buena parte de cualquier catalogo— quedaba como un rectangulo
          blanco dentro de otro gris dentro de la tarjeta: tres bordes para
          ensenar un producto. */}
      <Box
        className="eb-card-media"
        sx={{
          position: 'relative',
          borderRadius: 'var(--sf-radius-sm)',
          overflow: 'hidden',
          px: 0.5,
          pt: 0.5,
          bgcolor: 'transparent',
          '& img': {
            transition: 'transform .35s ease',
            '@media (prefers-reduced-motion: reduce)': { transition: 'none', transform: 'none' },
          },
          // Agotado: la foto se apaga para que el estado se lea de un vistazo
          // en la rejilla, no solo al llegar a la línea de texto.
          ...(available ? {} : { '& img': { filter: 'grayscale(1)', opacity: 0.5 } }),
        }}
      >
        {/* La proporción Y el encaje los pone el TEMA (V3 · P02).

            La proporción ya venía de ahí: cuadrada para un envase, vertical
            para una prenda. El encaje estaba cableado en `contain`, que es lo
            correcto para un catálogo de referencias fotografiadas sobre fondo
            claro —recortar una caja de medicamento se come el principio
            activo— y lo equivocado para una tienda de moda, donde el encuadre
            completo deja franjas vacías arriba y abajo de cada prenda.

            No hay `if` por tema aquí dentro: los dos llegan como variables de
            CSS desde la frontera `.sf-scope`, con RESERVA —cuadrada y
            `contain`, las de siempre— para cuando esta tarjeta se pinta fuera
            de la vitrina. El carrito y el resumen de pago siguen con su
            miniatura cuadrada: ahí la foto identifica, no vende. */}
        <ProductMedia
          url={imageUrl}
          alt={product.primary_image_alt ?? product.name}
          fit="var(--sf-media-fit, contain)"
          ratio="var(--sf-image-ratio, 1 / 1)"
        />

        {onToggleFavorite && (
          // Por encima de la capa que hace pulsable la tarjeta (`zIndex: 1`):
          // pulsar el corazón guarda, no navega. Y es un botón de verdad, con
          // su nombre accesible cambiando según el estado: «guardar» y «quitar»
          // son dos acciones distintas y el lector de pantalla tiene que poder
          // distinguirlas sin ver el relleno del icono.
          //
          // El aviso al pasar el ratón va en `title` y no en un `Tooltip` de MUI
          // (Storefront V2 · P14): dice exactamente lo mismo que el `aria-label`
          // que el botón ya lleva —y que es lo que anuncia un lector de
          // pantalla—, pero el `Tooltip` arrastra Popper y sus transiciones al
          // PRIMER PINTADO de la vitrina: once kilobytes gzip en toda la portada
          // por un texto que el navegador sabe enseñar solo. Y en un teléfono no
          // aporta nada: no hay ratón que pasar por encima, y de ahí llega la
          // mitad de las visitas a una tienda.
          <IconButton
            size="small"
            aria-pressed={Boolean(favorite)}
            /**
             * El nombre del producto va DENTRO del nombre accesible (V3 · P14).
             *
             * Una rejilla de veinticuatro tarjetas tenía veinticuatro botones
             * llamados «Guardar en favoritos»: quien la recorre con un lector de
             * pantalla oía la misma frase veinticuatro veces sin saber de qué
             * producto. El nombre del producto es lo único que los distingue.
             *
             * En `title` se queda el texto corto: es el aviso al pasar el ratón,
             * y ahí el producto ya se está viendo.
             */
            aria-label={`${favorite ? t('store.favorite.remove') : t('store.favorite.add')}: ${product.name}`}
            title={favorite ? t('store.favorite.remove') : t('store.favorite.add')}
            onClick={() => onToggleFavorite(product.product_id)}
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 1,
              width: 30,
              height: 30,
              // Un disco limpio, sin aro: el borde dibujaba una moneda sobre
              // la foto y era lo primero que se veia de la tarjeta. La sombra
              // basta para despegarlo del fondo, y guardado se reconoce por
              // el relleno del corazon, no por el marco.
              bgcolor: 'color-mix(in srgb, var(--card) 88%, transparent)',
              backdropFilter: 'blur(6px)',
              boxShadow: '0 2px 8px -2px rgba(16, 24, 32, 0.22)',
              color: favorite ? 'var(--sf-heart)' : 'var(--muted)',
              transition: 'transform .15s ease, background-color .15s ease, color .15s ease',
              '&:hover': {
                bgcolor: 'var(--card)',
                color: 'var(--sf-heart)',
                transform: 'scale(1.08)',
              },
              '@media (prefers-reduced-motion: reduce)': {
                transition: 'none',
                '&:hover': { transform: 'none' },
              },
            }}
          >
            {favorite ? (
              <FavoriteRoundedIcon sx={{ fontSize: 18 }} />
            ) : (
              <FavoriteBorderRoundedIcon sx={{ fontSize: 18 }} />
            )}
          </IconButton>
        )}

        {/* Resumen v2 · Las pastillas de la foto, en fila: el descuento y, para
            la cuenta de empresa, «Ya comprado» (como en el diseño). */}
        <Stack
          direction="row"
          sx={{ position: 'absolute', top: 10, left: 10, right: 46, zIndex: 1, gap: 0.5, flexWrap: 'wrap' }}
        >
        {discount !== null && (
          // Pastilla plana y compacta, no un `Chip` con su alto de 24 px y su
          // sombra: sobre la foto lo que hace falta es una etiqueta que se lea,
          // no un control que parezca pulsable.
          <Box
            sx={{
              px: 1,
              py: 0.25,
              borderRadius: 'var(--sf-pill)',
              // El color de la oferta lo pone el tema con RESERVA al acento: en
              // Retail es el amarillo de oferta; en los demás, lo de siempre.
              bgcolor: 'var(--sf-discount-bg, var(--accent-deep))',
              color: 'var(--sf-discount-fg, #FFFFFF)',
              fontSize: TS.label,
              fontWeight: 800,
              letterSpacing: '0.02em',
              lineHeight: 1.6,
              boxShadow: '0 2px 8px rgba(0,0,0,.18)',
            }}
          >
            {`-${discount}%`}
          </Box>
        )}
        {b2b && purchased ? (
          <Box
            data-purchased
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.375,
              px: 1,
              py: 0.25,
              borderRadius: 'var(--sf-pill)',
              bgcolor: 'var(--text)',
              color: 'var(--card)',
              fontSize: TS.label,
              fontWeight: 800,
              lineHeight: 1.6,
              boxShadow: '0 2px 8px rgba(0,0,0,.18)',
            }}
          >
            <HistoryRoundedIcon aria-hidden sx={{ fontSize: 13 }} />
            {t('store.product.purchasedBefore')}
          </Box>
        ) : null}
        </Stack>

        {/* Resumen v2 · El puesto en el ranking de ventas, cuando la fila es un
            ranking. Es un dato (sale del agregado de pedidos), no un adorno. */}
        {rank ? (
          <Box
            data-rank={rank}
            title={t('store.ranking.position').replace('{n}', String(rank))}
            sx={{
              position: 'absolute',
              bottom: 8,
              left: 8,
              zIndex: 1,
              minWidth: 30,
              height: 30,
              px: 0.75,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '50%',
              bgcolor: rank === 1 ? 'var(--sf-discount-bg, var(--accent-deep))' : 'var(--text)',
              color: rank === 1 ? 'var(--sf-discount-fg, #FFFFFF)' : 'var(--card)',
              fontSize: 12.5,
              fontWeight: 800,
              boxShadow: '0 2px 8px rgba(0,0,0,.2)',
            }}
          >
            <Box component="span" aria-hidden>{`#${rank}`}</Box>
            <Box component="span" sx={visuallyHidden}>
              {t('store.ranking.position').replace('{n}', String(rank))}
            </Box>
          </Box>
        ) : null}
      </Box>

      <Stack sx={{ gap: 0.5, flex: 1 }}>
        {b2b && (product.brand_name || product.category_name) ? (
          <Typography
            className="eb-card-brand"
            noWrap
            sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)', lineHeight: 1.4 }}
          >
            {product.brand_name ?? product.category_name}
          </Typography>
        ) : product.category_name && (
          <Typography
            // La categoría es CONTEXTO, y cuánto contexto cabe depende del tema:
            // `compact` reparte cinco o seis columnas y ahí el nombre truncado
            // de la familia roba la línea que necesita el del producto;
            // `premium` la esconde porque su argumento es la foto, no la
            // taxonomía. Lo decide la hoja de estilos desde la frontera, no un
            // `if` aquí dentro — ver `storefront.css`.
            className="eb-card-eyebrow"
            sx={{
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--muted)',
              lineHeight: 1.4,
            }}
          >
            {product.category_name}
          </Typography>
        )}
        <Typography
          component="h3"
          sx={{
            fontSize: denso ? 13.5 : 'var(--sf-card-title)',
            fontWeight: 650,
            lineHeight: 1.35,
            letterSpacing: '-0.005em',
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
        {b2b ? (
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0 }}>
            <Typography
              data-sku={product.sku ?? ''}
              noWrap
              sx={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            >
              {product.sku ?? ''}
            </Typography>
            <Stack
              direction="row"
              data-stock={available ? 'in' : 'out'}
              sx={{ alignItems: 'center', gap: 0.5, flexShrink: 0, fontSize: 11, fontWeight: 700, color: available ? 'var(--accent-deep)' : 'var(--muted)' }}
            >
              <Box aria-hidden sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'currentColor' }} />
              {available ? t('store.availability.inStock') : t('store.availability.outOfStock')}
            </Stack>
          </Stack>
        ) : null}
      </Stack>

      <Stack sx={{ gap: 0.75, mt: 'auto' }}>
        {b2b ? (
          <Stack sx={{ gap: 0.25 }} data-b2b-price>
            {commercialPrice || (discount !== null && product.compare_at_price) ? (
              <Typography component="s" className="tnum" sx={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                {formatMoney(
                  commercialPrice ? Number(product.price) : Number(product.compare_at_price),
                  product.currency,
                  locale,
                )}
              </Typography>
            ) : null}
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 0.75, flexWrap: 'wrap' }}>
              <Typography
                className="tnum"
                sx={{ fontSize: denso ? 18 : 'var(--sf-card-price)', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.15, color: 'var(--accent-deep)' }}
              >
                {formatMoney(commercialPrice ? commercialPrice.amount : Number(product.price), product.currency, locale)}
              </Typography>
              {commercialPrice ? (
                <Stack
                  direction="row"
                  data-commercial-price={commercialPrice.label}
                  sx={{ alignItems: 'center', gap: 0.375, px: 0.875, py: 0.125, borderRadius: 'var(--sf-pill)', bgcolor: 'var(--accent-soft)', color: 'var(--accent-deep)', fontSize: 11, fontWeight: 800 }}
                >
                  <VerifiedRoundedIcon aria-hidden sx={{ fontSize: 13 }} />
                  {commercialPrice.label === 'enterprise' ? t('store.product.agreementPriceCard') : t('store.product.tradePriceCard')}
                </Stack>
              ) : null}
            </Stack>
          </Stack>
        ) : (
        <>
        <Stack direction="row" sx={{ alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap', minWidth: 0 }}>
          {/* La cifra que decide. Sube a 19 px y el nombre baja a 15: antes
              pesaban lo mismo y la tarjeta no tenía protagonista. Con precio
              comercial (N03) la cifra grande es la SUYA y el público se tacha. */}
          <Typography
            className="tnum"
            sx={{
              fontSize: denso ? 16 : 'var(--sf-card-price)',
              fontWeight: 800,
              letterSpacing: '-0.02em',
              lineHeight: 1.2,
            }}
          >
            {formatMoney(commercialPrice ? commercialPrice.amount : Number(product.price), product.currency, locale)}
          </Typography>
          {commercialPrice ? (
            <Typography
              component="s"
              className="tnum"
              sx={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600 }}
            >
              {formatMoney(Number(product.price), product.currency, locale)}
            </Typography>
          ) : (
            discount !== null &&
            product.compare_at_price && (
              <Typography
                component="s"
                className="tnum"
                sx={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600 }}
              >
                {formatMoney(Number(product.compare_at_price), product.currency, locale)}
              </Typography>
            )
          )}
        </Stack>
        {commercialPrice && (
          <Typography
            data-commercial-price={commercialPrice.label}
            sx={{ fontSize: TS.label, fontWeight: 700, color: 'var(--accent-deep)', lineHeight: 1.3, mt: -0.5 }}
          >
            {commercialPrice.label === 'enterprise' ? t('store.product.agreementPriceCard') : t('store.product.tradePriceCard')}
          </Typography>
        )}
        </>
        )}

        {/* El estado, en pastilla: en una línea de texto suelta se confunde con
            el resto de la ficha, y es lo que decide si el botón sirve. En la
            fila no se pinta: allí no hay botón al que condicionar. */}
        {reduced || b2b ? null : (
        <Box
          className="eb-card-state"
          // `in` es el estado ESPERADO de un producto publicado, y por eso hay
          // temas que no lo pintan: una pastilla verde repetida en cada tarjeta
          // de la rejilla no informa, decora. `out` se pinta SIEMPRE, en los
          // cuatro: eso sí es información, y es la que decide si el botón sirve.
          data-stock={available ? 'in' : 'out'}
          sx={{
            alignSelf: 'flex-start',
            px: 0.875,
            py: 0.125,
            borderRadius: 'var(--sf-pill)',
            fontSize: TS.label,
            fontWeight: 700,
            lineHeight: 1.7,
            bgcolor: available ? 'var(--accent-soft)' : 'var(--neutral-soft)',
            color: available ? 'var(--accent-deep)' : 'var(--muted)',
          }}
        >
          {available ? t('store.availability.inStock') : t('store.availability.outOfStock')}
        </Box>
        )}
      </Stack>

      {/* Por encima de la capa que hace pulsable la tarjeta: pulsar aquí compra,
          no navega. */}
      {reduced ? null : (
      <Stack
        direction="row"
        sx={{ position: 'relative', zIndex: 1, gap: 0.75, alignItems: 'center', mt: 0.25 }}
      >
        {/* La cantidad, solo para empresa y solo cuando se puede comprar: con
            variantes la cifra se elige en la vista rápida, junto a la opción. */}
        {b2b && available && !hasVariants ? (
          <QuantityStepper value={cantidad} onChange={setCantidad} size="sm" disabled={pending} />
        ) : null}
        <Button
          fullWidth
          variant={available ? 'contained' : 'outlined'}
          size="small"
          disabled={!available || pending}
          startIcon={
            hasVariants ? (
              <TuneRoundedIcon />
            ) : pending ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <ShoppingCartRoundedIcon />
            )
          }
          onClick={() => {
            if (hasVariants) {
              onQuickView?.(product.slug)
              return
            }
            void agregar(product, cantidad, null).then((ok) => {
              if (ok) setCantidad(1)
            })
            // Se cuenta aquí igual que en la ficha: `add_to_cart` es una decisión,
            // y si solo se contara desde la ficha, el embudo perdería a todo el
            // que compra desde la rejilla.
            track(storeSlug, {
              type: 'add_to_cart',
              product_id: product.product_id,
              quantity: cantidad,
            })
          }}
          sx={{
            position: 'relative',
            zIndex: 1,
            mt: 0.25,
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            textTransform: 'none',
            fontWeight: 700,
            borderRadius: 'var(--sf-radius-sm)',
            py: 0.75,
            boxShadow: 'none',
            '&:hover': { boxShadow: 'none' },
            '@container (max-width: 210px)': { '& .MuiButton-startIcon': { display: 'none' } },
          }}
          // Igual que el corazón: el texto visible se queda corto —la tarjeta
          // entera dice de qué producto es— y el nombre accesible lleva el
          // producto, porque un lector de pantalla anuncia el botón solo.
          aria-label={`${hasVariants ? t('store.product.chooseOptions') : t('store.product.addToCart')}: ${product.name}`}
        >
          {hasVariants
            ? t('store.product.chooseOptions')
            : b2b
              ? available
                ? t('store.product.addShort')
                : t('store.availability.outOfStock')
              : t('store.product.addToCart')}
        </Button>

      </Stack>
      )}
    </Card>
  )
}
