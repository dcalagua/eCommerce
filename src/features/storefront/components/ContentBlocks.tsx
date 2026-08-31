import { Box, Button, Card, Chip, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { isInternalPath, isSafeHref } from '@/domain/href'
import { RichText } from '@/shared/ui/RichText'
import { T } from '@/theme/tokens'
import type { ContentBlock, ContentCollectionItem } from '../content'
import { ProductMedia } from './ProductMedia'

/**
 * Pinta los bloques de una página del CMS (P11-SaaS).
 *
 * **Un componente por TIPO, no uno por tenant.** El encargo lo pide con esas
 * palabras («no dupliques componentes por tenant») y aquí es donde se cumple o
 * no: lo que cambia entre dos tiendas son los DATOS del bloque y los tokens del
 * tema, nunca el árbol de React. Si algún día hiciera falta un `if` por nombre
 * de comercio, lo que falta es un tipo de bloque.
 *
 * Todo lo que llega ya está resuelto y filtrado por el servidor: qué bloques
 * están vigentes, en qué orden y con qué productos dentro. Aquí no se decide
 * visibilidad — decidirla en dos sitios es como se acaba enseñando en la
 * vitrina algo que el editor daba por despublicado.
 */
export function ContentBlocks({
  blocks,
  storeSlug,
  assets,
  images,
  leadingHeading = false,
}: {
  blocks: readonly ContentBlock[]
  storeSlug: string
  /** Rutas de `store-assets` ya firmadas. */
  assets: Record<string, string>
  /** Rutas de `product-images` ya firmadas. */
  images: Record<string, string>
  /**
   * El primer `hero` de la lista es el ENCABEZADO de la página (P15-SaaS).
   *
   * Lo usa la portada, donde el hero del CMS sustituye al de `store_settings`:
   * sin esto la página se quedaba sin `<h1>` en cuanto el comercio publicaba
   * una portada, y el documento pasaba a empezar por un `<h2>`. Es `false` por
   * defecto porque en `/p/:slug` el `<h1>` es el título de la página y un
   * segundo `<h1>` no ordena nada, lo desordena.
   */
  leadingHeading?: boolean
}) {
  if (blocks.length === 0) return null

  const leadHeroId = leadingHeading ? blocks.find((block) => block.type === 'hero')?.id : undefined

  return (
    <Stack sx={{ gap: { xs: 2, md: 3 } }}>
      {blocks.map((block) => (
        <ContentBlockView
          key={block.id}
          block={block}
          storeSlug={storeSlug}
          assets={assets}
          images={images}
          heading={block.id === leadHeroId ? 'h1' : 'h2'}
        />
      ))}
    </Stack>
  )
}

/** Una URL externa se pinta tal cual; una ruta del bucket, ya firmada. */
function mediaUrl(value: string | null, assets: Record<string, string>): string | null {
  if (!value) return null
  if (/^https:\/\//i.test(value)) return value
  return assets[value] ?? null
}

function ContentBlockView({
  block,
  storeSlug,
  assets,
  images,
  heading,
}: {
  block: ContentBlock
  storeSlug: string
  assets: Record<string, string>
  images: Record<string, string>
  heading: 'h1' | 'h2'
}) {
  switch (block.type) {
    case 'hero':
      return <HeroBlock block={block} assets={assets} heading={heading} />
    case 'banner':
      return <BannerBlock block={block} assets={assets} />
    case 'campaign':
      return <CampaignBlock block={block} assets={assets} />
    case 'rich_text':
      return <RichTextBlock block={block} />
    case 'category_collection':
      return <CategoryCollectionBlock block={block} storeSlug={storeSlug} />
    default:
      return <ProductCollectionBlock block={block} storeSlug={storeSlug} images={images} />
  }
}

/**
 * Botón de llamada a la acción. Interno → `Link`; externo → `<a>`.
 *
 * El destino se vuelve a comprobar aquí, en el borde por el que entra al DOM
 * (P16-SaaS). `internal` NO puede ser `startsWith('/')`: `/\evil.com` empieza
 * por `/` y el navegador la resuelve a otro dominio, así que ese `if` decidía
 * «esto es interno» sobre una cadena que no lo era. `isInternalPath` es la
 * misma pregunta hecha bien.
 */
/**
 * Velo de la portada SIN foto.
 *
 * El degradado de suite es oscuro por arriba y verde medio por abajo, y encima
 * iba texto en `--text`, que en claro es casi negro: negro sobre verde es el
 * peor contraste de la pantalla y ademas se ve viejo. Ahora el texto es blanco
 * SIEMPRE, y para que eso valga con cualquier acento —el color es del tenant y
 * puede ser un amarillo palido— se tumba un velo oscuro por encima del
 * degradado antes del texto. El acento sigue mandando en el ambiente; lo que se
 * garantiza es el suelo de contraste.
 */
const HERO_SCRIM =
  'linear-gradient(180deg, rgba(6,20,16,0.25) 0%, rgba(6,20,16,0.55) 60%, rgba(6,20,16,0.72) 100%)'

function BlockCta({ block, contrast = false }: { block: ContentBlock; contrast?: boolean }) {
  if (!block.ctaHref || !block.ctaLabel || !isSafeHref(block.ctaHref)) return null

  const internal = isInternalPath(block.ctaHref)
  const sx = {
    alignSelf: 'flex-start',
    fontWeight: 700,
    textTransform: 'none' as const,
    borderRadius: 'var(--sf-pill)',
    px: 2.5,
    py: 1,
    boxShadow: 'none',
    ...(contrast
      ? {
          bgcolor: '#FFFFFF',
          color: 'var(--accent-deep)',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.9)', boxShadow: 'none' },
        }
      : { '&:hover': { boxShadow: 'none' } }),
  }

  return internal ? (
    <Button component={Link} to={block.ctaHref} variant="contained" sx={sx}>
      {block.ctaLabel}
    </Button>
  ) : (
    <Button
      component="a"
      href={block.ctaHref}
      target="_blank"
      rel="noopener noreferrer"
      variant="contained"
      sx={sx}
    >
      {block.ctaLabel}
    </Button>
  )
}

/**
 * Hero: la primera pantalla. Misma anatomía que `StoreHero` —degradado de
 * tokens cuando no hay imagen, degradado vertical cuando la hay— para que una
 * portada con CMS y una sin él no parezcan dos productos distintos.
 */
function HeroBlock({
  block,
  assets,
  heading = 'h2',
}: {
  block: ContentBlock
  assets: Record<string, string>
  heading?: 'h1' | 'h2'
}) {
  const url = mediaUrl(block.mediaUrl, assets)

  return (
    <Box
      component="section"
      aria-label={block.title ?? undefined}
      sx={{
        position: 'relative',
        borderRadius: 'var(--sf-radius)',
        overflow: 'hidden',
        background: url ? 'var(--neutral-soft)' : 'var(--hero-grad)',
        // 340 y no 400: el texto vive abajo, y con 400 la mitad superior era
        // degradado y nada mas. Aire, no vacio.
        minHeight: { xs: 260, md: 340 },
        display: 'flex',
        boxShadow: 'var(--sf-shadow)',
      }}
    >
      {url ? (
        <>
          <Box
            component="img"
            src={url}
            alt={block.mediaAlt ?? ''}
            aria-hidden={block.mediaAlt ? undefined : true}
            // El hero es lo primero que se ve: es el candidato a LCP de la
            // portada. `lazy` aquí lo RETRASA (el navegador espera al layout
            // para decidir si está en pantalla) y `fetchPriority="high"` le
            // gana el turno a las miniaturas del catálogo, que sí van
            // perezosas. Ninguna de las dos cosas cambia lo que se descarga.
            loading="eager"
            fetchPriority="high"
            decoding="async"
            sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              inset: 0,
              background:
                'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.78) 100%)',
            }}
          />
        </>
      ) : (
        <Box aria-hidden sx={{ position: 'absolute', inset: 0, background: HERO_SCRIM }} />
      )}

      <Stack
        sx={{
          position: 'relative',
          justifyContent: 'flex-end',
          gap: 1.5,
          p: { xs: 3, md: 6 },
          maxWidth: 680,
          color: '#FFFFFF',
        }}
      >
        {block.title ? (
          <Typography
            component={heading}
            sx={{
              fontSize: { xs: 30, md: 52 },
              fontWeight: 800,
              letterSpacing: '-0.03em',
              lineHeight: 1.05,
              textWrap: 'balance',
            }}
          >
            {block.title}
          </Typography>
        ) : null}
        {block.subtitle ? (
          <Typography
            sx={{
              fontSize: { xs: T.bodyStrong, md: 17 },
              lineHeight: 1.55,
              maxWidth: 560,
              opacity: 0.92,
            }}
          >
            {block.subtitle}
          </Typography>
        ) : null}
        {/* Contraste SIEMPRE, no solo con foto: desde que el texto es blanco,
            la portada sin imagen tambien es una superficie oscura, y el boton
            de acento sobre el degradado del acento era verde sobre verde. */}
        <BlockCta block={block} contrast />
      </Stack>
    </Box>
  )
}

/** Banner: más bajo que el hero y con la imagen al lado, no detrás. */
function BannerBlock({ block, assets }: { block: ContentBlock; assets: Record<string, string> }) {
  const url = mediaUrl(block.mediaUrl, assets)
  const reverse = block.settings.reverse === true

  return (
    <Card
      component="section"
      aria-label={block.title ?? undefined}
      sx={{ p: 0, overflow: 'hidden' }}
    >
      <Stack
        direction={{ xs: 'column', md: reverse ? 'row-reverse' : 'row' }}
        sx={{ alignItems: 'stretch' }}
      >
        {url ? (
          <Box
            component="img"
            src={url}
            alt={block.mediaAlt ?? ''}
            aria-hidden={block.mediaAlt ? undefined : true}
            loading="lazy"
            decoding="async"
            // `aspectRatio` (P15-SaaS): sin él el hueco de la imagen valía cero
            // hasta que la imagen llegaba, y el texto del banner —que en móvil
            // va DEBAJO— caía de golpe media pantalla. Con la proporción
            // declarada el navegador reserva el sitio antes de descargarla.
            sx={{
              width: { xs: '100%', md: '40%' },
              aspectRatio: { xs: '16 / 9', md: 'auto' },
              maxHeight: 260,
              objectFit: 'cover',
            }}
          />
        ) : null}
        <Stack sx={{ gap: 1, p: { xs: 2.5, md: 3.5 }, justifyContent: 'center', flex: 1 }}>
          {block.title ? (
            <Typography component="h2" sx={{ fontSize: T.pageTitle, fontWeight: 800 }}>
              {block.title}
            </Typography>
          ) : null}
          {block.subtitle ? (
            <Typography sx={{ fontSize: T.body, color: 'var(--muted)', lineHeight: 1.6 }}>
              {block.subtitle}
            </Typography>
          ) : null}
          <RichText doc={block.body} />
          <BlockCta block={block} />
        </Stack>
      </Stack>
    </Card>
  )
}

/**
 * Bloque de campaña.
 *
 * `campaignLive` viene del servidor y dice si la promoción a la que apunta está
 * descontando AHORA. Lo que NO viene —ni puede venir— es el código del cupón:
 * enumerar los códigos activos de una tienda a un comprador anónimo sería
 * regalar el folleto de las campañas secretas (misma decisión que P10 tomó al
 * no reportar las campañas que exigen cupón y no lo traen).
 */
function CampaignBlock({ block, assets }: { block: ContentBlock; assets: Record<string, string> }) {
  const { t, locale } = useI18n()
  const url = mediaUrl(block.mediaUrl, assets)

  return (
    <Card component="section" aria-label={block.title ?? undefined} sx={{ p: 0, overflow: 'hidden' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ alignItems: 'stretch' }}>
        {url ? (
          <Box
            component="img"
            src={url}
            alt={block.mediaAlt ?? ''}
            aria-hidden={block.mediaAlt ? undefined : true}
            loading="lazy"
            decoding="async"
            // Proporción declarada: en móvil la imagen va encima del texto y
            // sin ella el bloque entero salta cuando la foto llega.
            sx={{
              width: { xs: '100%', sm: 200 },
              aspectRatio: { xs: '16 / 9', sm: 'auto' },
              maxHeight: 200,
              objectFit: 'cover',
            }}
          />
        ) : null}
        <Stack sx={{ gap: 1, p: { xs: 2.5, md: 3 }, flex: 1, justifyContent: 'center' }}>
          <Stack direction="row" sx={{ gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800 }}>
              {block.title}
            </Typography>
            {block.campaignLive ? (
              <Chip size="small" color="primary" label={t('store.content.campaignLive')} />
            ) : null}
          </Stack>
          {block.subtitle ? (
            <Typography sx={{ fontSize: T.body, color: 'var(--muted)' }}>{block.subtitle}</Typography>
          ) : null}
          {block.campaignLive && block.campaignEndsAt ? (
            <Typography sx={{ fontSize: T.label, fontWeight: 700, color: 'var(--accent-deep)' }}>
              {`${t('store.content.campaignEnds')} ${new Date(block.campaignEndsAt).toLocaleDateString(
                locale === 'en' ? 'en-US' : 'es-PE',
                { day: '2-digit', month: 'short', year: 'numeric' },
              )}`}
            </Typography>
          ) : null}
          <BlockCta block={block} />
        </Stack>
      </Stack>
    </Card>
  )
}

function RichTextBlock({ block }: { block: ContentBlock }) {
  return (
    <Card component="section" aria-label={block.title ?? undefined} sx={{ p: { xs: 2.5, md: 3.5 } }}>
      <Stack sx={{ gap: 1.5 }}>
        {block.title ? (
          <Typography component="h2" sx={{ fontSize: T.pageTitle, fontWeight: 800 }}>
            {block.title}
          </Typography>
        ) : null}
        <RichText doc={block.body} />
        <BlockCta block={block} />
      </Stack>
    </Card>
  )
}

function CategoryCollectionBlock({
  block,
  storeSlug,
}: {
  block: ContentBlock
  storeSlug: string
}) {
  const categories = block.items.filter(
    (item): item is Extract<ContentCollectionItem, { kind: 'category' }> => item.kind === 'category',
  )
  if (categories.length === 0) return null

  return (
    <Stack component="section" aria-label={block.title ?? undefined} sx={{ gap: 1.5 }}>
      <BlockHeading block={block} />
      <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
        {categories.map((category) => (
          <Chip
            key={category.category_id}
            component={Link}
            clickable
            to={`/s/${storeSlug}?c=${encodeURIComponent(category.slug)}`}
            label={category.name}
            sx={{ fontWeight: 700 }}
          />
        ))}
      </Stack>
    </Stack>
  )
}

function ProductCollectionBlock({
  block,
  storeSlug,
  images,
}: {
  block: ContentBlock
  storeSlug: string
  images: Record<string, string>
}) {
  const items = block.items.filter(
    (item): item is Exclude<ContentCollectionItem, { kind: 'category' }> => item.kind !== 'category',
  )
  if (items.length === 0) return null

  const columns = typeof block.settings.columns === 'number' ? block.settings.columns : 4
  const showPrice = block.settings.show_price !== false
  // `carousel` es el mismo contenido con desplazamiento horizontal en vez de
  // rejilla. No es otro componente: es otra caja.
  const scroll = block.type === 'carousel'

  return (
    <Stack component="section" aria-label={block.title ?? undefined} sx={{ gap: 1.5 }}>
      <BlockHeading block={block} />
      <Box
        sx={
          scroll
            ? {
                display: 'grid',
                gridAutoFlow: 'column',
                gridAutoColumns: { xs: '62%', sm: '38%', md: '22%' },
                gap: 1.5,
                overflowX: 'auto',
                pb: 1,
                scrollSnapType: 'x mandatory',
              }
            : {
                display: 'grid',
                gap: 1.5,
                gridTemplateColumns: {
                  xs: 'repeat(2, minmax(0, 1fr))',
                  md: `repeat(${Math.min(Math.max(columns, 2), 6)}, minmax(0, 1fr))`,
                },
              }
        }
      >
        {items.map((item) => (
          <CollectionCard
            key={'variant_id' in item ? item.variant_id : item.product_id}
            item={item}
            storeSlug={storeSlug}
            images={images}
            showPrice={showPrice}
            snap={scroll}
          />
        ))}
      </Box>
    </Stack>
  )
}

function BlockHeading({ block }: { block: ContentBlock }) {
  if (!block.title && !block.subtitle) return null
  return (
    <Stack sx={{ gap: 0.25 }}>
      {block.title ? (
        <Typography
          component="h2"
          sx={{ fontSize: { xs: 20, md: 24 }, fontWeight: 800, letterSpacing: '-0.02em' }}
        >
          {block.title}
        </Typography>
      ) : null}
      {block.subtitle ? (
        <Typography sx={{ fontSize: T.bodyStrong, color: 'var(--muted)' }}>
          {block.subtitle}
        </Typography>
      ) : null}
    </Stack>
  )
}

function CollectionCard({
  item,
  storeSlug,
  images,
  showPrice,
  snap,
}: {
  item: Exclude<ContentCollectionItem, { kind: 'category' }>
  storeSlug: string
  images: Record<string, string>
  showPrice: boolean
  snap: boolean
}) {
  const { t, locale } = useI18n()
  const price = item.kind === 'product' ? (item.price_from ?? item.price) : item.price

  return (
    <Card
      component={Link}
      to={`/s/${storeSlug}/product/${item.slug}`}
      sx={{
        p: 1.5,
        display: 'grid',
        gap: 0.5,
        alignContent: 'start',
        textDecoration: 'none',
        color: 'inherit',
        borderRadius: 'var(--sf-radius)',
        border: '1px solid var(--sf-line)',
        boxShadow: 'var(--sf-shadow)',
        scrollSnapAlign: snap ? 'start' : undefined,
        transition: 'box-shadow .18s ease, transform .18s ease',
        '&:hover': { boxShadow: 'var(--sf-shadow-hover)', transform: 'translateY(-3px)' },
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
          '&:hover': { transform: 'none' },
        },
        '& .sf-collection-media': {
          borderRadius: 'var(--sf-radius-sm)',
          overflow: 'hidden',
          bgcolor: 'var(--sf-media-bg)',
          mb: 0.75,
        },
      }}
    >
      <Box className="sf-collection-media">
      <ProductMedia
        url={item.image_path ? (images[item.image_path] ?? null) : null}
        alt={item.image_alt ?? item.name}
      />
      </Box>
      <Typography sx={{ fontSize: 15, fontWeight: 650, lineHeight: 1.35 }}>{item.name}</Typography>
      {item.kind === 'variant' && item.variant_label ? (
        <Typography sx={{ fontSize: T.label, color: 'var(--muted)' }}>
          {item.variant_label}
        </Typography>
      ) : null}
      {showPrice && price && item.currency ? (
        <Typography
          className="tnum"
          sx={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em', mt: 0.25 }}
        >
          {formatMoney(Number(price), item.currency, locale)}
        </Typography>
      ) : null}
      {item.in_stock === false ? (
        <Typography sx={{ fontSize: T.micro, fontWeight: 700, color: 'var(--muted)' }}>
          {t('store.availability.outOfStock')}
        </Typography>
      ) : null}
    </Card>
  )
}
