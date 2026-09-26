import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import RadioButtonUncheckedRoundedIcon from '@mui/icons-material/RadioButtonUncheckedRounded'
import { Box, Stack, Typography } from '@mui/material'
import { visuallyHidden } from '@mui/utils'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { R, TS } from '@/theme/tokens'
import {
  readinessSignals,
  useReadinessCounts,
  type ReadinessSignal,
  type ReadinessStoreFields,
} from './readiness'

/**
 * «Cómo se ve tu tienda»: el panel de calidad visual (Storefront V2 · P13).
 *
 * ## Qué problema resuelve
 *
 * Una tienda puede tener el orden de la portada perfecto y verse pobre. El
 * motivo casi nunca es la configuración: son treinta productos publicados sin
 * foto, las familias sin imagen y el logotipo sin subir. Eso no se ve desde esta
 * pantalla —se ve abriendo la tienda y bajando— y el comercio, que ya sabe qué
 * vende, no lo mira con los ojos de quien llega por primera vez.
 *
 * ## Las reglas del panel
 *
 *  · **Informativo, nunca bloqueante.** No impide publicar, no avisa al guardar
 *    y no aparece en rojo. Es una lista de cosas que se pueden mejorar.
 *  · **Sin nota de 0 a 100.** Una nota es una opinión con aspecto de medida:
 *    nadie sabe qué pesa cada cosa. Aquí cada línea dice su cuenta real y el
 *    resumen es cuántas señales están al día.
 *  · **Nada es obligatorio.** Una tienda puede vender sin logotipos de marca.
 *    Lo que se dice es qué efecto tiene, no que haya que hacerlo.
 *  · **Datos reales, de lo que YA se publica.** Se pregunta con el cliente
 *    anónimo, el mismo de un comprador: lo que mide es lo que se ve desde la
 *    calle. Ver `readiness.ts`.
 */

const TITULO: Record<ReadinessSignal['id'], MessageKey> = {
  logo: 'settings.readiness.logo',
  hero: 'settings.readiness.hero',
  contact: 'settings.readiness.contact',
  description: 'settings.readiness.description',
  'product-images': 'settings.readiness.productImages',
  'category-images': 'settings.readiness.categoryImages',
  'brand-logos': 'settings.readiness.brandLogos',
  pages: 'settings.readiness.pages',
}

/** Qué pasa en la vitrina si esa señal no está. Nunca «es obligatorio». */
const PORQUE: Record<ReadinessSignal['id'], MessageKey> = {
  logo: 'settings.readiness.logoWhy',
  hero: 'settings.readiness.heroWhy',
  contact: 'settings.readiness.contactWhy',
  description: 'settings.readiness.descriptionWhy',
  'product-images': 'settings.readiness.productImagesWhy',
  'category-images': 'settings.readiness.categoryImagesWhy',
  'brand-logos': 'settings.readiness.brandLogosWhy',
  pages: 'settings.readiness.pagesWhy',
}

/**
 * A dónde se va a arreglar cada señal (Storefront V3 · P12).
 *
 * Un panel que dice «faltan 18 fotos de producto» y no lleva a ningún sitio
 * obliga a recordar en qué pantalla se sube una foto. Los `#hash` son pestañas
 * de esta misma página —`SectionTabs` escucha el cambio de hash— y las rutas
 * son las pantallas donde vive el dato.
 *
 * `hero` y `description` van a Marca, que es donde están la imagen de portada
 * y el resumen de la tienda; `contact` a General.
 */
const DONDE: Record<ReadinessSignal['id'], string> = {
  logo: '#branding',
  hero: '#branding',
  description: '#branding',
  contact: '#general',
  'product-images': '/app/products',
  'category-images': '/app/categories',
  'brand-logos': '/app/pim',
  pages: '/app/content',
}

/**
 * Resumen v2 · El orden de lo pendiente: lo que más se nota al entrar, primero.
 * Una tienda con 140 recuadros grises en el catálogo tiene un problema más
 * visible que una sin logotipos de marca.
 */
const PRIORIDAD: readonly ReadinessSignal['id'][] = [
  'product-images',
  'hero',
  'logo',
  'category-images',
  'description',
  'contact',
  'brand-logos',
  'pages',
]

/** Las que cuentan cosas enseñan «hechas de totales»; las de sí o no, no. */
const CUENTA: ReadonlySet<ReadinessSignal['id']> = new Set<ReadinessSignal['id']>([
  'product-images',
  'category-images',
  'brand-logos',
])

export function StoreReadiness({
  storeId,
  storeSlug,
  store,
}: {
  storeId: string | null
  storeSlug: string | null
  store: ReadinessStoreFields
}) {
  const { t } = useI18n()
  const cuentas = useReadinessCounts(storeId, storeSlug)

  // Mientras no hay cuentas, las señales del formulario ya se pueden calcular:
  // el logotipo y el contacto no dependen de ninguna consulta. Enseñar media
  // lista es más útil que enseñar un cargador donde luego habrá siete líneas.
  const señales = readinessSignals(store, {
    products: 0,
    productsWithImage: 0,
    rootCategories: 0,
    rootCategoriesWithImage: 0,
    brands: 0,
    brandsWithLogo: 0,
    pages: 0,
    ...(cuentas.data ?? {}),
  })

  const alDia = señales.filter((s) => s.state === 'ok').length
  /**
   * Resumen v2 · Lo que falta, primero y ORDENADO por lo que más se nota al
   * entrar; lo que ya está, al final y en pequeño. Antes eran ocho tarjetas
   * iguales y lo resuelto ocupaba lo mismo que lo pendiente.
   */
  const pendientes = señales
    .filter((s) => s.state !== 'ok')
    .sort((a, b) => PRIORIDAD.indexOf(a.id) - PRIORIDAD.indexOf(b.id))
  const listas = señales.filter((s) => s.state === 'ok')

  return (
    <Stack component="section" aria-label={t('settings.readiness.title')} spacing={1.5}>
      {/* El resumen es una CUENTA, no una nota: el anillo dice «5/8» —se
          comprueba mirando la lista— y no un porcentaje. */}
      <Stack
        direction="row"
        sx={{ alignItems: 'center', gap: 2, p: 1.5, borderRadius: `${R.lg}px`, bgcolor: 'var(--neutral-soft)' }}
      >
        <Box
          aria-hidden
          sx={{
            width: 64,
            height: 64,
            flexShrink: 0,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            background: `conic-gradient(var(--accent) ${(alDia / Math.max(señales.length, 1)) * 360}deg, var(--border) 0deg)`,
          }}
        >
          <Box
            sx={{
              width: 50,
              height: 50,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              bgcolor: 'var(--card)',
              fontSize: 15,
              fontWeight: 800,
            }}
          >
            {`${alDia}/${señales.length}`}
          </Box>
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: TS.bodyStrong, fontWeight: 800 }}>
            {t('settings.readiness.summary')
              .replace('{n}', String(alDia))
              .replace('{total}', String(señales.length))}
          </Typography>
          <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>{t('settings.readiness.help')}</Typography>
        </Box>
      </Stack>

      {pendientes.length > 0 ? (
        <>
          <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--amber)' }}>
            {t('settings.readiness.pendingTitle')}
          </Typography>
          <Stack component="ul" sx={{ listStyle: 'none', m: 0, p: 0, gap: 0.75 }}>
            {pendientes.map((señal) => {
              const cuenta = CUENTA.has(señal.id) && señal.total > 0
              return (
                <Stack
                  key={señal.id}
                  component="li"
                  direction="row"
                  data-readiness={señal.id}
                  data-state={señal.state}
                  sx={{ gap: 1.25, alignItems: 'flex-start', p: 1.25, borderRadius: `${R.md}px`, border: '1px solid var(--border)', bgcolor: 'var(--card)' }}
                >
                  <Box aria-hidden sx={{ display: 'flex', mt: '2px', color: 'var(--muted)' }}>
                    <RadioButtonUncheckedRoundedIcon fontSize="small" />
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Stack direction="row" sx={{ gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <Typography sx={{ fontSize: TS.body, fontWeight: 700 }}>{t(TITULO[señal.id])}</Typography>
                      {/* El estado, en texto y no solo en color. */}
                      <Typography sx={{ fontSize: TS.label, fontWeight: 800, color: 'var(--muted)' }}>
                        {t('settings.readiness.todo')}
                      </Typography>
                      {cuenta ? (
                        <Typography sx={{ fontSize: TS.label, color: 'var(--muted)', ml: 'auto' }} className="tnum">
                          {t('settings.readiness.count')
                            .replace('{n}', String(señal.done))
                            .replace('{total}', String(señal.total))}
                        </Typography>
                      ) : null}
                    </Stack>
                    {cuenta ? (
                      <Box aria-hidden sx={{ mt: 0.75, height: 6, borderRadius: 999, bgcolor: 'var(--neutral-soft)', overflow: 'hidden' }}>
                        <Box sx={{ height: '100%', width: `${(señal.done / señal.total) * 100}%`, bgcolor: 'var(--accent)' }} />
                      </Box>
                    ) : null}
                    <Typography sx={{ fontSize: TS.label, color: 'var(--muted)', mt: 0.5 }}>{t(PORQUE[señal.id])}</Typography>
                    {/* Y a dónde se va a arreglarlo: un `<a>` de verdad (pestañas
                        de esta página o rutas), con aspecto de botón. */}
                    <Box
                      component="a"
                      href={DONDE[señal.id]}
                      data-readiness-link={señal.id}
                      sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 0.5,
                        mt: 0.75,
                        px: 1.25,
                        py: 0.5,
                        borderRadius: `${R.sm}px`,
                        border: '1px solid var(--accent)',
                        fontSize: TS.label,
                        fontWeight: 800,
                        color: 'var(--accent-deep)',
                        textDecoration: 'none',
                        '&:hover': { bgcolor: 'var(--accent-soft)' },
                      }}
                    >
                      {t('settings.readiness.goTo')}
                      <Box component="span" aria-hidden>
                        →
                      </Box>
                    </Box>
                  </Box>
                </Stack>
              )
            })}
          </Stack>
        </>
      ) : null}

      {listas.length > 0 ? (
        <>
          <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-deep)' }}>
            {t('settings.readiness.readyTitle')}
          </Typography>
          <Stack component="ul" direction="row" sx={{ listStyle: 'none', m: 0, p: 0, gap: 0.75, flexWrap: 'wrap' }}>
            {listas.map((señal) => (
              <Stack
                key={señal.id}
                component="li"
                direction="row"
                data-readiness={señal.id}
                data-state={señal.state}
                title={t(PORQUE[señal.id])}
                sx={{ alignItems: 'center', gap: 0.5, px: 1.25, py: 0.5, borderRadius: 999, bgcolor: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
              >
                <CheckCircleRoundedIcon aria-hidden sx={{ fontSize: 16 }} />
                <Typography component="span" sx={{ fontSize: TS.label, fontWeight: 800 }}>
                  {t(TITULO[señal.id])}
                </Typography>
                {/* El estado también en texto (para lector de pantalla y para
                    quien no distingue el verde): «Completo». */}
                <Box component="span" sx={visuallyHidden}>
                  {t('settings.readiness.done')}
                </Box>
                <Box component="span" sx={visuallyHidden}>
                  {t(PORQUE[señal.id])}
                </Box>
              </Stack>
            ))}
          </Stack>
        </>
      ) : null}
    </Stack>
  )
}
