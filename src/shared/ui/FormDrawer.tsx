import CloseIcon from '@mui/icons-material/Close'
import { Box, Drawer, IconButton, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { useT } from '@/shared/i18n/i18n-context'
import { T } from '@/theme/tokens'

/**
 * Panel lateral de alta/edición.
 *
 * El listado sigue detrás: quien edita ve dónde estaba y no pierde el contexto
 * de búsqueda ni de pestaña. En móvil ocupa el ancho completo, porque un panel
 * de 480 px en una pantalla de 360 no es un panel, es un modal mal hecho.
 *
 * La barra de acciones es `sticky` al pie (regla de suite para formularios
 * largos): Guardar no se pierde al hacer scroll.
 */
export function FormDrawer({
  open,
  title,
  subtitle,
  onClose,
  actions,
  children,
  width = 520,
  busy = false,
}: {
  open: boolean
  title: string
  subtitle?: string
  onClose: () => void
  actions: ReactNode
  children: ReactNode
  width?: number
  /** Mientras se guarda, cerrar por Escape o por el velo queda deshabilitado. */
  busy?: boolean
}) {
  const t = useT()

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={busy ? undefined : onClose}
      PaperProps={{
        sx: { width: { xs: '100%', sm: width }, maxWidth: '100%' },
        component: 'section',
        // El Drawer de MUI no marca su panel: sin esto, un lector de pantalla
        // anuncia el formulario como contenido suelto de la página de detrás.
        role: 'dialog',
        'aria-modal': true,
        'aria-label': title,
      }}
    >
      <Stack sx={{ height: '100%' }}>
        <Stack
          direction="row"
          spacing={2}
          sx={{
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            px: 3,
            py: 2.5,
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Box>
            <Typography component="h2" sx={{ fontSize: T.pageTitle, fontWeight: 800 }}>
              {title}
            </Typography>
            {subtitle && (
              <Typography sx={{ color: 'var(--muted)', fontSize: 13, mt: 0.25 }}>
                {subtitle}
              </Typography>
            )}
          </Box>
          <IconButton onClick={onClose} aria-label={t('common.close')} disabled={busy} edge="end">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Box sx={{ flex: 1, overflowY: 'auto', px: 3, py: 3 }}>{children}</Box>

        <Stack
          direction="row"
          spacing={1}
          sx={{
            position: 'sticky',
            bottom: 0,
            justifyContent: 'flex-end',
            px: 3,
            py: 2,
            borderTop: '1px solid var(--border)',
            bgcolor: 'var(--card)',
          }}
        >
          {actions}
        </Stack>
      </Stack>
    </Drawer>
  )
}
