import AddRoundedIcon from '@mui/icons-material/AddRounded'
import RemoveRoundedIcon from '@mui/icons-material/RemoveRounded'
import { IconButton, Stack, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { R } from '@/theme/tokens'
import { MAX_LINE_QUANTITY } from '../cart/cart'

/**
 * Cuántas unidades. Dos botones y una cifra, no una caja de texto.
 *
 * Una caja donde se teclea el número admite «0», «-3», «12abc» y un pegado de
 * mil, así que hay que validar, decidir qué hacer con lo inválido y decírselo a
 * alguien. Con dos botones el estado imposible no existe: el tope de arriba lo
 * pone `MAX_LINE_QUANTITY` y el de abajo es uno, y ninguno de los dos se puede
 * pasar porque el botón se apaga antes.
 *
 * La cifra es un `<output>` con `aria-live`: al pulsar, quien no ve la pantalla
 * oye el número nuevo. Sin eso los dos botones no informan de nada.
 *
 * Vive aquí y no dentro de la ficha porque lo usan la ficha y la vista rápida.
 * Duplicarlo era garantizar que un día uno tuviera el tope y el otro no.
 */
export function QuantityStepper({
  value,
  onChange,
  max = MAX_LINE_QUANTITY,
  disabled = false,
}: {
  value: number
  onChange: (next: number) => void
  max?: number
  disabled?: boolean
}) {
  const { t } = useI18n()

  return (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        gap: 0.5,
        border: '1px solid var(--border)',
        borderRadius: `${R.md}px`,
        px: 0.5,
        flexShrink: 0,
      }}
    >
      <IconButton
        size="small"
        aria-label={t('store.cart.decrease')}
        disabled={disabled || value <= 1}
        onClick={() => onChange(Math.max(1, value - 1))}
      >
        <RemoveRoundedIcon fontSize="small" />
      </IconButton>
      <Typography
        component="output"
        aria-live="polite"
        aria-label={t('store.cart.quantity')}
        sx={{ minWidth: 28, textAlign: 'center', fontWeight: 800 }}
      >
        {value}
      </Typography>
      <IconButton
        size="small"
        aria-label={t('store.cart.increase')}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <AddRoundedIcon fontSize="small" />
      </IconButton>
    </Stack>
  )
}
