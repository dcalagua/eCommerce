import FilterAltOffRoundedIcon from '@mui/icons-material/FilterAltOffRounded'
import { Card, IconButton, Stack, Tooltip } from '@mui/material'
import type { ReactNode } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'

/**
 * Barra de filtros de un listado.
 *
 * Los controles sueltos sobre el fondo de la página no se leen como un grupo:
 * parecen tres cosas que casualmente están cerca. En su propia tarjeta se leen
 * como «esto acota la tabla de abajo», que es lo que son.
 *
 * **No admite un panel multi-campo a propósito.** La regla de suite es un
 * buscador general más tabs de estado, no una fila de cajas por columna: con
 * seis campos nadie sabe cuál rellenar y el resultado vacío no dice cuál sobra.
 * Este componente coloca los controles que le pasen, y quien lo use se atiene a
 * esa regla.
 *
 * `onClear` solo aparece cuando hay algo que limpiar: un botón que no hace nada
 * enseña a no pulsarlo.
 */
export function FilterBar({
  children,
  actions,
  onClear,
}: {
  children: ReactNode
  /** Exportar y demás: van al final, separadas de los filtros. */
  actions?: ReactNode
  onClear?: () => void
}) {
  const { t } = useI18n()

  return (
    <Card sx={{ p: 1.5, mb: 2 }}>
      <Stack
        direction="row"
        spacing={1.25}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1.25 }}
      >
        {children}
        <Stack sx={{ flex: 1, minWidth: 8 }} />
        {onClear && (
          <Tooltip title={t('common.filters.clear')}>
            <IconButton
              size="small"
              onClick={onClear}
              aria-label={t('common.filters.clear')}
              sx={{ color: 'var(--muted)' }}
            >
              <FilterAltOffRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {actions}
      </Stack>
    </Card>
  )
}
