import LockOutlinedIcon from '@mui/icons-material/LockOutlined'
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { useT } from '@/shared/i18n/i18n-context'
import { R, S } from '@/theme/tokens'

const SHELL_SX = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  gap: 1.5,
  px: 3,
  py: 6,
  minHeight: 220,
} as const

/** Estado de carga. `role="status"` para que el lector de pantalla lo anuncie. */
export function LoadingState({ label }: { label?: string }) {
  const t = useT()
  const text = label ?? t('common.loading')
  return (
    <Box sx={SHELL_SX} role="status" aria-live="polite">
      <CircularProgress size={28} aria-hidden />
      <Typography sx={{ color: 'var(--muted)', fontWeight: 600 }}>{text}</Typography>
    </Box>
  )
}

/** Estado de error con reintento. El mensaje técnico nunca reemplaza al humano. */
export function ErrorState({
  title,
  description,
  error,
  onRetry,
}: {
  title?: string
  description?: string
  error?: unknown
  onRetry?: () => void
}) {
  const t = useT()
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  return (
    <Box sx={SHELL_SX} role="alert">
      <Typography component="h2" sx={{ fontSize: 17, fontWeight: 800 }}>
        {title ?? t('common.error.title')}
      </Typography>
      <Typography sx={{ color: 'var(--muted)', maxWidth: 460 }}>
        {description ?? t('common.error.body')}
      </Typography>
      {detail && (
        <Typography
          component="pre"
          sx={{
            fontSize: 11,
            color: 'var(--muted)',
            bgcolor: 'var(--neutral-soft)',
            borderRadius: `${R.sm}px`,
            px: 1.5,
            py: 1,
            maxWidth: 520,
            whiteSpace: 'pre-wrap',
            m: 0,
          }}
        >
          {detail}
        </Typography>
      )}
      {onRetry && (
        <Button variant="contained" onClick={onRetry} sx={{ mt: 1 }}>
          {t('common.retry')}
        </Button>
      )}
    </Box>
  )
}

/**
 * Sin permiso. Distinto de error y de vacío: la operación se entendió, hay
 * datos, y esta cuenta no puede verlos. Decirlo así evita el clásico "recarga a
 * ver si aparece" cuando lo que falta es un rol.
 */
export function UnauthorizedState({
  title,
  description,
  action,
}: {
  title?: string
  description?: string
  action?: ReactNode
}) {
  const t = useT()
  return (
    <Box sx={SHELL_SX} role="status">
      <Box
        sx={{
          width: 44,
          height: 44,
          display: 'grid',
          placeItems: 'center',
          borderRadius: `${R.md}px`,
          bgcolor: 'var(--neutral-soft)',
          color: 'var(--muted)',
        }}
        aria-hidden
      >
        <LockOutlinedIcon fontSize="small" />
      </Box>
      <Typography component="h2" sx={{ fontSize: 16, fontWeight: 800 }}>
        {title ?? t('common.unauthorized.title')}
      </Typography>
      <Typography sx={{ color: 'var(--muted)', maxWidth: 440 }}>
        {description ?? t('common.unauthorized.body')}
      </Typography>
      {action && <Stack sx={{ mt: 1 }}>{action}</Stack>}
    </Box>
  )
}

/** Estado vacío. Distinto de error: aquí no falló nada, simplemente no hay datos. */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title?: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
}) {
  const t = useT()
  return (
    <Box sx={SHELL_SX}>
      {icon && (
        <Box
          sx={{
            width: 44,
            height: 44,
            display: 'grid',
            placeItems: 'center',
            borderRadius: `${R.md}px`,
            bgcolor: 'var(--accent-soft)',
            color: 'var(--accent-deep)',
          }}
        >
          {icon}
        </Box>
      )}
      <Typography component="h2" sx={{ fontSize: 16, fontWeight: 800 }}>
        {title ?? t('common.empty.title')}
      </Typography>
      <Typography sx={{ color: 'var(--muted)', maxWidth: 420 }}>
        {description ?? t('common.empty.body')}
      </Typography>
      {action && <Stack sx={{ mt: S[1] / 8 }}>{action}</Stack>}
    </Box>
  )
}
