import { Card, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { AppIcon, type AppIconTone } from '@/shared/ui/AppIcon'
import { T } from '@/theme/tokens'

/**
 * Tarjeta de cifra: una cifra, su nombre y el denominador que la explica.
 *
 * Es la forma que la guía de visualización reserva para «un número que se lee
 * solo»: no hay serie que comparar ni categorías que distinguir, así que un
 * gráfico aquí sería adorno. Lo que sí hace falta es que la fila de cifras se
 * lea como una fila y no como seis rectángulos: mismo alto, misma tipografía,
 * misma posición del rótulo, y un icono que hace de ancla para encontrar «el de
 * pedidos» sin leer los seis rótulos.
 *
 * El icono es DECORATIVO (`aria-hidden`, lo pone `AppIcon`) y va en tono neutro
 * salvo en la cifra protagonista: si las seis tarjetas llevaran el acento, el
 * acento dejaría de señalar nada. `emphasis` es para UNA por fila —la cifra con
 * la que el panel encabeza—, y le da el acento, el borde y el cuerpo grande.
 *
 * `value` llega FORMATEADO por quien llama. Esta tarjeta no sabe de monedas ni
 * de razones: si el dato no se puede afirmar, quien llama pasa «—», que es la
 * regla de toda la analítica —un cero inventado se lee como un dato—.
 */
export function MetricCard({
  label,
  value,
  hint,
  icon,
  tone,
  emphasis = false,
}: {
  label: string
  /** Ya formateado. «—» cuando no hay con qué calcularlo. */
  value: string
  hint?: string
  icon?: ReactNode
  tone?: AppIconTone
  emphasis?: boolean
}) {
  return (
    <Card
      // Cada cifra es un GRUPO con nombre, no dos textos sueltos: así el lector
      // de pantalla anuncia «Ticket promedio» antes del número en vez de dejar
      // seis cantidades huérfanas seguidas, y una prueba puede preguntar por el
      // valor de UNA tarjeta en vez de por un texto que se repite en pantalla.
      component="article"
      aria-label={label}
      sx={{
        height: '100%',
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        ...(emphasis && { borderColor: 'var(--accent)', bgcolor: 'var(--accent-soft)' }),
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        {icon && (
          <AppIcon tone={tone ?? (emphasis ? 'accent' : 'neutral')} size="sm">
            {icon}
          </AppIcon>
        )}
        <Typography
          sx={{
            fontSize: T.label,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
            lineHeight: 1.3,
          }}
        >
          {label}
        </Typography>
      </Stack>

      <Typography
        className="tnum"
        sx={{
          fontSize: emphasis ? T.figure : T.kpiCard,
          fontWeight: 800,
          lineHeight: 1.15,
          letterSpacing: '-0.02em',
          // La cifra no se parte nunca: «S/ 4,500.52» cortado en dos líneas dentro
          // de una tarjeta estrecha se lee como dos números.
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </Typography>

      {/* El apunte ocupa sitio aunque esté vacío no: se deja crecer la tarjeta y
          el `height: 100%` iguala las de la misma fila del grid. */}
      {hint && (
        <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.35 }}>
          {hint}
        </Typography>
      )}
    </Card>
  )
}
