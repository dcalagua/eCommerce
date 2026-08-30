import { IconButton, Stack, Tooltip } from '@mui/material'
import type { ReactNode } from 'react'

export type RowActionTone = 'neutral' | 'accent' | 'danger'

export interface RowAction {
  id: string
  icon: ReactNode
  /** Se usa como `aria-label` y como texto del tooltip: un icono solo no nombra. */
  label: string
  tone?: RowActionTone
  disabled?: boolean
  onClick: () => void
}

/**
 * Acciones al final de una fila.
 *
 * **El color lo pone lo que la acción HACE, no la fila.** Editar es neutro,
 * publicar o aprobar van en el acento, y lo que quita algo —desactivar, anular,
 * borrar— va en rojo. Así el rojo significa siempre lo mismo en toda la app y
 * quien recorre una tabla sabe dónde está el botón peligroso sin leerlo.
 *
 * Cada acción lleva `aria-label` y tooltip con el mismo texto: un icono a solas
 * no dice qué hace, y adivinarlo antes de pulsar no es una opción cuando una de
 * las opciones es destructiva.
 *
 * **`stopPropagation` es obligatorio**: la fila entera suele ser pulsable, y sin
 * esto pulsar «desactivar» abriría además el detalle. Se hace aquí y no en cada
 * llamada para que no se pueda olvidar.
 */
export function RowActions({ actions }: { actions: RowAction[] }) {
  const colors: Record<RowActionTone, string> = {
    neutral: 'var(--muted)',
    accent: 'var(--accent-deep)',
    danger: 'var(--red)',
  }

  return (
    <Stack direction="row" spacing={0.25} sx={{ justifyContent: 'flex-end' }}>
      {actions.map((action) => (
        <Tooltip key={action.id} title={action.label}>
          {/* El `span` mantiene el tooltip cuando el botón está deshabilitado:
              un botón inerte no dispara eventos de ratón. */}
          <span>
            <IconButton
              size="small"
              disabled={action.disabled ?? false}
              aria-label={action.label}
              onClick={(event) => {
                event.stopPropagation()
                action.onClick()
              }}
              sx={{
                color: colors[action.tone ?? 'neutral'],
                '&:hover': { bgcolor: 'var(--neutral-soft)' },
              }}
            >
              {action.icon}
            </IconButton>
          </span>
        </Tooltip>
      ))}
    </Stack>
  )
}
