import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import { Button, ListItemIcon, Menu, MenuItem, MenuList } from '@mui/material'
import { useState } from 'react'
import type { SearchSort } from '@/domain'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { R } from '@/theme/tokens'

const OPTIONS: ReadonlyArray<{ value: SearchSort; label: MessageKey }> = [
  { value: 'relevance', label: 'store.sort.relevance' },
  { value: 'recent', label: 'store.sort.recent' },
  { value: 'name', label: 'store.sort.name' },
  { value: 'price-asc', label: 'store.sort.priceAsc' },
  { value: 'price-desc', label: 'store.sort.priceDesc' },
]

/**
 * Orden del catálogo.
 *
 * Es un BOTÓN con menú, no un `TextField select`. El campo de formulario con su
 * etiqueta flotante decía «rellena esto», y esto no se rellena: se elige cómo
 * mirar lo que ya está en pantalla. El botón además enseña el orden vigente en
 * su propia etiqueta, así que no hace falta abrirlo para saber en qué orden se
 * está mirando el catálogo.
 *
 * La marca de selección va además del negrita: el peso de la tipografía a solas
 * es un canal flojo para decir «este es el activo».
 */
export function StoreSortMenu({
  value,
  onChange,
}: {
  value: SearchSort
  onChange: (next: SearchSort) => void
}) {
  const { t } = useI18n()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const current = OPTIONS.find((option) => option.value === value) ?? OPTIONS[0]

  return (
    <>
      <Button
        onClick={(event) => setAnchor(event.currentTarget)}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        aria-label={t('store.sort.label')}
        endIcon={<KeyboardArrowDownRoundedIcon />}
        sx={{
          textTransform: 'none',
          fontWeight: 700,
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: `${R.md}px`,
          px: 1.5,
          bgcolor: 'var(--card)',
          '&:hover': { borderColor: 'var(--accent)', bgcolor: 'var(--card)' },
        }}
      >
        {t(current!.label)}
      </Button>

      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { minWidth: 230, borderRadius: `${R.lg}px`, mt: 0.5 } } }}
      >
        <MenuList sx={{ py: 0.5 }}>
          {OPTIONS.map((option) => (
            <MenuItem
              key={option.value}
              selected={option.value === value}
              onClick={() => {
                onChange(option.value)
                setAnchor(null)
              }}
              sx={{ gap: 1, py: 1, fontSize: 14, fontWeight: option.value === value ? 800 : 500 }}
            >
              <ListItemIcon sx={{ minWidth: 24 }}>
                {option.value === value && (
                  <CheckRoundedIcon sx={{ fontSize: 18, color: 'var(--accent-deep)' }} />
                )}
              </ListItemIcon>
              {t(option.label)}
            </MenuItem>
          ))}
        </MenuList>
      </Menu>
    </>
  )
}
