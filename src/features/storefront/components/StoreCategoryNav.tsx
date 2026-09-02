import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import { Box, Container, Stack, Typography } from '@mui/material'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { TS } from '@/theme/tokens'
import { iconoDe } from '../categoryIcon'
import { tintFor } from '../tint'
import type { PublicCategory } from '../types'

interface Nodo {
  readonly category: PublicCategory
  readonly children: readonly PublicCategory[]
}

/**
 * Las familias de primer nivel, con lo que cuelga de cada una.
 *
 * Se arma sobre las categorías que la vitrina ya tiene cargadas: una pasada por
 * el array, ninguna consulta más. `public_categories` solo trae las alcanzables
 * —activas y con todos sus ancestros activos—, así que lo que llega se enseña.
 */
function arbol(categories: readonly PublicCategory[]): Nodo[] {
  const raices = categories.filter((category) => category.parent_id === null)
  return raices.map((category) => ({
    category,
    children: categories.filter((hija) => hija.parent_id === category.category_id),
  }))
}

/**
 * La barra de familias, bajo la cabecera.
 *
 * ## Por qué aquí y no en la portada
 *
 * Las categorías eran una fila de azulejos a media página: para cambiar de
 * familia había que volver arriba, y desde una ficha de producto no había forma
 * de llegar. En la cabecera están en TODAS las pantallas de la tienda, que es
 * lo que hace una botica de verdad.
 *
 * ## Por qué un panel y no un enlace directo
 *
 * Una familia con cuarenta subcategorías no cabe en una píldora. El panel
 * enseña de una vez todo lo que hay dentro —que es la pregunta real, «¿qué
 * tenéis de esto?»— y desde ahí se entra al nivel concreto en un solo clic, sin
 * pasar por una pantalla intermedia que solo lista más categorías.
 *
 * ## En móvil no hay panel
 *
 * Un desplegable de tres columnas en 380 px es una pantalla entera de enlaces
 * de 12 px. Ahí la familia es un enlace directo y las subcategorías se eligen
 * en el panel de filtros del catálogo, que ya existe y ya funciona con el dedo.
 */
export function StoreCategoryNav({
  storeSlug,
  categories,
  showOffers = false,
}: {
  storeSlug: string
  categories: readonly PublicCategory[]
  /**
   * ¿Hay campañas vivas a las que llevar?
   *
   * Lo decide quien monta la barra, no ella: esta pieza pinta lo que le dan y
   * no consulta nada — es lo que la deja probarse sin montar medio árbol. Y un
   * enlace a una sección que no está en la página es peor que no tenerlo.
   */
  showOffers?: boolean
}) {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const seleccionada = params.get('c')
  const [abierta, setAbierta] = useState<string | null>(null)
  const contenedor = useRef<HTMLDivElement | null>(null)

  const familias = arbol(categories)

  // Cerrar con Escape y al pulsar fuera. Un panel que solo se cierra volviendo
  // a pulsar su propia pestaña es una trampa con el teclado.
  useEffect(() => {
    if (!abierta) return

    const alPulsarFuera = (event: MouseEvent) => {
      if (!contenedor.current?.contains(event.target as Node)) setAbierta(null)
    }
    const alTeclear = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAbierta(null)
    }

    document.addEventListener('mousedown', alPulsarFuera)
    document.addEventListener('keydown', alTeclear)
    return () => {
      document.removeEventListener('mousedown', alPulsarFuera)
      document.removeEventListener('keydown', alTeclear)
    }
  }, [abierta])

  // Al cambiar de categoría el panel sobra: ya se está viendo el resultado.
  useEffect(() => setAbierta(null), [seleccionada])

  if (familias.length === 0) return null

  return (
    <Box
      ref={contenedor}
      sx={{ position: 'relative', borderTop: '1px solid var(--sf-line)', bgcolor: 'var(--card)' }}
    >
      <Container maxWidth="lg" disableGutters>
        <Stack
          component="nav"
          direction="row"
          aria-label={t('store.categories.title')}
          sx={{
            gap: { xs: 1.5, md: 2.5 },
            px: { xs: 2, md: 3 },
            py: 0.75,
            overflowX: 'auto',
            scrollbarWidth: 'none',
            '&::-webkit-scrollbar': { display: 'none' },
          }}
        >
          {familias.map(({ category, children }) => {
            const Icono = iconoDe(category.name)
            const tinte = tintFor(category.name)
            const activa = seleccionada === category.slug
            const desplegable = children.length > 0

            return (
              <Box
                key={category.category_id}
                component={desplegable ? 'button' : Link}
                type={desplegable ? 'button' : undefined}
                to={desplegable ? undefined : `/s/${storeSlug}?c=${encodeURIComponent(category.slug)}`}
                aria-expanded={desplegable ? abierta === category.slug : undefined}
                aria-current={activa ? 'true' : undefined}
                onClick={
                  desplegable
                    ? () => setAbierta((previa) => (previa === category.slug ? null : category.slug))
                    : undefined
                }
                sx={{
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.75,
                  px: 0.5,
                  py: 0.75,
                  border: 0,
                  bgcolor: 'transparent',
                  cursor: 'pointer',
                  textDecoration: 'none',
                  fontSize: 13.5,
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  color: activa || abierta === category.slug ? tinte.fg : 'var(--text)',
                  borderBottom:
                    activa || abierta === category.slug
                      ? `2px solid ${tinte.fg}`
                      : '2px solid transparent',
                  '&:hover': { color: tinte.fg },
                }}
              >
                <Box
                  aria-hidden
                  sx={{
                    width: 24,
                    height: 24,
                    flexShrink: 0,
                    display: 'grid',
                    placeItems: 'center',
                    borderRadius: '50%',
                    bgcolor: tinte.bg,
                    color: tinte.fg,
                  }}
                >
                  <Icono sx={{ fontSize: 15 }} />
                </Box>
                {category.name}
                {desplegable ? (
                  <ExpandMoreRoundedIcon
                    aria-hidden
                    sx={{
                      fontSize: 16,
                      opacity: 0.6,
                      display: { xs: 'none', md: 'block' },
                      transform: abierta === category.slug ? 'rotate(180deg)' : 'none',
                      transition: 'transform .15s ease',
                      '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                    }}
                  />
                ) : null}
              </Box>
            )
          })}

          {/* Dos puertas que no son categorías: la oferta y la marca.
              Van al FINAL y separadas por una línea fina — si se mezclaran con
              las familias, «Ofertas» parecería una categoría más del catálogo, y
              no lo es: es un corte transversal.

              «Ofertas» solo aparece si hay campañas vivas. Un enlace que lleva a
              una sección que no está en la página es peor que no tenerlo, y esa
              consulta es la MISMA que ya hizo la portada — misma clave de
              TanStack, cero peticiones nuevas. */}
          {showOffers ? <PuertaFija to={`/s/${storeSlug}#ofertas`} label={t('store.nav.offers')} /> : null}
          <PuertaFija to={`/s/${storeSlug}?ver=todo#marcas`} label={t('store.nav.brands')} />
        </Stack>
      </Container>

      {familias.map(({ category, children }) =>
        abierta === category.slug && children.length > 0 ? (
          <Box
            key={`panel-${category.category_id}`}
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: '100%',
              zIndex: 3,
              // En móvil el panel no se abre: la familia navega directa.
              display: { xs: 'none', md: 'block' },
              bgcolor: 'var(--card)',
              borderTop: '1px solid var(--sf-line)',
              borderBottom: '1px solid var(--sf-line)',
              boxShadow: 'var(--sf-shadow-hover)',
              maxHeight: '70vh',
              overflowY: 'auto',
            }}
          >
            <Container maxWidth="lg" sx={{ py: 2.5 }}>
              <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1.5, mb: 1.5 }}>
                <Typography
                  component="h2"
                  sx={{ fontSize: 15, fontWeight: 800, color: tintFor(category.name).fg }}
                >
                  {category.name}
                </Typography>
                {/* La familia entera, que es lo que no se puede pedir desde la
                    lista de hijas: alguien que busca «algo de nutrición» sin
                    saber cuál. */}
                <Box
                  component={Link}
                  to={`/s/${storeSlug}?c=${encodeURIComponent(category.slug)}`}
                  sx={{
                    fontSize: TS.label,
                    fontWeight: 700,
                    color: 'var(--muted)',
                    textDecoration: 'none',
                    '&:hover': { color: 'var(--accent-deep)', textDecoration: 'underline' },
                  }}
                >
                  {t('store.categories.seeWhole')}
                </Box>
              </Stack>

              <Box
                sx={{
                  display: 'grid',
                  gap: 0.5,
                  columnGap: 3,
                  gridTemplateColumns: {
                    md: 'repeat(3, minmax(0, 1fr))',
                    lg: 'repeat(4, minmax(0, 1fr))',
                  },
                }}
              >
                {children.map((hija) => (
                  <Box
                    key={hija.category_id}
                    component={Link}
                    to={`/s/${storeSlug}?c=${encodeURIComponent(hija.slug)}`}
                    sx={{
                      py: 0.5,
                      fontSize: 13.5,
                      color: 'var(--text)',
                      textDecoration: 'none',
                      '&:hover': { color: 'var(--accent-deep)', textDecoration: 'underline' },
                    }}
                  >
                    {hija.name}
                  </Box>
                ))}
              </Box>
            </Container>
          </Box>
        ) : null,
      )}
    </Box>
  )
}

/**
 * Una entrada de navegación que no es una categoría.
 *
 * Sin icono ni tinte a propósito: los tintes de la barra identifican FAMILIAS
 * del catálogo, y darle uno a «Ofertas» la disfrazaría de familia. Lo que la
 * distingue es el peso y el color de acento, que es el idioma de la acción en
 * el resto de la tienda.
 */
function PuertaFija({ to, label }: { to: string; label: string }) {
  return (
    <Box
      component={Link}
      to={to}
      sx={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        py: 0.75,
        px: 0.5,
        ml: 0.5,
        borderLeft: '1px solid var(--sf-line)',
        pl: 2,
        textDecoration: 'none',
        fontSize: 13.5,
        fontWeight: 800,
        whiteSpace: 'nowrap',
        color: 'var(--accent-deep)',
        borderBottom: '2px solid transparent',
        '&:hover': { borderBottomColor: 'var(--accent)' },
      }}
    >
      {label}
    </Box>
  )
}
