import SearchIcon from '@mui/icons-material/Search'
import { Autocomplete, InputAdornment, TextField, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { T } from '@/theme/tokens'
import type { Suggestion } from '@/domain'

/**
 * Buscador de la vitrina con autocompletado.
 *
 * Tres cosas que este componente **no** hace, y son las que importan:
 *
 *  1. **No filtra.** `filterOptions: (x) => x` desactiva el filtrado del cliente
 *     de MUI: las opciones ya vienen del servidor, ordenadas por relevancia.
 *     Dejar que MUI las filtre otra vez con su propia regla haría que la lista
 *     se contradijera con el ranking del motor.
 *  2. **No busca por su cuenta.** El rebote y la cancelación viven en la
 *     pantalla, que es quien sabe cuándo la consulta deja de interesar.
 *  3. **No enseña precios.** Una sugerencia es una ayuda a teclear; el precio
 *     obliga a resolverlo por cada tecla y a repintarlo cuando cambie.
 *
 * `freeSolo`: se puede buscar lo que se ha escrito aunque no haya sugerencia —
 * un buscador que solo deja elegir de una lista no es un buscador.
 */
export function StoreSearchField({
  value,
  onChange,
  onPick,
  suggestions,
  loading = false,
}: {
  value: string
  onChange: (next: string) => void
  /** Se eligió una sugerencia: la pantalla decide a dónde lleva cada tipo. */
  onPick: (suggestion: Suggestion) => void
  suggestions: readonly Suggestion[]
  loading?: boolean
}) {
  const { t } = useI18n()

  return (
    <Autocomplete
      freeSolo
      disablePortal
      options={[...suggestions]}
      filterOptions={(options) => options}
      loading={loading}
      inputValue={value}
      onInputChange={(_event, next, reason) => {
        if (reason !== 'reset') onChange(next)
      }}
      onChange={(_event, picked) => {
        if (picked && typeof picked !== 'string') onPick(picked)
      }}
      getOptionLabel={(option) => (typeof option === 'string' ? option : option.label)}
      isOptionEqualToValue={(option, other) =>
        option.kind === other.kind && option.slug === other.slug
      }
      renderOption={(props, option) => (
        <li {...props} key={`${option.kind}:${option.slug}`}>
          <Typography sx={{ fontSize: T.body, fontWeight: 600 }}>{option.label}</Typography>
          <Typography sx={{ fontSize: T.micro, color: 'var(--muted)', ml: 1 }}>
            {t(`store.search.kind.${option.kind}`)}
          </Typography>
        </li>
      )}
      sx={{ width: '100%', maxWidth: { sm: 420 } }}
      renderInput={(params) => (
        <TextField
          {...params}
          size="small"
          type="search"
          placeholder={t('store.catalog.search')}
          inputProps={{ ...params.inputProps, 'aria-label': t('store.catalog.search') }}
          InputProps={{
            ...params.InputProps,
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" sx={{ color: 'var(--muted)' }} />
              </InputAdornment>
            ),
          }}
        />
      )}
    />
  )
}
