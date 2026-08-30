import ExtensionRoundedIcon from '@mui/icons-material/ExtensionRounded'
import { Box, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { capability, type CapabilityId } from '@/domain'
import { useI18n } from '@/shared/i18n/i18n-context'
import { ErrorState, LoadingState } from '@/shared/ui/states'
import { R } from '@/theme/tokens'
import { useCapabilities } from './capabilities-context'

/**
 * «Este módulo no está en tu plan» — y no es un error.
 *
 * Tiene su propio estado, separado de `UnauthorizedState` y de `EmptyState`, y
 * la distinción es de producto, no de estilo:
 *
 *  · **sin permiso** — el módulo existe y esta cuenta no puede entrar. Se
 *    arregla cambiando el rol del usuario.
 *  · **sin contratar** — la sociedad entera no lo tiene. Cambiar de rol no
 *    sirve de nada; hay que activarlo en el hub.
 *
 * Pintarlos igual manda al administrador a revisar permisos durante media hora
 * por algo que no es un permiso. `role="status"` y no `role="alert"` por la
 * misma razón: aquí no falló nada.
 */
export function NotEntitledState({ id }: { id: CapabilityId }) {
  const { t } = useI18n()
  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 1.5,
        px: 3,
        py: 6,
        minHeight: 220,
        justifyContent: 'center',
      }}
    >
      <Box
        aria-hidden
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
        <ExtensionRoundedIcon fontSize="small" />
      </Box>
      <Typography component="h2" sx={{ fontSize: 16, fontWeight: 800 }}>
        {t('capabilities.locked.title')}
      </Typography>
      <Typography sx={{ color: 'var(--muted)', maxWidth: 460 }}>
        {t('capabilities.locked.body')}
      </Typography>
      {/* Qué se pierde exactamente, en palabras del producto y no en el código
          del addon: un «ecommerce.pricing.lists» no le dice nada a quien decide
          si lo compra. El código va aparte, para soporte. */}
      <Typography sx={{ color: 'var(--muted)', maxWidth: 460, fontSize: 13 }}>
        {capability(id).grants}
      </Typography>
      <Typography component="code" sx={{ color: 'var(--muted)', fontSize: 11 }}>
        {id}
      </Typography>
    </Box>
  )
}

/**
 * Gating por capacidad. **No es seguridad**: la autoridad es
 * `ebim.has_capability` dentro de las policies. Esto evita que alguien pulse un
 * botón que va a terminar en un 403.
 *
 * Los cuatro estados son distintos a propósito y ninguno se come a otro:
 *
 *  · cargando → esqueleto. Nunca «no contratado»: enseñar el candado mientras
 *    la respuesta viaja hace que un módulo pagado parpadee como no contratado.
 *  · **error → error de verdad**, con reintento. Si la consulta de capacidades
 *    falla —403, red, RLS— eso se pinta como fallo. Degradarlo a «no lo
 *    tienes» es cómo un problema de autorización del servidor se vuelve
 *    invisible durante semanas.
 *  · sin capacidad → `NotEntitledState`, o el `fallback` que pase el llamante.
 *  · con capacidad → el módulo.
 */
export function CapabilityGate({
  capability: id,
  children,
  fallback,
}: {
  capability: CapabilityId
  children: ReactNode
  fallback?: ReactNode
}) {
  const { status, has, error, refetch } = useCapabilities()

  if (status === 'loading') return <LoadingState />
  if (status === 'error') return <ErrorState error={error} onRetry={refetch} />
  if (!has(id)) return <>{fallback ?? <NotEntitledState id={id} />}</>
  return <>{children}</>
}

/**
 * Variante en línea para un control suelto dentro de una pantalla que sí está
 * contratada — un interruptor, una pestaña, un botón de exportar.
 *
 * Aquí `hidden` SÍ es una opción razonable: una casilla que no se puede marcar
 * y no se explica es peor que no estar. Pero el defecto es explicar, porque un
 * control que desaparece sin dejar rastro es también la forma más rápida de que
 * nadie descubra que ese módulo existe.
 */
export function CapabilityFeature({
  capability: id,
  children,
  locked,
  hidden = false,
}: {
  capability: CapabilityId
  children: ReactNode
  locked?: ReactNode
  hidden?: boolean
}) {
  const { status, has } = useCapabilities()
  if (status !== 'ready') return null
  if (has(id)) return <>{children}</>
  if (hidden) return null
  return (
    <Stack spacing={0.5} sx={{ opacity: 0.85 }}>
      {locked ?? <LockedNote id={id} />}
    </Stack>
  )
}

function LockedNote({ id }: { id: CapabilityId }) {
  const { t } = useI18n()
  return (
    <Typography role="status" sx={{ color: 'var(--muted)', fontSize: 13 }}>
      {t('capabilities.locked.inline')} <strong>{capability(id).grants}</strong>
    </Typography>
  )
}
