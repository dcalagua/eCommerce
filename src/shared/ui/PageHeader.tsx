import { Box, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { T } from '@/theme/tokens'

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 3 }}
    >
      <Box>
        <Typography component="h1" sx={{ fontSize: T.pageTitle, fontWeight: 800, letterSpacing: '-0.4px' }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography sx={{ color: 'var(--muted)', mt: 0.5 }}>{subtitle}</Typography>
        )}
      </Box>
      {actions && <Stack direction="row" spacing={1}>{actions}</Stack>}
    </Stack>
  )
}
