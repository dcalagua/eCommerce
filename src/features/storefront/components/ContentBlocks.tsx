import LocalOfferRoundedIcon from '@mui/icons-material/LocalOfferRounded'
import { Box, Button, Card, Chip, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { Locale, MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { isInternalPath, isSafeHref } from '@/domain/href'
import { RichText } from '@/shared/ui/RichText'
import { T } from '@/theme/tokens'
import type { CampaignOffer, ContentBlock, ContentCollectionItem } from '../content'
import { ProductMedia } from './ProductMedia'
import { ScrollRow } from './ScrollRow'

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
  currency,
  leadingHeading = false,
}: {
  blocks: readonly ContentBlock[]
  storeSlug: string
  /** Rutas de `store-assets` ya firmadas. */
  assets: Record<string, string>
  /** Rutas de `product-images` ya firmadas. */
  images: Record<string, string>
  /** Moneda de la tienda: sin ella, «20 de descuento» no dice de que. */
  currency?: string
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
      {groupCampaigns(blocks).map((group) =>
        group.length > 1 ? (
          <CampaignWall key={group[0].id} blocks={group} assets={assets} currency={currency} />
        ) : (
          <ContentBlockView
            key={group[0].id}
            block={group[0]}
            storeSlug={storeSlug}
            assets={assets}
            images={images}
            currency={currency}
            heading={group[0].id === leadHeroId ? 'h1' : 'h2'}
          />
        ),
      )}
    </Stack>
  )
}

/**
 * Agrupa las campanas CONSECUTIVAS; todo lo demas viaja de una en una.
 *
 * Dos promociones seguidas, cada una ocupando el ancho entero, obligan a
 * desplazar la portada para descubrir que existe la segunda — y la segunda
 * nunca se ve. Puestas en fila se comparan de un vistazo, que es lo que hace
 * alguien delante de varias ofertas.
 *
 * Se agrupan solo las contiguas a proposito: el orden lo decide el editor en el
 * CMS, y reordenar aqui seria pintar una portada que el editor no compuso.
 */
type BlockGroup = readonly [ContentBlock, ...ContentBlock[]]

function groupCampaigns(blocks: readonly ContentBlock[]): BlockGroup[] {
  const groups: [ContentBlock, ...ContentBlock[]][] = []
  for (const block of blocks) {
    const last = groups[groups.length - 1]
    if (block.type === 'campaign' && last && last[0].type === 'campaign') last.push(block)
    else groups.push([block])
  }
  return groups
}

/** Varias campanas vigentes, en rejilla. Tres por fila es el limite legible. */
function CampaignWall({
  blocks,
  assets,
  currency,
}: {
  blocks: readonly ContentBlock[]
  assets: Record<string, string>
  currency?: string
}) {
  const { t } = useI18n()

  return (
    <Stack component="section" aria-label={t('store.content.campaignWall')} sx={{ gap: 1.5 }}>
      <Typography
        component="h2"
        sx={{
          fontSize: T.label,
          fontWeight: 800,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--accent-deep)',
        }}
      >
        {t('store.content.campaignWall')}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gap: { xs: 1.5, md: 2 },
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, minmax(0, 1fr))',
            md: `repeat(${Math.min(blocks.length, 3)}, minmax(0, 1fr))`,
          },
        }}
      >
        {blocks.map((block) => (
          <CampaignBlock key={block.id} block={block} assets={assets} currency={currency} dense />
        ))}
      </Box>
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
  currency,
  heading,
}: {
  block: ContentBlock
  storeSlug: string
  assets: Record<string, string>
  images: Record<string, string>
  currency?: string
  heading: 'h1' | 'h2'
}) {
  switch (block.type) {
    case 'hero':
      return <HeroBlock block={block} assets={assets} heading={heading} />
    case 'banner':
      return <BannerBlock block={block} assets={assets} />
    case 'campaign':
      return <CampaignBlock block={block} assets={assets} currency={currency} />
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

function BlockCta({
  block,
  contrast = false,
  quiet = false,
}: {
  block: ContentBlock
  contrast?: boolean
  /**
   * El botón sin relleno, para cuando hay varios a la vez.
   *
   * Tres píldoras oscuras en fila pesan más que las tres ofertas que vienen a
   * anunciar: lo primero que ve el ojo acaba siendo el botón, y el botón es lo
   * último que hace falta leer. En texto con flecha sigue siendo el mismo
   * enlace, con la misma área de pulsación, y deja el peso al descuento.
   */
  quiet?: boolean
}) {
  if (!block.ctaHref || !block.ctaLabel || !isSafeHref(block.ctaHref)) return null

  const internal = isInternalPath(block.ctaHref)
  const sx = {
    alignSelf: 'flex-start',
    fontWeight: 700,
    textTransform: 'none' as const,
    borderRadius: 'var(--sf-pill)',
    px: quiet ? 0 : 2.5,
    py: quiet ? 0.5 : 1,
    boxShadow: 'none',
    ...(quiet
      ? {
          color: 'var(--accent-deep)',
          '&:hover': { bgcolor: 'transparent', textDecoration: 'underline' },
        }
      : {}),
    ...(contrast
      ? {
          bgcolor: '#FFFFFF',
          color: 'var(--accent-deep)',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.9)', boxShadow: 'none' },
        }
      : { '&:hover': { boxShadow: 'none' } }),
  }
  const variant = quiet ? 'text' : 'contained'
  const contenido = quiet ? `${block.ctaLabel} \u2192` : block.ctaLabel

  return internal ? (
    <Button component={Link} to={block.ctaHref} variant={variant} sx={sx}>
      {contenido}
    </Button>
  ) : (
    <Button
      component="a"
      href={block.ctaHref}
      target="_blank"
      rel="noopener noreferrer"
      variant={variant}
      sx={sx}
    >
      {contenido}
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
 * Qué descuenta la campaña, en cuatro caracteres.
 *
 * Es el dato por el que alguien se para: «-20 %» se lee de lejos, «Semana
 * dermocosmética» no dice cuánto. Sale de la FORMA del descuento que resuelve
 * el servidor — nunca del cupón, que sigue sin viajar.
 */
function offerBadge(
  campaign: CampaignOffer | null,
  t: (key: MessageKey) => string,
  locale: Locale,
  currency?: string,
): string | null {
  if (!campaign) return null
  switch (campaign.kind) {
    case 'percentage':
      // Sin ceros de relleno: la base guarda 15.0000 y el cartel dice 15.
      return campaign.percentOff ? `-${Number(campaign.percentOff)} %` : null
    case 'fixed_amount':
      if (!campaign.amountOff) return null
      return currency
        ? `-${moneyCorto(campaign.amountOff, currency, locale)}`
        : t('store.content.offer.save')
    case 'x_for_y': {
      const buy = Number(campaign.buyQuantity ?? 0)
      const free = Number(campaign.freeQuantity ?? 0)
      // «3x2» solo significa algo si se paga menos de lo que se lleva.
      return buy > free && free > 0 ? `${buy}x${buy - free}` : null
    }
    case 'volume_tier':
      return t('store.content.offer.tiers')
    case 'bundle':
      return t('store.content.offer.bundle')
    default:
      return null
  }
}

/**
 * El importe de un cartel: «S/ 20», no «S/ 20.00».
 *
 * Los céntimos de un precio son obligatorios; los de un descuento redondo son
 * ruido, y encima alargan el medallón hasta comerse el título.
 */
function moneyCorto(amount: number, currency: string, locale: Locale): string {
  if (!Number.isInteger(amount)) return formatMoney(amount, currency, locale)
  try {
    return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-PE', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount)
  } catch {
    return formatMoney(amount, currency, locale)
  }
}

/** Días que le quedan a la campaña, redondeados hacia arriba. */
function daysLeft(endsAt: string, now: number = Date.now()): number {
  return Math.ceil((new Date(endsAt).getTime() - now) / 86_400_000)
}

/**
 * El medallón del descuento.
 *
 * Sustituye al panel de color que ocupaba media tarjeta para escribir dentro
 * «Promoción vigente» — lo mismo que ya decía el rótulo de al lado, en grande y
 * ocupando el sitio de la información. Un cartel que se repite a sí mismo no
 * informa: gasta espacio.
 *
 * Ahora ese hueco vale algo: cuando la campaña sabe cuánto descuenta lo enseña
 * («-20 %», «3x2»); cuando no —porque nadie ha declarado la forma del descuento
 * todavía— cae a la etiqueta de oferta, que ocupa 56 píxeles y no una columna.
 */
function OfferMedallion({ badge, dense }: { badge: string | null; dense: boolean }) {
  const lado = dense ? 52 : 64

  return (
    <Box
      aria-hidden
      sx={{
        width: badge ? 'auto' : lado,
        minWidth: lado,
        height: lado,
        px: badge ? 1.5 : 0,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 'var(--sf-radius-sm)',
        bgcolor: 'color-mix(in srgb, var(--accent) 16%, var(--card))',
        border: '1px solid color-mix(in srgb, var(--accent) 32%, transparent)',
        color: 'var(--accent-deep)',
      }}
    >
      {badge ? (
        <Typography
          sx={{
            fontSize: dense ? 20 : 24,
            fontWeight: 900,
            letterSpacing: '-0.03em',
            whiteSpace: 'nowrap',
          }}
        >
          {badge}
        </Typography>
      ) : (
        <LocalOfferRoundedIcon sx={{ fontSize: dense ? 24 : 28 }} />
      )}
    </Box>
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
 *
 * La tarjeta dice tres cosas y en este orden: **cuánto** (el medallón), **de
 * qué** (el título y su frase) y **hasta cuándo** (la línea de estado). Antes
 * decía cuatro veces que era una promoción vigente —el rótulo, el chip, un
 * panel de color con la palabra escrita en grande y la fecha— y ninguna vez
 * cuánto descontaba.
 *
 * Dos formas para dos sitios, y la diferencia no es decorativa:
 *
 *  · **sola**, a lo ancho de la portada: en fila —descuento, texto, botón— para
 *    que el ancho se use en vez de dejar medio cartel en blanco;
 *  · **`dense`**, dentro de un mural de varias: en columna y con el enlace
 *    abajo del todo, para que tres tarjetas terminen a la misma altura y se
 *    puedan comparar de un vistazo.
 */
function CampaignBlock({
  block,
  assets,
  currency,
  dense = false,
}: {
  block: ContentBlock
  assets: Record<string, string>
  currency?: string
  dense?: boolean
}) {
  const { t, locale } = useI18n()
  const url = mediaUrl(block.mediaUrl, assets)
  const badge = offerBadge(block.campaign, t, locale, currency)
  const restante = block.campaignLive && block.campaignEndsAt ? daysLeft(block.campaignEndsAt) : null
  // Una semana es donde «me lo pienso» pasa a «se me acaba». Antes de eso la
  // cuenta atrás es ruido; a partir de ahí es la información útil.
  const acaba = restante !== null && restante >= 0 && restante <= 7

  const fecha = block.campaignEndsAt
    ? new Date(block.campaignEndsAt).toLocaleDateString(locale === 'en' ? 'en-US' : 'es-PE', {
        day: 'numeric',
        month: 'long',
      })
    : null

  /**
   * Hasta cuándo, en UNA línea.
   *
   * «Activa» + «Hasta el 30 set. 2026» eran dos frases para un solo dato. El
   * año sobra en una campaña que dura semanas, y la urgencia solo se nombra
   * cuando existe.
   */
  const vigencia = !block.campaignLive
    ? null
    : acaba
      ? (restante ?? 0) <= 1
        ? t('store.content.offer.lastDay')
        : t('store.content.offer.daysLeft').replace('{days}', String(restante))
      : fecha
        ? `${t('store.content.campaignEnds')} ${fecha}`
        : t('store.content.campaignLive')

  const foto = url ? (
    <Box
      component="img"
      src={url}
      alt={block.mediaAlt ?? ''}
      aria-hidden={block.mediaAlt ? undefined : true}
      loading="lazy"
      decoding="async"
      // Proporción declarada: sin ella la tarjeta salta cuando la foto llega.
      sx={{
        width: dense ? '100%' : { xs: '100%', sm: 260 },
        height: dense ? 150 : { xs: 170, sm: 'auto' },
        minHeight: dense ? 150 : 168,
        objectFit: 'cover',
        flexShrink: 0,
        bgcolor: 'var(--sf-media-bg)',
      }}
    />
  ) : null

  const textos = (
    <Stack sx={{ gap: 0.75, flex: 1, minWidth: 0, height: '100%' }}>
      <Typography
        component="h2"
        sx={{
          fontSize: dense ? { xs: 18, md: 19 } : { xs: 21, md: 24 },
          fontWeight: 800,
          letterSpacing: '-0.02em',
          lineHeight: 1.2,
        }}
      >
        {block.title}
      </Typography>

      {block.subtitle ? (
        <Typography
          sx={{
            fontSize: T.body,
            color: 'var(--muted)',
            maxWidth: '58ch',
            // En el mural las tarjetas van a la par: dos líneas cada una, y la
            // que se pase se corta en vez de estirar su columna.
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {block.subtitle}
        </Typography>
      ) : null}

      {/* Estado en una sola línea: hasta cuándo, el mínimo si lo hay, y el
          aviso de cupón. Tres datos distintos, no tres formas de decir que la
          promoción existe. */}
      <Stack direction="row" sx={{ gap: 0.75, alignItems: 'center', flexWrap: 'wrap', pt: 0.25 }}>
        {vigencia ? (
          <Typography
            sx={{
              fontSize: T.label,
              fontWeight: 800,
              color: acaba ? 'var(--accent-deep)' : 'var(--muted)',
              ...(acaba
                ? {
                    px: 1,
                    py: 0.25,
                    borderRadius: 'var(--sf-pill)',
                    bgcolor: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                  }
                : {}),
            }}
          >
            {vigencia}
          </Typography>
        ) : null}

        {block.campaign?.minSubtotal && currency ? (
          <Typography sx={{ fontSize: T.label, color: 'var(--muted)' }}>
            {t('store.content.offer.minSubtotal').replace(
              '{amount}',
              moneyCorto(block.campaign.minSubtotal, currency, locale),
            )}
          </Typography>
        ) : null}

        {/* Que hace falta un código se dice; cuál es, no. Prometer un descuento
            que no se aplica solo decepciona en el carrito. */}
        {block.campaign?.needsCoupon ? (
          <Typography
            sx={{
              fontSize: T.label,
              fontWeight: 700,
              color: 'var(--text)',
              px: 1,
              py: 0.25,
              borderRadius: 'var(--sf-pill)',
              border: '1px solid var(--sf-line-strong)',
            }}
          >
            {t('store.content.offer.needsCoupon')}
          </Typography>
        ) : null}
      </Stack>

      {/* En el mural el enlace va al fondo de la tarjeta: así las tres filas de
          enlaces quedan a la misma altura aunque una campaña traiga una línea
          más que otra. */}
      {dense ? (
        <Box sx={{ mt: 'auto', pt: 0.75 }}>
          <BlockCta block={block} quiet />
        </Box>
      ) : null}
    </Stack>
  )

  return (
    <Card
      component="section"
      aria-label={block.title ?? undefined}
      sx={{
        p: 0,
        position: 'relative',
        overflow: 'hidden',
        height: dense ? '100%' : undefined,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 'var(--sf-radius)',
        border: '1px solid var(--sf-line)',
        boxShadow: 'var(--sf-shadow)',
        bgcolor: 'var(--card)',
        transition: 'transform .18s ease, box-shadow .18s ease, border-color .18s ease',
        '@media (hover: hover)': {
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: 'var(--sf-shadow-hover)',
            borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)',
          },
        },
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
          '&:hover': { transform: 'none' },
        },
      }}
    >
      {/* Filo de acento: dice «esto es una oferta» sin gastar una columna ni
          repetir la palabra. Es el único adorno de la tarjeta. */}
      <Box
        aria-hidden
        sx={{
          height: 4,
          flexShrink: 0,
          background:
            'linear-gradient(90deg, var(--accent-deep) 0%, color-mix(in srgb, var(--accent) 55%, transparent) 100%)',
        }}
      />

      <Stack
        direction={dense ? 'column' : { xs: 'column', sm: 'row' }}
        sx={{ flex: 1, alignItems: 'stretch' }}
      >
        {foto}

        <Stack
          direction="row"
          sx={{
            gap: dense ? 1.75 : 2.5,
            p: dense ? 2 : { xs: 2.25, md: 3 },
            flex: 1,
            minWidth: 0,
            alignItems: dense ? 'flex-start' : 'center',
          }}
        >
          {/* Con foto, el medallón se cuela sobre ella —el descuento no pierde
              el primer sitio por tener una imagen bonita—; sin foto, ocupa el
              hueco que antes gastaba el panel de color. */}
          {foto ? null : <OfferMedallion badge={badge} dense={dense} />}

          {textos}

          {/* Sola y a lo ancho, el botón va a la derecha y en el centro: la
              tarjeta se lee de izquierda a derecha —cuánto, qué, y qué hago—
              en vez de dejar la mitad derecha en blanco. */}
          {dense ? null : (
            <Box sx={{ flexShrink: 0, display: { xs: 'none', sm: 'block' } }}>
              <BlockCta block={block} />
            </Box>
          )}
        </Stack>

        {/* En móvil el botón vuelve abajo, a lo ancho de la tarjeta: a la
            derecha no cabe sin estrangular el texto. */}
        {dense ? null : (
          <Box sx={{ display: { xs: 'block', sm: 'none' }, px: 2.25, pb: 2.25 }}>
            <BlockCta block={block} />
          </Box>
        )}
      </Stack>

      {foto ? (
        <Box sx={{ position: 'absolute', top: dense ? 18 : 22, left: dense ? 16 : 20 }}>
          <OfferMedallion badge={badge} dense={dense} />
        </Box>
      ) : null}
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
      {/* Carrusel de verdad: `ScrollRow` pone las flechas, el difuminado del
          borde y esconde la barra. Antes era un `overflow-x` pelado, que en
          escritorio no ofrece ningun gesto —no hay rueda horizontal— y encima
          dejaba la barra gris cruzando la seccion. */}
      {scroll ? (
        <ScrollRow gap={2} ariaLabel={block.title ?? undefined}>
          {items.map((item) => (
            <Box
              key={'variant_id' in item ? item.variant_id : item.product_id}
              sx={{
                flex: '0 0 auto',
                // Ancho fijo por tarjeta: en una fila que se desplaza, dejarlas
                // crecer hace que la ultima quede a medias de una forma
                // distinta en cada pantalla.
                width: { xs: '68%', sm: '42%', md: 250 },
                scrollSnapAlign: 'start',
              }}
            >
              <CollectionCard
                item={item}
                storeSlug={storeSlug}
                images={images}
                showPrice={showPrice}
                snap={false}
              />
            </Box>
          ))}
        </ScrollRow>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: {
              xs: 'repeat(2, minmax(0, 1fr))',
              md: `repeat(${Math.min(Math.max(columns, 2), 6)}, minmax(0, 1fr))`,
            },
          }}
        >
          {items.map((item) => (
            <CollectionCard
              key={'variant_id' in item ? item.variant_id : item.product_id}
              item={item}
              storeSlug={storeSlug}
              images={images}
              showPrice={showPrice}
              snap={false}
            />
          ))}
        </Box>
      )}
    </Stack>
  )
}

/**
 * Cabecera de seccion.
 *
 * El titulo llevaba una barra de acento a la izquierda... y no: una seccion de
 * portada no es una cita. Lo que la separa de la anterior es AIRE y peso
 * tipografico, no un adorno. Lo unico que se anade es la regla fina que corre
 * hasta el borde derecho: cierra el bloque, ordena la lectura y no compite con
 * nada.
 */
function BlockHeading({ block }: { block: ContentBlock }) {
  if (!block.title && !block.subtitle) return null
  return (
    <Stack direction="row" sx={{ alignItems: 'flex-end', gap: 2 }}>
      <Stack sx={{ gap: 0.25, flexShrink: 0 }}>
        {block.title ? (
          <Typography
            component="h2"
            sx={{
              fontSize: { xs: 21, md: 26 },
              fontWeight: 800,
              letterSpacing: '-0.025em',
              lineHeight: 1.2,
            }}
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
      {/* Regla que arranca en el acento y se apaga hacia el borde: cierra el
          bloque y ordena la lectura sin competir con el titulo. A 1 px y en
          gris no se veia; el degradado se ve y sigue sin gritar. */}
      <Box
        aria-hidden
        sx={{
          flex: 1,
          height: 2,
          minWidth: 24,
          mb: 1.25,
          borderRadius: 1,
          background:
            'linear-gradient(to right, color-mix(in srgb, var(--accent) 55%, transparent), transparent)',
        }}
      />
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
  // Mismo criterio que la tarjeta del catalogo: el porcentaje se calcula, no se
  // escribe a mano, y solo existe si el «antes» es mayor que el precio.
  const descuento =
    item.compare_at_price && price && Number(item.compare_at_price) > Number(price)
      ? Math.round((1 - Number(price) / Number(item.compare_at_price)) * 100)
      : null

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
      <Box className="sf-collection-media" sx={{ position: 'relative' }}>
      {descuento !== null ? (
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            left: 8,
            zIndex: 1,
            px: 0.875,
            py: 0.25,
            borderRadius: 'var(--sf-pill)',
            bgcolor: 'var(--accent)',
            color: '#FFFFFF',
            fontSize: T.label,
            fontWeight: 800,
            lineHeight: 1.6,
          }}
        >
          {`-${descuento}%`}
        </Box>
      ) : null}
      <ProductMedia
        url={item.image_path ? (images[item.image_path] ?? null) : null}
        alt={item.image_alt ?? item.name}
      />
      </Box>
      {item.kind === 'product' && item.brand_name ? (
        <Typography
          sx={{
            fontSize: 10.5,
            fontWeight: 800,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
            lineHeight: 1.4,
          }}
        >
          {item.brand_name}
        </Typography>
      ) : null}
      <Typography
        sx={{
          fontSize: 15,
          fontWeight: 650,
          lineHeight: 1.35,
          // Dos lineas y elipsis: un nombre largo no puede empujar el precio
          // fuera de la tarjeta ni descuadrar la fila.
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {item.name}
      </Typography>
      {item.kind === 'variant' && item.variant_label ? (
        <Typography sx={{ fontSize: T.label, color: 'var(--muted)' }}>
          {item.variant_label}
        </Typography>
      ) : null}
      {showPrice && price && item.currency ? (
        // El «antes» tachado va JUNTO al precio, no debajo: en una fila de
        // ofertas lo que se compara es una cifra con otra, y separarlas obliga
        // a hacer la resta de memoria.
        <Stack direction="row" sx={{ alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap', mt: 0.25 }}>
          <Typography
            className="tnum"
            sx={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em' }}
          >
            {formatMoney(Number(price), item.currency, locale)}
          </Typography>
          {descuento !== null && item.compare_at_price ? (
            <Typography
              component="s"
              className="tnum"
              sx={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600 }}
            >
              {formatMoney(Number(item.compare_at_price), item.currency, locale)}
            </Typography>
          ) : null}
        </Stack>
      ) : null}
      {item.in_stock === false ? (
        <Typography sx={{ fontSize: T.micro, fontWeight: 700, color: 'var(--muted)' }}>
          {t('store.availability.outOfStock')}
        </Typography>
      ) : null}
    </Card>
  )
}
