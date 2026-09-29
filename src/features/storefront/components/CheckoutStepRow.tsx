import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import { Box, Button, Stack, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { TS } from '@/theme/tokens'

/**
 * Un paso del checkout, PLEGADO (Resumen v2 · «Checkout B2B enfocado»).
 *
 * Los pasos hechos quedan a la vista en una línea —quién compra, a dónde va—
 * con «Cambiar» para volver sin perder nada; los que faltan se anuncian con su
 * número y «Pendiente». Así la página entera se lee como UNA compra, no como
 * tres pantallas que se olvidan de lo anterior.
 */
export function CheckoutStepRow({
  numero,
  titulo,
  resumen,
  estado,
  onCambiar,
}: {
  numero: number
  titulo: string
  /** La línea bajo el título. En un paso pendiente, qué se hará en él. */
  resumen: string
  estado: 'hecho' | 'pendiente'
  onCambiar?: () => void
}) {
  const { t } = useI18n()
  const hecho = estado === 'hecho'

  return (
    <Stack
      direction="row"
      data-checkout-step-row={estado}
      sx={{
        alignItems: 'center',
        gap: 1.5,
        px: { xs: 1.75, md: 2.25 },
        py: 1.5,
        borderRadius: 'var(--sf-radius)',
        border: '1px solid var(--sf-line)',
        bgcolor: 'var(--card)',
        boxShadow: hecho ? 'var(--sf-shadow)' : 'none',
        opacity: hecho ? 1 : 0.75,
      }}
    >
      <Box
        aria-hidden
        sx={{
          width: 28,
          height: 28,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          borderRadius: '50%',
          bgcolor: hecho ? 'var(--accent-soft)' : 'var(--neutral-soft)',
          color: hecho ? 'var(--accent-deep)' : 'var(--muted)',
          fontSize: 13,
          fontWeight: 800,
        }}
      >
        {hecho ? <CheckRoundedIcon sx={{ fontSize: 17 }} /> : numero}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography component="h2" sx={{ fontSize: TS.body, fontWeight: 800, lineHeight: 1.3 }}>
          {titulo}
        </Typography>
        <Typography
          title={resumen}
          sx={{ fontSize: TS.label, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {resumen}
        </Typography>
      </Box>
      {hecho && onCambiar ? (
        <Button
          type="button"
          size="small"
          onClick={onCambiar}
          aria-label={`${t('store.checkout.change')}: ${titulo}`}
          sx={{ fontWeight: 800, color: 'var(--accent-deep)', flexShrink: 0 }}
        >
          {t('store.checkout.change')}
        </Button>
      ) : (
        <Typography sx={{ fontSize: TS.label, color: 'var(--muted)', fontWeight: 700, flexShrink: 0 }}>
          {t('store.checkout.pending')}
        </Typography>
      )}
    </Stack>
  )
}
