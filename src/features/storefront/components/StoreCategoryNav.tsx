import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import ChildCareRoundedIcon from '@mui/icons-material/ChildCareRounded'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import ElderlyRoundedIcon from '@mui/icons-material/ElderlyRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import HealingRoundedIcon from '@mui/icons-material/HealingRounded'
import LocalPharmacyRoundedIcon from '@mui/icons-material/LocalPharmacyRounded'
import MedicalServicesRoundedIcon from '@mui/icons-material/MedicalServicesRounded'
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded'
import PsychologyRoundedIcon from '@mui/icons-material/PsychologyRounded'
import SanitizerRoundedIcon from '@mui/icons-material/SanitizerRounded'
import SpaRoundedIcon from '@mui/icons-material/SpaRounded'
import VaccinesRoundedIcon from '@mui/icons-material/VaccinesRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import WaterDropRoundedIcon from '@mui/icons-material/WaterDropRounded'
import { Box, Container, Stack, Typography } from '@mui/material'
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { T } from '@/theme/tokens'
import { tintFor } from '../tint'
import type { PublicCategory } from '../types'

/**
 * La cara de cada familia.
 *
 * Se elige por PALABRA del nombre: el comercio no tiene dónde declarar un
 * icono, y pedirle que lo rellene para que su tienda no se vea gris es cobrarle
 * nuestro problema. Sin coincidencia va el icono genérico — aquí sí, porque en
 * una barra de ocho entradas el hueco vacío descuadra la fila entera.
 */
const ICONOS: readonly (readonly [readonly string[], ComponentType<{ sx?: object }>])[] = [
  [['medicamento', 'farmac', 'etico', 'generico', 'drug'], LocalPharmacyRoundedIcon],
  [['vitamina', 'suplemento', 'nutric', 'vitamin'], VaccinesRoundedIcon],
  [['dermo', 'cosmet', 'piel', 'facial', 'skin'], SpaRoundedIcon],
  [['bebe', 'infantil', 'nino', 'mama', 'baby'], ChildCareRoundedIcon],
  [['adulto mayor', 'geriatr', 'senior'], ElderlyRoundedIcon],
  [['dispositivo', 'equipo', 'instrumental', 'device'], MedicalServicesRoundedIcon],
  [['higiene', 'limpieza', 'antisep', 'hygiene'], SanitizerRoundedIcon],
  [['belleza', 'maquillaje', 'beauty'], SpaRoundedIcon],
  [['afeitad', 'cabello', 'capilar', 'shav', 'hair'], ContentCutRoundedIcon],
  [['cuidado', 'personal', 'care'], HealingRoundedIcon],
  [['cardio', 'presion', 'corazon', 'diabet', 'heart'], MonitorHeartRoundedIcon],
  [['nervioso', 'neuro', 'psiq', 'sueno', 'nerve'], PsychologyRoundedIcon],
  [['desodorante', 'antitranspirante', 'deo'], WaterDropRoundedIcon],
  [['ocular', 'oftalm', 'ojo', 'vision', 'eye'], VisibilityRoundedIcon],
]

function iconoDe(nombre: string): ComponentType<{ sx?: object }> {
  const limpio = nombre
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  for (const [palabras, Icono] of ICONOS) {
    if (palabras.some((palabra) => limpio.includes(palabra))) return Icono
  }
  return CategoryRoundedIcon
}

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
}: {
  storeSlug: string
  categories: readonly PublicCategory[]
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
                    fontSize: T.label,
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
