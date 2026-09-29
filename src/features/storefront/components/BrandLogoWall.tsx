import { Box, Button, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { TS } from '@/theme/tokens'
import { BrandLogo } from './BrandLogo'
import type { BrandOption } from './BrandRow'
import { SectionHeading } from './SectionHeading'

/**
 * El muro de logotipos (Storefront V3 · P07).
 *
 * ## Qué aporta sobre las tarjetas de marca
 *
 * Las tarjetas dan a cada marca su caja, su nombre en texto y su cuenta de
 * productos. Es lo correcto cuando la marca es un FILTRO: quien busca por marca
 * quiere saber cuántas referencias hay detrás.
 *
 * Un muro de logotipos no informa, **reconoce**. Quien duda de una tienda en
 * línea deja de dudar cuando ve nombres que ya conoce, y para eso el logotipo
 * tiene que estar limpio: sin caja, sin tinte y sin la cuenta al lado. Es la
 * composición que pide una tienda de marca, y por eso Premium la estrena.
 *
 * ## Lo que NO se hace con los logotipos
 *
 * **No se deforman.** `object-fit: contain` y proporción libre: un logotipo
 * estirado a un cuadrado es la identidad de otro rota en la vitrina de un
 * tercero.
 *
 * **No se pintan en gris.** Poner todos los logotipos en monocromo queda
 * ordenado y cambia la identidad de cada marca — que no es nuestra. Si algún día
 * se ofrece, será una opción explícita del comercio, no un defecto.
 *
 * **No se inventan.** La marca sin logotipo no se esconde ni se rellena con una
 * imagen de archivo: se escribe su NOMBRE en versalitas (lámina 33). Ya no el
 * monograma en un círculo de color, porque esos colores no eran de la tienda.
 */
export function BrandLogoWall({
  brands,
  selected,
  onSelect,
  seeAllHref,
}: {
  brands: readonly BrandOption[]
  selected: string | null
  onSelect: (code: string | null) => void
  seeAllHref?: string
}) {
  const { t } = useI18n()
  if (brands.length === 0) return null

  return (
    <Stack
      component="section"
      id="marcas"
      aria-label={t('store.brands.title')}
      data-brand-wall={brands.length}
      sx={{ gap: 1.5, scrollMarginTop: 'var(--sf-anchor-offset, 96px)' }}
    >
      {/**
       * La misma cabecera que las tarjetas, y el mismo enlace al catálogo.
       *
       * Sin `eyebrow` ni subtítulo: el muro es reconocimiento, y tres líneas de
       * texto encima de unos logotipos limpios le quitan justo lo que lo hace
       * limpio. Pero el titular y la salida al catálogo son los de siempre, para
       * que la sección no se lea como si viniera de otra página.
       */}
      <SectionHeading
        title={t('store.brands.title')}
        action={
          seeAllHref ? (
            <Button
              component={Link}
              to={seeAllHref}
              size="small"
              sx={{
                textTransform: 'none',
                fontWeight: 700,
                borderRadius: 'var(--sf-pill)',
                border: '1px solid var(--sf-line-strong)',
                color: 'var(--text)',
                px: 1.75,
                '&:hover': { borderColor: 'var(--accent)', bgcolor: 'transparent' },
              }}
            >
              {t('store.row.seeAll')}
            </Button>
          ) : undefined
        }
      />

      <Box
        sx={{
          /**
           * Filas CENTRADAS, no una rejilla que rellena por la izquierda.
           *
           * Con `auto-fit` y 9 marcas quedaban 8 + 1, y la novena se quedaba
           * sola pegada al borde izquierdo: se leía como un error. En filas
           * centradas de 2 / 3 / 5 (según el ancho) quedan 5 + 4 centradas.
           *
           * Filetes finos entre celdas en lugar de cajas: es un muro, no una
           * lista de tarjetas. `marginLeft: -1px` colapsa los dos bordes que se
           * tocan en uno solo.
           */
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          borderTop: '1px solid var(--sf-line)',
        }}
      >
        {brands.map((brand) => {
          const activa = selected === brand.code
          const conLogo = Boolean(brand.logoUrl)
          return (
            <Box
              key={brand.code}
              /**
               * BOTÓN que filtra, no enlace.
               *
               * Es la misma promesa que las tarjetas de marca: pulsar una marca
               * filtra la vitrina que ya se está mirando —`onSelect` escribe
               * `?b=` en la URL, así que el filtro se comparte y el botón de
               * atrás lo deshace— y volver a pulsarla la suelta. Un `<a>` con
               * `aria-pressed` sería mentir al lector de pantalla sobre las dos
               * cosas: que lleva a otro sitio y que no se apaga.
               *
               * La salida al catálogo completo existe, pero está arriba, en la
               * cabecera, donde también la tienen las tarjetas.
               */
              component="button"
              type="button"
              aria-pressed={activa}
              onClick={() => onSelect(activa ? null : brand.code)}
              data-brand-tile={brand.code}
              sx={{
                flex: { xs: '0 0 50%', sm: '0 0 33.333%', md: '0 0 20%' },
                display: 'grid',
                placeItems: 'center',
                alignContent: 'center',
                gap: 0.75,
                px: 1.5,
                py: 2,
                minHeight: { xs: 84, md: 104 },
                ml: '-1px',
                border: 0,
                borderLeft: '1px solid var(--sf-line)',
                borderRight: '1px solid var(--sf-line)',
                borderBottom: '1px solid var(--sf-line)',
                borderRadius: 0,
                // La activa y el paso del ratón toman el fondo suave del
                // acento: el color sigue siendo el de la tienda.
                bgcolor: activa ? 'var(--accent-soft)' : 'transparent',
                cursor: 'pointer',
                font: 'inherit',
                color: 'inherit',
                textDecoration: 'none',
                transition: 'background-color .15s ease',
                '@media (hover: hover)': {
                  '&:hover': { bgcolor: 'var(--accent-soft)' },
                },
                '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: -2 },
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              }}
            >
              {conLogo ? (
                <>
                  <BrandLogo name={brand.name} url={brand.logoUrl ?? null} size={44} marco="limpio" />
                  {/* Con logotipo, el nombre pequeño debajo: no todos los
                      logotipos se leen a 44 px. */}
                  <Typography
                    sx={{
                      fontSize: TS.label,
                      fontWeight: 700,
                      textAlign: 'center',
                      color: activa ? 'var(--accent-deep)' : 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '100%',
                    }}
                  >
                    {brand.name}
                  </Typography>
                </>
              ) : (
                /**
                 * Sin logotipo, el NOMBRE es la marca: en versalitas espaciadas
                 * y en la tinta del texto. Antes era un monograma en un círculo
                 * de color, y esos colores no eran de la tienda — seis tonos que
                 * nadie eligió en una vitrina cuyo color es del comercio.
                 */
                <Typography
                  data-brand-wordmark
                  sx={{
                    fontSize: { xs: 14, md: 16 },
                    fontWeight: 500,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    textAlign: 'center',
                    lineHeight: 1.25,
                    color: activa ? 'var(--accent-deep)' : 'var(--text)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {brand.name}
                </Typography>
              )}
              {/* Y no va la cuenta de productos: en un muro de reconocimiento,
                  «12 productos» es ruido. Quien quiera ese dato lo tiene en el
                  catálogo, donde la marca sí es un filtro. */}
            </Box>
          )
        })}
      </Box>
    </Stack>
  )
}
