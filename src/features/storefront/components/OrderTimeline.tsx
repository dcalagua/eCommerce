import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import HourglassTopRoundedIcon from '@mui/icons-material/HourglassTopRounded'
import { Box, Stack, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { TS } from '@/theme/tokens'

type Estado = 'done' | 'current' | 'pending' | 'failed'

export interface OrderTimelineInput {
  /** Estado comercial del pedido (`pending`, `paid`, `fulfilled`, `cancelled`…). */
  status: string
  paid: boolean
  /** `not_required` | `pending` | `approved` | `rejected`, o `null` si no llegó. */
  approvalStatus: string | null
  /** `unfulfilled` | `in_progress` | `partially_fulfilled` | `fulfilled`…, o `null`. */
  fulfillmentStatus: string | null
}

/**
 * Los pasos del pedido, calculados de los ejes que YA tiene la fila.
 *
 * Nada se infiere de «lo normal»: si el pedido no pasa por aprobación, ese paso
 * no existe; si la aprobación se rechazó, se dice y lo que viene después queda
 * en espera. Un paso marcado como hecho es un dato del pedido, no una promesa.
 */
export function orderSteps(input: OrderTimelineInput): Array<{ key: string; estado: Estado }> {
  const cancelado = input.status === 'cancelled'
  const conAprobacion = input.approvalStatus !== null && input.approvalStatus !== 'not_required'
  const aprobado = !conAprobacion || input.approvalStatus === 'approved'
  const rechazado = input.approvalStatus === 'rejected'
  const envio = input.fulfillmentStatus
  const entregado = envio === 'fulfilled' || input.status === 'fulfilled'
  const enCamino = entregado || envio === 'in_progress' || envio === 'partially_fulfilled'

  const pasos: Array<{ key: string; estado: Estado }> = [{ key: 'placed', estado: 'done' }]
  if (conAprobacion) {
    pasos.push({ key: 'approval', estado: rechazado ? 'failed' : aprobado ? 'done' : 'current' })
  }
  const bloqueado = rechazado || cancelado || !aprobado
  pasos.push({
    key: 'payment',
    estado: input.paid ? 'done' : bloqueado ? 'pending' : 'current',
  })
  pasos.push({
    key: 'shipping',
    estado: entregado ? 'done' : enCamino ? 'current' : 'pending',
  })
  pasos.push({ key: 'delivered', estado: entregado ? 'done' : 'pending' })
  if (cancelado) return pasos.map((paso) => (paso.estado === 'current' ? { ...paso, estado: 'pending' } : paso))
  return pasos
}

/**
 * La línea de tiempo del pedido en la confirmación.
 *
 * Es una LISTA ordenada con el estado dicho en texto en cada paso: el color y
 * el icono acompañan, pero un lector de pantalla oye «Aprobación: en curso».
 */
export function OrderTimeline(input: OrderTimelineInput) {
  const { t } = useI18n()
  const pasos = orderSteps(input)
  const color: Record<Estado, string> = {
    done: 'var(--accent)',
    current: 'var(--amber)',
    pending: 'var(--sf-line-strong, var(--border))',
    failed: 'var(--red)',
  }

  return (
    <Box
      component="ol"
      aria-label={t('store.order.timeline')}
      data-order-timeline
      sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', gap: 0.5 }}
    >
      {pasos.map((paso, index) => (
        <Stack
          component="li"
          key={paso.key}
          data-step={paso.key}
          data-state={paso.estado}
          sx={{ flex: 1, minWidth: 0, alignItems: 'center', gap: 0.75, position: 'relative' }}
        >
          {index > 0 ? (
            <Box
              aria-hidden
              sx={{
                position: 'absolute',
                top: 15,
                right: '50%',
                width: '100%',
                height: 3,
                borderRadius: 2,
                bgcolor: paso.estado === 'pending' ? 'var(--sf-line, var(--border))' : 'var(--accent)',
              }}
            />
          ) : null}
          <Box
            aria-hidden
            sx={{
              position: 'relative',
              zIndex: 1,
              width: 32,
              height: 32,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              bgcolor: paso.estado === 'done' ? color.done : paso.estado === 'failed' ? color.failed : 'var(--card)',
              border: `2px solid ${color[paso.estado]}`,
              color: paso.estado === 'done' || paso.estado === 'failed' ? '#fff' : color[paso.estado],
              '& .MuiSvgIcon-root': { fontSize: 17 },
            }}
          >
            {paso.estado === 'done' ? (
              <CheckRoundedIcon />
            ) : paso.estado === 'failed' ? (
              <CloseRoundedIcon />
            ) : paso.estado === 'current' ? (
              <HourglassTopRoundedIcon />
            ) : (
              <Typography sx={{ fontSize: 12, fontWeight: 800 }}>{index + 1}</Typography>
            )}
          </Box>
          <Typography
            sx={{
              fontSize: TS.label,
              fontWeight: paso.estado === 'pending' ? 600 : 800,
              color: paso.estado === 'pending' ? 'var(--muted)' : 'var(--text)',
              textAlign: 'center',
            }}
          >
            {t(`store.order.step.${paso.key}` as MessageKey)}
          </Typography>
          <Typography sx={{ fontSize: 11, color: color[paso.estado] === color.pending ? 'var(--muted)' : color[paso.estado], fontWeight: 700 }}>
            {t(`store.order.state.${paso.estado}` as MessageKey)}
          </Typography>
        </Stack>
      ))}
    </Box>
  )
}
