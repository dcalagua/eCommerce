import { Box, Card, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { AppIcon, type AppIconTone } from '@/shared/ui/AppIcon'
import { T } from '@/theme/tokens'

/**
 * Tarjeta con cabecera: el bloque del que se hacen las pantallas densas.
 *
 * Antes cada sección resolvía su título con un `<Typography p:2 pb:0>` suelto
 * encima de la tabla. Se veía como texto flotando: sin línea que lo separe del
 * contenido, el título y la primera fila quedan a la misma distancia y el ojo no
 * sabe si el rótulo pertenece a la tabla o a lo de arriba.
 *
 * Aquí la cabecera es una franja de verdad —pastilla de icono, título, apunte y
 * acciones— cerrada por la misma línea que separa las filas de la tabla. Es la
 * anatomía que ya usa `PageHeader` un nivel por encima: misma gramática visual
 * en los dos niveles, así que aprender una es aprender las dos.
 *
 * El icono es DECORATIVO: el título de al lado ya nombra la sección.
 *
 * `meta` es para la cifra de contexto («12 productos», «del 1 al 30»), que va
 * en gris y a la derecha del título: es dato de la sección, no una acción, y
 * ponerlo entre los botones lo convertiría en algo pulsable a los ojos.
 */
export function SectionCard({
  icon,
  title,
  subtitle,
  meta,
  actions,
  tone = 'accent',
  padded = false,
  fill = false,
  titleComponent = 'h3',
  children,
}: {
  icon?: ReactNode
  title: string
  subtitle?: string
  /** Cifra de contexto en gris, a la derecha del título. */
  meta?: ReactNode
  /** Botones de la sección. Nivel 2/3: el primario de la pantalla no vive aquí. */
  actions?: ReactNode
  tone?: AppIconTone
  /** Para contenido que NO es una tabla: le da el aire que la tabla trae sola. */
  padded?: boolean
  /**
   * La tarjeta CRECE con el hueco que le deje su contenedor y se lo pasa a su
   * contenido. Solo para lo que mejora con más alto —un gráfico—: estirar una
   * tabla de tres filas mueve el vacío de debajo de la tarjeta a dentro, que es
   * peor porque ahí sí parece que falta algo.
   */
  fill?: boolean
  titleComponent?: 'h2' | 'h3'
  children: ReactNode
}) {
  return (
    <Card
      sx={{
        overflow: 'hidden',
        ...(fill && { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }),
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          gap: 1.25,
          px: 2,
          py: 1.5,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {icon && (
          <AppIcon tone={tone} size="sm">
            {icon}
          </AppIcon>
        )}
        <Box sx={{ minWidth: 0 }}>
          <Typography
            component={titleComponent}
            sx={{ fontSize: T.cardTitle, fontWeight: 800, lineHeight: 1.3 }}
          >
            {title}
          </Typography>
          {subtitle && (
            <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>{subtitle}</Typography>
          )}
        </Box>
        <Box sx={{ flex: 1, minWidth: 8 }} />
        {meta && (
          <Typography
            sx={{
              fontSize: T.label,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--muted)',
              whiteSpace: 'nowrap',
            }}
          >
            {meta}
          </Typography>
        )}
        {actions && (
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
            {actions}
          </Stack>
        )}
      </Stack>
      {padded ? (
        <Box
          sx={{
            p: 2,
            ...(fill && { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }),
          }}
        >
          {children}
        </Box>
      ) : (
        children
      )}
    </Card>
  )
}
