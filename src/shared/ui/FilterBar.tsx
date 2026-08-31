import FilterAltOffRoundedIcon from '@mui/icons-material/FilterAltOffRounded'
import { Card, IconButton, Stack, Tooltip } from '@mui/material'
import type { ReactNode } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'

/**
 * Barra de filtros de un listado.
 *
 * Los controles sueltos sobre el fondo de la pagina no se leen como un grupo:
 * parecen tres cosas que casualmente estan cerca. En su propia tarjeta se leen
 * como «esto acota la tabla de abajo», que es lo que son.
 *
 * **No admite un panel multi-campo a proposito.** La regla de suite es un
 * buscador general mas tabs de estado, no una fila de cajas por columna: con
 * seis campos nadie sabe cual rellenar y el resultado vacio no dice cual sobra.
 * Este componente coloca los controles que le pasen, y quien lo use se atiene a
 * esa regla.
 *
 * ## Dos zonas, y la barra decide donde va cada una
 *
 * Izquierda lo que ACOTA (buscador, selects, interruptores), derecha lo que
 * HACE (crear, exportar, limpiar). La separacion la impone la barra y no el
 * orden en que llegan los hijos: antes el boton primario se pasaba como un hijo
 * mas y quedaba pegado al ultimo filtro; si ademas el buscador llevaba `flex:1`
 * —lo hacia media docena de modulos— ese `flex` competia con el espaciador y se
 * repartian el hueco a partes iguales, dejando el boton flotando en mitad de la
 * barra.
 *
 * Por eso los filtros van en su propio grupo SIN crecer (`flex: '0 1 auto'`):
 * un `flex: 1` de un hijo ya solo reparte dentro de ese grupo, nunca contra las
 * acciones. Y las acciones se anclan con `ml: 'auto'`, que en una barra sin
 * nadie creciendo se lleva todo el hueco libre. Consecuencia practica: **el
 * boton primario va en `actions`, nunca como hijo**, y un filtro que quiera
 * ancho lo pide con `minWidth`, no con `flex`.
 *
 * `onClear` solo aparece cuando hay algo que limpiar: un boton que no hace nada
 * ensena a no pulsarlo.
 */
export function FilterBar({
  children,
  actions,
  onClear,
  disableGutter = false,
}: {
  children: ReactNode
  /** Crear, exportar y demas: ancladas a la derecha, separadas de los filtros. */
  actions?: ReactNode
  onClear?: () => void
  /** Cuando quien llama ya separa sus bloques (un `Stack` con `gap`): sin él,
   *  el margen propio se suma al del contenedor y la barra queda flotando. */
  disableGutter?: boolean
}) {
  const { t } = useI18n()

  return (
    <Card sx={{ p: 1.5, mb: disableGutter ? 0 : 2 }}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', gap: 1.25, flexWrap: 'wrap', rowGap: 1.25 }}
      >
        <Stack
          direction="row"
          sx={{
            alignItems: 'center',
            gap: 1.25,
            flexWrap: 'wrap',
            rowGap: 1.25,
            // Sin crecer: lo que un filtro pida con `flex` se reparte aqui
            // dentro y no contra las acciones de la derecha.
            flex: '0 1 auto',
            minWidth: 0,
          }}
        >
          {children}
        </Stack>
        {(onClear || actions) && (
          <Stack
            direction="row"
            sx={{ alignItems: 'center', gap: 1, flexShrink: 0, ml: 'auto' }}
          >
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
        )}
      </Stack>
    </Card>
  )
}
