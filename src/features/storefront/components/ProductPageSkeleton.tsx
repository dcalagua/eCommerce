import { Box, Skeleton, Stack } from '@mui/material'
import { useT } from '@/shared/i18n/i18n-context'
import { R } from '@/theme/tokens'

/**
 * Esqueleto de la ficha de producto (P15-SaaS).
 *
 * Sustituye al `LoadingState` genérico —un aro girando centrado— por la MISMA
 * retícula que la ficha real: galería a la izquierda, columna de compra a la
 * derecha, y en móvil una encima de otra. La diferencia no es estética: el
 * `LoadingState` ocupa unos 120 px de alto y la ficha ocupa la pantalla, así
 * que al llegar los datos la página daba un salto de varios cientos de píxeles
 * —el mismo desplazamiento de diseño que la fase se propone quitar—.
 *
 * `aria-busy` con el texto de carga en un `aria-live`: quien no ve la pantalla
 * necesita que le digan que hay algo en camino; las cajas grises no le dicen
 * nada. Y el propio esqueleto va `aria-hidden` para que no se lean veinte
 * huecos vacíos uno por uno.
 */
export function ProductPageSkeleton() {
  const t = useT()

  return (
    <Stack sx={{ gap: { xs: 2.5, md: 4 } }} aria-busy data-testid="product-skeleton">
      <Box sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        <span role="status" aria-live="polite">
          {t('common.loading')}
        </span>
      </Box>

      <Box aria-hidden>
        <Skeleton variant="rounded" width={120} height={32} />
      </Box>

      <Box
        aria-hidden
        sx={{
          display: 'grid',
          gap: { xs: 2, md: 4 },
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1.1fr) minmax(0, 1fr)' },
          alignItems: 'start',
        }}
      >
        <Skeleton
          variant="rectangular"
          sx={{ width: '100%', aspectRatio: '4 / 3', borderRadius: `${R.md}px` }}
        />

        <Stack sx={{ gap: 1.25 }}>
          <Skeleton width="30%" height={14} />
          <Skeleton width="80%" height={34} />
          <Skeleton width="40%" height={30} />
          <Skeleton width="25%" height={18} />
          <Skeleton variant="rounded" width={220} height={40} sx={{ mt: 1 }} />
          <Skeleton width="100%" height={14} sx={{ mt: 2 }} />
          <Skeleton width="95%" height={14} />
          <Skeleton width="60%" height={14} />
        </Stack>
      </Box>
    </Stack>
  )
}
