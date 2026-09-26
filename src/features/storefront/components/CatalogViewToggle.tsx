import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded'
import ViewListRoundedIcon from '@mui/icons-material/ViewListRounded'
import { ToggleButton, ToggleButtonGroup } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { CatalogView } from './ProductGrid'

/**
 * Rejilla o lista. Dos iconos con nombre: el icono solo no dice nada a un
 * lector de pantalla, y «vista de lista» sí.
 */
export function CatalogViewToggle({
  value,
  onChange,
}: {
  value: CatalogView
  onChange: (view: CatalogView) => void
}) {
  const { t } = useI18n()
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={value}
      aria-label={t('store.catalog.view.label')}
      onChange={(_, next: CatalogView | null) => next && onChange(next)}
      sx={{
        bgcolor: 'var(--card)',
        '& .MuiToggleButton-root': {
          px: 1,
          py: 0.5,
          borderColor: 'var(--sf-line-strong, var(--border))',
          color: 'var(--muted)',
          '&.Mui-selected, &.Mui-selected:hover': { bgcolor: 'var(--text)', color: 'var(--card)' },
        },
      }}
    >
      <ToggleButton value="grid" aria-label={t('store.catalog.view.grid')} title={t('store.catalog.view.grid')}>
        <GridViewRoundedIcon fontSize="small" />
      </ToggleButton>
      <ToggleButton value="list" aria-label={t('store.catalog.view.list')} title={t('store.catalog.view.list')}>
        <ViewListRoundedIcon fontSize="small" />
      </ToggleButton>
    </ToggleButtonGroup>
  )
}
