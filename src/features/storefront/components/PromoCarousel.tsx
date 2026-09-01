import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import LocalOfferRoundedIcon from '@mui/icons-material/LocalOfferRounded'
import { Box, Button, Card, IconButton, Stack, Typography } from '@mui/material'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { T } from '@/theme/tokens'
import { moneyCorto, offerBadge, vigenciaTexto } from '../offer'
import type { StorePromotion } from '../promotions'

/** Cada cuánto pasa sola. Seis segundos: lo que se tarda en leer un cartel. */
const INTERVALO_MS = 6000

/**
 * Las ofertas vigentes, pasando solas.
 *
 * Tres campañas apiladas ocupan tres pantallas y solo se ve la primera; en
 * carrusel ocupan una y se ven las tres. El precio de esa decisión es que el
 * contenido se mueve sin que nadie lo pida, así que aquí se paga entero:
 *
 *  · **se para al pasar el ratón y al recibir el foco** — nada se escapa
 *    mientras se está leyendo o tabulando;
 *  · **no se mueve si el sistema pide menos movimiento** (`prefers-reduced-
 *    motion`): quien marcó esa preferencia lo hizo por algo, y entonces el
 *    carrusel es una lista que se pasa a mano;
 *  · **todas las láminas están en el DOM**, las ocultas con `aria-hidden`: un
 *    lector de pantalla las recorre por los puntos, no por el tiempo.
 */
export function PromoCarousel({
  promotions,
  storeSlug,
  currency,
}: {
  promotions: readonly StorePromotion[]
  storeSlug: string
  currency: string
}) {
  const { t } = useI18n()
  const [actual, setActual] = useState(0)
  const [parado, setParado] = useState(false)
  const contenedor = useRef<HTMLDivElement | null>(null)

  const total = promotions.length
  const ir = useCallback(
    (indice: number) => setActual(((indice % total) + total) % total),
    [total],
  )

  useEffect(() => {
    // Una sola oferta no es un carrusel: no hay a dónde pasar.
    if (total <= 1 || parado) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    const id = window.setInterval(() => setActual((i) => (i + 1) % total), INTERVALO_MS)
    return () => window.clearInterval(id)
  }, [total, parado])

  // Si el comercio retira campañas mientras la pestaña está abierta, el índice
  // puede quedar apuntando a una lámina que ya no existe.
  useEffect(() => {
    if (actual >= total) setActual(0)
  }, [actual, total])

  if (total === 0) return null

  const promo = promotions[actual]
  if (!promo) return null

  return (
    <Stack
      component="section"
      aria-roledescription="carousel"
      aria-label={t('store.promos.title')}
      ref={contenedor}
      onMouseEnter={() => setParado(true)}
      onMouseLeave={() => setParado(false)}
      onFocusCapture={() => setParado(true)}
      onBlurCapture={(event) => {
        if (!contenedor.current?.contains(event.relatedTarget as Node | null)) setParado(false)
      }}
      sx={{ gap: 1.25 }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
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
          {t('store.promos.title')}
        </Typography>

        {total > 1 ? (
          <Stack direction="row" sx={{ gap: 0.5, ml: 'auto' }}>
            <IconButton
              size="small"
              aria-label={t('store.promos.prev')}
              onClick={() => ir(actual - 1)}
              sx={{ border: '1px solid var(--sf-line)', bgcolor: 'var(--card)' }}
            >
              <ChevronLeftRoundedIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              aria-label={t('store.promos.next')}
              onClick={() => ir(actual + 1)}
              sx={{ border: '1px solid var(--sf-line)', bgcolor: 'var(--card)' }}
            >
              <ChevronRightRoundedIcon fontSize="small" />
            </IconButton>
          </Stack>
        ) : null}
      </Stack>

      <Box sx={{ position: 'relative' }}>
        {promotions.map((item, indice) => (
          <Box
            key={item.id}
            aria-hidden={indice === actual ? undefined : true}
            sx={
              indice === actual
                ? {}
                : // Fuera de la vista pero en el DOM: así el alto no salta al
                  // pasar de una lámina corta a una larga.
                  { position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none' }
            }
          >
            <PromoSlide promo={item} storeSlug={storeSlug} currency={currency} />
          </Box>
        ))}
      </Box>

      {total > 1 ? (
        <Stack direction="row" sx={{ gap: 0.75, justifyContent: 'center' }}>
          {promotions.map((item, indice) => (
            <Box
              key={item.id}
              component="button"
              type="button"
              aria-label={t('store.promos.goTo').replace('{name}', item.name)}
              aria-current={indice === actual ? 'true' : undefined}
              onClick={() => ir(indice)}
              sx={{
                border: 0,
                p: 0,
                cursor: 'pointer',
                height: 6,
                width: indice === actual ? 22 : 6,
                borderRadius: 999,
                transition: 'width .2s ease, background-color .2s ease',
                bgcolor: indice === actual ? 'var(--accent-deep)' : 'var(--sf-line-strong)',
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              }}
            />
          ))}
        </Stack>
      ) : null}
    </Stack>
  )
}

/**
 * Una oferta, con la misma anatomía que la tarjeta de campaña del CMS:
 * **cuánto** (el medallón), **de qué** (nombre y frase) y **hasta cuándo**.
 */
function PromoSlide({
  promo,
  storeSlug,
  currency,
}: {
  promo: StorePromotion
  storeSlug: string
  currency: string
}) {
  const { t, locale } = useI18n()
  const badge = offerBadge(promo, t, locale, currency)
  const vigencia = vigenciaTexto(promo.endsAt, t, locale)

  /**
   * A dónde lleva.
   *
   * A los productos que ALCANZA la promoción cuando se sabe —su categoría o su
   * marca—; al catálogo cuando la campaña es de pedido entero. Un botón que
   * lleva a una lista donde no se ve la oferta es peor que no ponerlo.
   */
  const destino = promo.categorySlug
    ? `/s/${storeSlug}?c=${encodeURIComponent(promo.categorySlug)}`
    : promo.brandCode
      ? `/s/${storeSlug}?b=${encodeURIComponent(promo.brandCode)}`
      : `/s/${storeSlug}`

  return (
    <Card
      sx={{
        p: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 'var(--sf-radius)',
        border: '1px solid var(--sf-line)',
        boxShadow: 'var(--sf-shadow)',
        bgcolor: 'var(--card)',
      }}
    >
      <Box
        aria-hidden
        sx={{
          height: 4,
          background:
            'linear-gradient(90deg, var(--accent-deep) 0%, color-mix(in srgb, var(--accent) 55%, transparent) 100%)',
        }}
      />

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        sx={{ gap: 2.5, p: { xs: 2.25, md: 3 }, alignItems: { xs: 'flex-start', sm: 'center' } }}
      >
        <Box
          aria-hidden
          sx={{
            minWidth: 64,
            height: 64,
            px: badge ? 1.5 : 0,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            borderRadius: 'var(--sf-radius-sm)',
            bgcolor: 'color-mix(in srgb, var(--accent) 16%, var(--card))',
            border: '1px solid color-mix(in srgb, var(--accent) 32%, transparent)',
            color: 'var(--accent-deep)',
          }}
        >
          {badge ? (
            <Typography sx={{ fontSize: 24, fontWeight: 900, letterSpacing: '-0.03em', whiteSpace: 'nowrap' }}>
              {badge}
            </Typography>
          ) : (
            <LocalOfferRoundedIcon sx={{ fontSize: 28 }} />
          )}
        </Box>

        <Stack sx={{ gap: 0.75, flex: 1, minWidth: 0 }}>
          <Typography
            component="h3"
            sx={{ fontSize: { xs: 21, md: 24 }, fontWeight: 800, letterSpacing: '-0.02em' }}
          >
            {promo.name}
          </Typography>

          {promo.description ? (
            <Typography
              sx={{
                fontSize: T.body,
                color: 'var(--muted)',
                maxWidth: '58ch',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {promo.description}
            </Typography>
          ) : null}

          <Stack direction="row" sx={{ gap: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
            {vigencia ? (
              <Typography
                sx={{
                  fontSize: T.label,
                  fontWeight: 800,
                  color: vigencia.urgente ? 'var(--accent-deep)' : 'var(--muted)',
                  ...(vigencia.urgente
                    ? {
                        px: 1,
                        py: 0.25,
                        borderRadius: 'var(--sf-pill)',
                        bgcolor: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                      }
                    : {}),
                }}
              >
                {vigencia.texto}
              </Typography>
            ) : null}

            {promo.minSubtotal ? (
              <Typography sx={{ fontSize: T.label, color: 'var(--muted)' }}>
                {t('store.content.offer.minSubtotal').replace(
                  '{amount}',
                  moneyCorto(promo.minSubtotal, currency, locale),
                )}
              </Typography>
            ) : null}
          </Stack>
        </Stack>

        <Button
          component={Link}
          to={destino}
          variant="contained"
          sx={{
            flexShrink: 0,
            fontWeight: 700,
            textTransform: 'none',
            borderRadius: 'var(--sf-pill)',
            px: 2.5,
            py: 1,
            boxShadow: 'none',
            '&:hover': { boxShadow: 'none' },
          }}
        >
          {t('store.promos.see')}
        </Button>
      </Stack>
    </Card>
  )
}
