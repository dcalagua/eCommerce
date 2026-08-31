import { Chip } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { T } from '@/theme/tokens'

/**
 * Estado en pastilla, con su traducción y su color.
 *
 * Cae al valor crudo si el diccionario no tiene la clave: un estado nuevo del
 * servidor tiene que verse, aunque sea sin traducir. Esconderlo sería peor.
 *
 * Vive en su propio archivo porque lo usan la lista y el detalle, y el detalle
 * cuelga de la lista: importarlo del otro lado cerraba un círculo entre los dos
 * módulos.
 */
export function EstadoChip({ valor, clave }: { valor: string; clave: string }) {
  const { t } = useI18n()
  const key = `${clave}.${valor}` as MessageKey
  const etiqueta = t(key)
  const tono =
    valor === 'paid' || valor === 'fulfilled'
      ? { bgcolor: 'var(--accent-soft)', color: 'var(--accent-deep)' }
      : valor === 'cancelled' || valor === 'failed'
        ? { bgcolor: 'var(--red-soft)', color: 'var(--red)' }
        : { bgcolor: 'var(--neutral-soft)', color: 'var(--muted)' }

  return (
    <Chip
      size="small"
      label={etiqueta === key ? valor : etiqueta}
      sx={{ ...tono, fontWeight: 700, fontSize: T.label }}
    />
  )
}
