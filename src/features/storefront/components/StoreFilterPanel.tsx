import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import {
  Box,
  Button,
  Card,
  Checkbox,
  Collapse,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from '@mui/material'
import { useState, type ReactNode } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import { TS } from '@/theme/tokens'

export interface FacetOption {
  /** Slug de categoría o código de marca. `null` no se pinta: no se puede filtrar por nada. */
  code: string | null
  name: string | null
  /**
   * `null` = no se sabe, y entonces NO se enseña número.
   *
   * Hace falta porque el buscador calcula las facetas sobre el resultado YA
   * filtrado: en cuanto hay una categoría elegida, las demás salen a cero. Un
   * cero ahí no significa «no hay nada», significa «no te lo he contado», y
   * pintarlo haría que el panel mintiera justo cuando más se mira.
   */
  count: number | null
}

/** Cuántas opciones se ven antes de «mostrar todo». */
const VISIBLE = 8

/**
 * Panel de filtros de la vitrina.
 *
 * **Esto NO contradice la regla de suite «un buscador general, no paneles de
 * filtros multi-campo».** Esa regla es del BACKOFFICE, donde quien trabaja
 * conoce el dato que busca y una fila de seis cajas solo le hace adivinar cuál
 * rellenar. Aquí el visitante no sabe qué hay en el catálogo: las facetas son
 * la forma de enseñárselo, y por eso cada opción lleva su CONTADOR — un filtro
 * que no dice cuántos resultados deja es una apuesta a ciegas.
 *
 * Las opciones salen de las facetas que devuelve el buscador con la consulta
 * actual, no de una lista fija de marcas y categorías. Es lo que evita el
 * callejón sin salida clásico: marcar un filtro y llegar a cero resultados.
 * Aquí lo que da cero ni siquiera aparece.
 *
 * El estado vive en la URL (lo pone quien usa el panel, no el panel): una
 * búsqueda filtrada se comparte y el botón de atrás hace lo que se espera.
 */
export function StoreFilterPanel({
  brands,
  categories,
  selectedBrand,
  selectedCategory,
  inStockOnly,
  onBrand,
  onCategory,
  onInStock,
  onClear,
}: {
  brands: readonly FacetOption[]
  categories: readonly FacetOption[]
  selectedBrand: string | null
  selectedCategory: string | null
  inStockOnly: boolean
  onBrand: (code: string | null) => void
  onCategory: (slug: string | null) => void
  onInStock: (only: boolean) => void
  onClear: () => void
}) {
  const { t } = useI18n()
  const dirty = Boolean(selectedBrand || selectedCategory || inStockOnly)

  return (
    <Card
      component="aside"
      aria-label={t('store.filter.title')}
      sx={{
        p: 2.25,
        borderRadius: 'var(--sf-radius)',
        border: '1px solid var(--sf-line)',
        boxShadow: 'var(--sf-shadow)',
        position: { md: 'sticky' },
        top: { md: 88 },
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography component="h2" sx={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.01em' }}>
          {t('store.filter.title')}
        </Typography>
        {/* Solo cuando hay algo que quitar: un botón que no hace nada enseña a
            no pulsarlo. */}
        {dirty && (
          <Button size="small" onClick={onClear} sx={{ textTransform: 'none', fontWeight: 700 }}>
            {t('store.catalog.clear')}
          </Button>
        )}
      </Stack>

      <FormControlLabel
        sx={{ mb: 1 }}
        control={
          <Switch
            size="small"
            checked={inStockOnly}
            onChange={(event) => onInStock(event.target.checked)}
          />
        }
        label={
          <Typography sx={{ fontSize: TS.body, fontWeight: 700 }}>
            {t('store.filter.inStock')}
          </Typography>
        }
      />

      <FacetGroup title={t('store.filter.brand')}>
        {brands.map((option) => (
          <FacetRow
            key={option.code ?? option.name ?? ''}
            option={option}
            checked={selectedBrand === option.code}
            onToggle={() => onBrand(selectedBrand === option.code ? null : option.code)}
          />
        ))}
      </FacetGroup>

      <FacetGroup title={t('store.filter.category')}>
        {categories.map((option) => (
          <FacetRow
            key={option.code ?? option.name ?? ''}
            option={option}
            checked={selectedCategory === option.code}
            onToggle={() => onCategory(selectedCategory === option.code ? null : option.code)}
          />
        ))}
      </FacetGroup>
    </Card>
  )
}

/**
 * Un grupo plegable con su lista recortada.
 *
 * Con más de ocho opciones se recorta y aparece «mostrar todo»: una barra
 * lateral de cuarenta marcas empuja el catálogo fuera de la pantalla, que es
 * justo lo que la persona vino a mirar.
 */
function FacetGroup({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)
  const [all, setAll] = useState(false)

  const items = Array.isArray(children) ? (children as ReactNode[]).filter(Boolean) : [children]
  if (items.length === 0) return null

  const shown = all ? items : items.slice(0, VISIBLE)

  return (
    <Box sx={{ borderTop: '1px solid var(--sf-line)', pt: 1.5, mt: 1.5 }}>
      <Stack
        component="button"
        type="button"
        direction="row"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        sx={{
          width: '100%',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'none',
          border: 0,
          p: 0,
          cursor: 'pointer',
          font: 'inherit',
          color: 'inherit',
        }}
      >
        <Typography
          component="h3"
          sx={{
            fontSize: TS.label,
            fontWeight: 800,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
          }}
        >
          {title}
        </Typography>
        {open ? (
          <ExpandLessRoundedIcon sx={{ fontSize: 20, color: 'var(--muted)' }} />
        ) : (
          <ExpandMoreRoundedIcon sx={{ fontSize: 20, color: 'var(--muted)' }} />
        )}
      </Stack>

      <Collapse in={open} unmountOnExit>
        <Stack sx={{ mt: 0.5 }}>{shown}</Stack>
        {items.length > VISIBLE && (
          <Button
            size="small"
            onClick={() => setAll((value) => !value)}
            sx={{ mt: 0.5, textTransform: 'none', fontWeight: 800, px: 0 }}
          >
            {all ? t('store.filter.showLess') : t('store.filter.showAll')}
          </Button>
        )}
      </Collapse>
    </Box>
  )
}

/**
 * Una opción con su contador.
 *
 * El número va SIEMPRE, y por eso es texto y no un adorno: es la diferencia
 * entre elegir un filtro y adivinarlo. Va dentro del `label` de la casilla para
 * que un lector de pantalla anuncie «Sillas, 20» y no solo «Sillas».
 */
function FacetRow({
  option,
  checked,
  onToggle,
}: {
  option: FacetOption
  checked: boolean
  onToggle: () => void
}) {
  if (!option.code) return null

  return (
    <FormControlLabel
      sx={{ ml: -0.75, mr: 0, '& .MuiFormControlLabel-label': { minWidth: 0, flex: 1 } }}
      control={<Checkbox size="small" checked={checked} onChange={onToggle} />}
      label={
        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, minWidth: 0 }}>
          <Typography
            sx={{
              fontSize: TS.body,
              fontWeight: checked ? 800 : 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {option.name ?? option.code}
          </Typography>
          {option.count !== null && (
            <Typography sx={{ fontSize: TS.label, color: 'var(--muted)', flexShrink: 0 }}>
              ({option.count})
            </Typography>
          )}
        </Stack>
      }
    />
  )
}
