import { IconButton, Stack, Tooltip } from '@mui/material'
import type { ReactNode } from 'react'
import { R } from '@/theme/tokens'

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
 *
 * ## El botón se ve como un botón
 *
 * Un glifo suelto de color no parece pulsable: parece un adorno de la fila. Cada
 * acción tiene caja propia de 30×30 —objetivo táctil real, no un icono de 16 px
 * que hay que cazar— y al pasar por encima aparece el fondo **de su propio
 * tono**: rojo suave en lo que borra, acento en lo que aprueba. Así la
 * advertencia llega antes del clic y no después.
 */
export function RowActions({ actions }: { actions: RowAction[] }) {
  const colors: Record<RowActionTone, string> = {
    neutral: 'var(--muted)',
    accent: 'var(--accent-deep)',
    danger: 'var(--red)',
  }
  // El fondo del hover sale de la MISMA familia que el icono. Un solo gris para
  // los tres tonos desperdicia el único aviso que hay antes de pulsar.
  const hovers: Record<RowActionTone, string> = {
    neutral: 'var(--neutral-soft)',
    accent: 'var(--accent-soft)',
    danger: 'var(--red-soft)',
  }

  return (
    <Stack direction="row" spacing={0.25} sx={{ justifyContent: 'flex-end' }}>
      {actions.map((action) => {
        const tone = action.tone ?? 'neutral'
        return (
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
                  width: 30,
                  height: 30,
                  borderRadius: `${R.sm}px`,
                  color: colors[tone],
                  border: '1px solid transparent',
                  transition: 'background-color .12s ease, border-color .12s ease',
                  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                  '&:hover': {
                    bgcolor: hovers[tone],
                    borderColor: 'color-mix(in srgb, currentColor 22%, transparent)',
                  },
                  // El foco de teclado tiene que verse sin depender del hover:
                  // quien recorre la tabla con Tab necesita saber dónde está,
                  // y una de estas acciones borra.
                  '&:focus-visible': {
                    bgcolor: hovers[tone],
                    outline: '2px solid currentColor',
                    outlineOffset: 1,
                  },
                  '&.Mui-disabled': { color: 'var(--muted)', opacity: 0.4 },
                }}
              >
                {action.icon}
              </IconButton>
            </span>
          </Tooltip>
        )
      })}
    </Stack>
  )
}
