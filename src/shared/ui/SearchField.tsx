import SearchIcon from '@mui/icons-material/Search'
import { InputAdornment, TextField } from '@mui/material'

/**
 * Buscador general único de listado (contrato §8, regla esupplier-022).
 * No se usan paneles de filtros multi-campo: un solo `TextField` + tabs de estado.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
  ariaLabel?: string
}) {
  return (
    <TextField
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      size="small"
      fullWidth
      type="search"
      inputProps={{ 'aria-label': ariaLabel ?? placeholder }}
      InputProps={{
        startAdornment: (
          <InputAdornment position="start">
            <SearchIcon fontSize="small" sx={{ color: 'var(--muted)' }} />
          </InputAdornment>
        ),
      }}
      sx={{ maxWidth: { sm: 420 } }}
    />
  )
}
