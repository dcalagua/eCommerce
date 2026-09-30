import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import { Badge, Box, Button, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import { TS } from '@/theme/tokens'

/** Un filtro puesto, con la forma en que se quita. */
export interface FiltroActivo {
  readonly id: string
  readonly label: string
  readonly onRemove: () => void
}

/**
 * La barra del catálogo: cuántos hay, cómo se ordenan y cómo se filtran.
 *
 * ## El problema que resuelve, y era grave en el teléfono
 *
 * El catálogo ponía el panel de filtros en una columna que en escritorio va al
 * lado y en el teléfono va **encima**: al entrar desde una búsqueda, lo primero
 * que se veía era una lista de marcas y familias con sus interruptores, y los
 * productos empezaban pasada la primera pantalla. Quien busca «jarabe» quiere
 * ver jarabes, no elegir por dónde empezar a filtrar.
 *
 * Aquí el teléfono recibe lo mismo que recibe una tienda de verdad: una barra
 * con **Filtros** y **Ordenar**, y los productos justo debajo. El panel entero
 * sigue existiendo —no se recorta ninguna opción— pero se abre cuando se pide.
 *
 * ## Las decisiones
 *
 * **El contador de filtros va en el botón.** Un botón que dice «Filtros» no
 * distingue entre un catálogo entero y uno con tres filtros puestos, y esa es
 * justo la duda de quien vuelve atrás y no reconoce los resultados.
 *
 * **Las píldoras de lo puesto van junto al contador, y se quitan de una.** Abrir
 * un cajón para desmarcar una casilla es tres gestos para deshacer uno. Desde el
 * Resumen v2 se pintan también en escritorio, como en el diseño: dicen de un
 * vistazo por qué hay 48 resultados y no 568.
 *
 * **Se queda pegada arriba en el teléfono**, bajo la cabecera, porque en una
 * lista de 568 productos el momento de querer ordenar o filtrar llega cuando ya
 * se ha bajado, y volver a subir a por la barra es perder el sitio.
 *
 * **El conteo es el de los RESULTADOS y nada más.** Ni recomendados, ni
 * sugerencias, ni lo que enseñe la salida de abajo: lo que dice el buscador que
 * cumple el filtro.
 */
/**
 * Un filtro puesto: un BOTÓN, y su nombre dice lo que hace: «Quitar Mesas».
 *
 * La primera versión era un `Chip` con su aspa, y el nombre accesible que
 * quedaba era «Mesas» — el mismo que la píldora de la barra de familias, que
 * hace lo contrario. Dos controles con el mismo nombre y efectos opuestos en la
 * misma pantalla no se distinguen ni con un lector de pantalla ni con el teclado.
 */
function ChipDeFiltro({ filtro, etiquetaQuitar }: { filtro: FiltroActivo; etiquetaQuitar: string }) {
  return (
    <Box
      component="button"
      type="button"
      onClick={filtro.onRemove}
      aria-label={`${etiquetaQuitar} ${filtro.label}`}
      data-active-filter={filtro.id}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        height: 28,
        px: 1.25,
        borderRadius: 'var(--sf-pill)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: TS.label,
        fontWeight: 700,
        bgcolor: 'var(--accent-soft)',
        color: 'var(--accent-deep)',
        border: '1px solid var(--accent)',
        '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: 2 },
      }}
    >
      {filtro.label}
      <CloseRoundedIcon aria-hidden sx={{ fontSize: 15 }} />
    </Box>
  )
}

export function StoreCatalogToolbar({
  count,
  note,
  sortMenu,
  viewToggle,
  activeFilters,
  onOpenFilters,
  onClearFilters,
  filtersEverywhere = false,
  quick,
}: {
  /** Ya formateado por quien sabe si es «1 resultado» o «24 resultados». */
  count: ReactNode
  /** Aviso sobre el resultado —tolerancia a erratas—, si lo hay. */
  note?: ReactNode
  sortMenu: ReactNode
  /** Rejilla o lista. Opcional: fuera del catálogo no hay a qué cambiar. */
  viewToggle?: ReactNode
  activeFilters: readonly FiltroActivo[]
  /** Abre el cajón. Solo se pinta el botón si hay quien lo atienda. */
  onOpenFilters?: () => void
  onClearFilters?: () => void
  /**
   * Rediseño v3 · El botón «Filtros» también en escritorio. Retail no tiene
   * columna de filtros (lámina de catálogo): el MISMO panel se abre en el cajón.
   */
  filtersEverywhere?: boolean
  /** Rediseño v3 · Un atajo junto al contador («Solo en oferta» en retail). */
  quick?: ReactNode
}) {
  const { t } = useI18n()
  const puestos = activeFilters.length

  return (
    <Stack
      data-catalog-toolbar={puestos}
      className="sf-plp-toolbar"
      sx={{
        gap: 1,
        mb: 2,
        // Pegada arriba SOLO en el teléfono: en escritorio la barra convive con
        // el panel lateral, que ya es pegajoso, y dos cosas pegadas a la vez
        // dejan la rejilla mirando por una rendija.
        position: { xs: 'sticky', md: 'static' },
        top: { xs: 'var(--sf-anchor-offset, 96px)' },
        zIndex: 2,
        // El fondo es obligatorio: sin él, los productos pasan por detrás.
        bgcolor: 'var(--bg)',
        py: { xs: 1, md: 0 },
      }}
    >
      <Stack
        direction="row"
        sx={{ gap: 1.5, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}
      >
        <Stack direction="row" sx={{ gap: 1, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          {/* Resumen v2 · El contador en texto, como en el diseño: «48 ofertas». */}
          <Typography aria-live="polite" className="sf-plp-toolbar-count" sx={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
            {count}
          </Typography>
          {note}
          {quick}
          {/* Los filtros puestos en la MISMA línea, con su aspa, como en el
              diseño. UNA sola fila para todos los anchos: dos copias —una por
              ancho, escondidas con CSS— duplicaban cada botón en el árbol de
              accesibilidad. En el teléfono la línea simplemente se parte. */}
          {puestos > 0 ? (
            <Stack direction="row" data-active-filters={puestos} sx={{ gap: 0.75, flexWrap: 'wrap', alignItems: 'center' }}>
              {activeFilters.map((filtro) => (
                <ChipDeFiltro key={filtro.id} filtro={filtro} etiquetaQuitar={t('store.catalog.removeFilter')} />
              ))}
              {onClearFilters && puestos > 1 ? (
                <Box
                  component="button"
                  type="button"
                  onClick={onClearFilters}
                  sx={{
                    border: 'none',
                    bgcolor: 'transparent',
                    cursor: 'pointer',
                    px: 1,
                    fontSize: TS.label,
                    fontWeight: 800,
                    color: 'var(--muted)',
                    textDecoration: 'underline',
                    display: filtersEverywhere ? 'inline' : { md: 'none' },
                  }}
                >
                  {t('store.catalog.clear')}
                </Box>
              ) : null}
            </Stack>
          ) : null}
        </Stack>

        <Stack direction="row" sx={{ gap: 1, alignItems: 'center' }}>
          {onOpenFilters ? (
            <Badge
              badgeContent={puestos}
              color="primary"
              // El cero no se pinta: un globo con un cero es ruido.
              invisible={puestos === 0}
              sx={{ display: filtersEverywhere ? 'inline-flex' : { md: 'none' } }}
            >
              <Button
                variant="outlined"
                size="small"
                startIcon={<TuneRoundedIcon fontSize="small" />}
                onClick={onOpenFilters}
                aria-label={
                  puestos > 0
                    ? `${t('store.catalog.filters')} (${puestos} ${t('store.catalog.filtersActive')})`
                    : t('store.catalog.filters')
                }
                sx={{
                  textTransform: 'none',
                  fontWeight: 700,
                  borderRadius: 'var(--sf-pill)',
                  borderColor: puestos > 0 ? 'var(--accent)' : 'var(--sf-line-strong)',
                  color: puestos > 0 ? 'var(--accent-deep)' : 'var(--text)',
                }}
              >
                {t('store.catalog.filters')}
              </Button>
            </Badge>
          ) : null}
          {sortMenu}
          {viewToggle}
        </Stack>
      </Stack>
    </Stack>
  )
}
