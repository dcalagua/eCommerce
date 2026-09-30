import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import { Box, ButtonBase, Stack, Typography } from '@mui/material'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { iconoDe } from '../categoryIcon'
import { offerBadge, vigenciaTexto } from '../offer'
import type { StorePromotion } from '../promotions'
import type { ResolvedValueProp } from '../valueProps'
import { Countdown } from './Countdown'
import { ProductMedia } from './ProductMedia'

/**
 * Rediseño v3 · La portada de UNIVERSAL (lámina «02 — Universal · Home»).
 *
 * Tres columnas, como la primera pantalla de una gran superficie:
 *
 *  · **Departamentos** a la izquierda: las familias reales de la tienda, con su
 *    icono y una flecha. Es la barra de familias de la cabecera, puesta donde
 *    se entra por departamento.
 *  · **El banner** al centro: las campañas vigentes, una a una, con su foto,
 *    su vigencia, su texto y la puerta a sus productos.
 *  · **Dos bloques** a la derecha: «Ofertas del día» —con el reloj si una
 *    campaña termina pronto— y el primer beneficio de servicio de la tienda.
 *
 * Todo sale de datos que la portada ya tiene. Sin campañas no hay banner que
 * inventar: quien llama pasa `fallback` (el carrusel de producto de siempre).
 */
export function StoreUniversalHero({
  storeSlug,
  departments,
  promotions,
  promoAssets = {},
  currency,
  offerThumb,
  maxDiscount,
  clockEndsAt,
  service,
  fallback,
}: {
  storeSlug: string
  departments: readonly { readonly category_id: string; readonly name: string; readonly slug: string }[]
  promotions: readonly StorePromotion[]
  promoAssets?: Record<string, string>
  currency: string
  /** La foto de la primera oferta, para el bloque de ofertas. */
  offerThumb: string | null
  maxDiscount: number
  clockEndsAt: string | null
  service: ResolvedValueProp | null
  fallback: ReactNode
}) {
  const { t } = useI18n()

  return (
    <Box
      data-hero-layout="universal"
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: {
          xs: '1fr',
          lg: departments.length > 0 ? '220px minmax(0, 1fr) 260px' : 'minmax(0, 1fr) 260px',
        },
        alignItems: 'stretch',
      }}
    >
      {departments.length > 0 ? (
        <Box
          component="nav"
          aria-label={t('store.categories.title')}
          sx={{
            display: { xs: 'none', lg: 'block' },
            py: 1,
            bgcolor: 'var(--card)',
            border: '1px solid var(--sf-line)',
            borderRadius: 'var(--sf-radius)',
          }}
        >
          {departments.slice(0, 10).map((dep) => {
            const Icono = iconoDe(dep.name)
            return (
              <Box
                key={dep.category_id}
                component={Link}
                to={`/s/${storeSlug}?c=${encodeURIComponent(dep.slug)}`}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  px: 2,
                  py: 1,
                  color: 'var(--text)',
                  textDecoration: 'none',
                  fontSize: 14,
                  fontWeight: 500,
                  '&:hover': { bgcolor: 'var(--neutral-soft)', color: 'var(--accent-deep)' },
                }}
              >
                <Icono sx={{ fontSize: 18, color: 'var(--muted)' }} />
                <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {dep.name}
                </Box>
                <ChevronRightRoundedIcon aria-hidden sx={{ fontSize: 18, color: 'var(--muted)' }} />
              </Box>
            )
          })}
        </Box>
      ) : null}

      {promotions.length > 0 ? (
        <Banner promotions={promotions} assets={promoAssets} storeSlug={storeSlug} currency={currency} />
      ) : (
        <Box sx={{ minWidth: 0 }}>{fallback}</Box>
      )}

      <Stack sx={{ gap: 2, minWidth: 0 }}>
        <Box
          component={Link}
          to={`/s/${storeSlug}?ver=todo&oferta=1`}
          data-universal-deals
          sx={{
            position: 'relative',
            flex: 1,
            minHeight: 170,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: 1,
            p: 2.25,
            overflow: 'hidden',
            borderRadius: 'var(--sf-radius)',
            bgcolor: 'var(--sf-deal)',
            color: 'var(--sf-deal-fg)',
            textDecoration: 'none',
          }}
        >
          <Typography sx={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {t('store.universal.deals')}
          </Typography>
          {offerThumb ? (
            <Box
              aria-hidden
              sx={{ position: 'absolute', right: 14, top: 40, width: 84, height: 84, mixBlendMode: 'multiply' }}
            >
              <ProductMedia url={offerThumb} alt="" ratio="1 / 1" fit="contain" />
            </Box>
          ) : null}
          <Box sx={{ position: 'relative' }}>
            {clockEndsAt ? (
              <Stack sx={{ gap: 0.5 }}>
                <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>{t('store.feria.endsIn')}</Typography>
                <Box sx={{ fontSize: 20, fontWeight: 800 }}>
                  <Countdown endsAt={clockEndsAt} variant="inline" />
                </Box>
              </Stack>
            ) : maxDiscount > 0 ? (
              <Typography sx={{ fontSize: 22, fontWeight: 800, lineHeight: 1.15 }}>
                {`${t('store.feria.upTo')} −${maxDiscount}%`}
              </Typography>
            ) : null}
            <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mt: 0.75, fontSize: 13, fontWeight: 700 }}>
              {t('store.universal.seeDeals')}
              <ArrowForwardRoundedIcon aria-hidden sx={{ fontSize: 16 }} />
            </Stack>
          </Box>
        </Box>

        {service ? (
          <Box
            data-universal-service
            sx={{
              flex: 1,
              minHeight: 150,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: 1,
              p: 2.25,
              borderRadius: 'var(--sf-radius)',
              bgcolor: 'color-mix(in srgb, var(--accent) 9%, var(--card))',
            }}
          >
            <Typography sx={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent-deep)' }}>
              {service.title}
            </Typography>
            <Typography sx={{ fontSize: 17, fontWeight: 800, lineHeight: 1.25 }}>{service.body}</Typography>
          </Box>
        ) : null}
      </Stack>
    </Box>
  )
}

function fuenteDe(referencia: string | null, firmadas: Record<string, string>) {
  if (!referencia) return null
  if (/^https?:\/\//i.test(referencia)) return referencia
  return firmadas[referencia] ?? null
}

function destinoDe(promo: StorePromotion, storeSlug: string) {
  return promo.categorySlug
    ? `/s/${storeSlug}?c=${encodeURIComponent(promo.categorySlug)}`
    : promo.brandCode
      ? `/s/${storeSlug}?b=${encodeURIComponent(promo.brandCode)}`
      : `/s/${storeSlug}?ver=todo&oferta=1`
}

/** El banner de campañas: una a la vez, con puntos para pasar. */
function Banner({
  promotions,
  assets,
  storeSlug,
  currency,
}: {
  promotions: readonly StorePromotion[]
  assets: Record<string, string>
  storeSlug: string
  currency: string
}) {
  const { t, locale } = useI18n()
  const [indice, setIndice] = useState(0)
  const promo = promotions[Math.min(indice, promotions.length - 1)]!
  const foto = fuenteDe(promo.imageUrl, assets)
  const badge = offerBadge(promo, t, locale, currency)
  const vigencia = vigenciaTexto(promo.endsAt, t, locale)
  const pastilla = [badge, vigencia?.texto].filter(Boolean).join(' · ')

  return (
    <Box
      component="section"
      aria-roledescription="carousel"
      aria-label={t('store.promos.title')}
      data-universal-banner
      sx={{
        position: 'relative',
        minHeight: { xs: 280, md: 360 },
        display: 'flex',
        alignItems: 'flex-end',
        overflow: 'hidden',
        borderRadius: 'var(--sf-radius)',
        color: '#fff',
        background: foto
          ? `linear-gradient(90deg, rgba(8,12,20,.78) 0%, rgba(8,12,20,.45) 50%, rgba(8,12,20,.1) 100%), url("${foto.replace(/"/g, '%22')}") center / cover no-repeat`
          : 'var(--sf-band)',
      }}
    >
      <Stack sx={{ position: 'relative', gap: 1.5, p: { xs: 3, md: 4.5 }, maxWidth: 560 }}>
        {pastilla ? (
          <Box
            data-universal-kicker
            sx={{
              alignSelf: 'flex-start',
              px: 1,
              py: 0.375,
              borderRadius: 1,
              bgcolor: 'var(--sf-deal)',
              color: 'var(--sf-deal-fg)',
              fontSize: 11.5,
              fontWeight: 800,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            {pastilla}
          </Box>
        ) : null}
        <Typography component="h2" sx={{ fontSize: { xs: 28, md: 40 }, fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.02em' }}>
          {promo.name}
        </Typography>
        {promo.description ? (
          <Typography sx={{ fontSize: 15, opacity: 0.88 }}>{promo.description}</Typography>
        ) : null}
        <Box
          component={Link}
          to={destinoDe(promo, storeSlug)}
          sx={{
            alignSelf: 'flex-start',
            mt: 1,
            px: 2.25,
            py: 1.125,
            borderRadius: 'var(--sf-btn-radius)',
            bgcolor: '#fff',
            color: 'var(--text)',
            fontSize: 14,
            fontWeight: 700,
            textDecoration: 'none',
          }}
        >
          {t('store.promos.see')}
        </Box>
      </Stack>

      {promotions.length > 1 ? (
        <Stack direction="row" sx={{ position: 'absolute', left: { xs: 24, md: 36 }, bottom: 16, gap: 0.75 }}>
          {promotions.map((p, i) => (
            <ButtonBase
              key={p.id}
              onClick={() => setIndice(i)}
              aria-label={`${i + 1} / ${promotions.length}: ${p.name}`}
              aria-current={i === indice}
              sx={{
                width: i === indice ? 22 : 8,
                height: 8,
                borderRadius: 999,
                bgcolor: i === indice ? '#fff' : 'rgba(255,255,255,.5)',
                transition: 'width .2s ease',
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              }}
            />
          ))}
        </Stack>
      ) : null}
    </Box>
  )
}
