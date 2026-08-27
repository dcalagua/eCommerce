import { Box, Typography } from '@mui/material'
import { APP_NAME } from '@/shared/lib/env'
import { EbimMark } from './EbimMark'

/**
 * Lockup de suite: `[isotipo] <NombreApp>` + `BY EBIM` debajo (contrato §4.6).
 * El nombre de app varía; "by EBIM" es fijo. La animación gira-y-para respeta
 * `prefers-reduced-motion` vía la clase `.eb-logo-anim`.
 */
export function BrandLockup({
  variant = 'teal',
  size = 32,
  animated = true,
  appName = APP_NAME,
}: {
  variant?: 'white' | 'teal'
  size?: number
  animated?: boolean
  appName?: string
}) {
  const onDark = variant === 'white'
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
      <span className={animated ? 'eb-logo-anim' : undefined}>
        <EbimMark variant={variant} size={size} />
      </span>
      <Box sx={{ lineHeight: 1 }}>
        <Typography
          component="div"
          sx={{
            fontSize: 19,
            fontWeight: 800,
            letterSpacing: '-0.3px',
            color: onDark ? '#fff' : 'var(--text)',
          }}
        >
          {appName}
        </Typography>
        <Typography
          component="div"
          sx={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: '0.22em',
            opacity: 0.85,
            color: onDark ? 'rgba(255,255,255,.7)' : 'var(--muted)',
          }}
        >
          BY EBIM
        </Typography>
      </Box>
    </Box>
  )
}
