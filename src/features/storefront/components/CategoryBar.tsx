import { Chip, Stack } from '@mui/material'
import type { SxProps, Theme } from '@mui/material'
import { useT } from '@/shared/i18n/i18n-context'
import type { PublicCategory } from '../types'

/**
 * Navegación por categorías. Solo llegan las ACTIVAS: la vista
 * `public_categories` filtra `is_active`, así que una categoría que el tenant
 * apagó no se puede colar por aquí ni escribiendo el slug en la URL — el filtro
 * simplemente no devolvería productos.
 *
 * Es una fila con scroll horizontal en móvil, no un `Select`: con cuatro o
 * cinco secciones, verlas todas de un vistazo es más rápido que desplegarlas.
 *
 * La activa NO va rellena del acento a plena saturación. En una fila de cinco
 * píldoras, una en verde sólido pesa más que la portada entera y arrastra la
 * mirada fuera del catálogo; con el acento suave de fondo y el acento profundo
 * en el texto se distingue igual —y cumple AA, que el acento puro como color de
 * texto no cumple (contrato §4.4)—.
 */

function pillSx(active: boolean): SxProps<Theme> {
  return {
    flexShrink: 0,
    height: 34,
    px: 0.5,
    fontWeight: 700,
    fontSize: 13,
    borderRadius: 'var(--sf-pill)',
    border: '1px solid',
    borderColor: active ? 'var(--accent)' : 'var(--sf-line-strong)',
    bgcolor: active ? 'var(--accent-soft)' : 'var(--card)',
    color: active ? 'var(--accent-deep)' : 'var(--text)',
    transition: 'background-color .15s ease, border-color .15s ease',
    '&:hover': { bgcolor: active ? 'var(--accent-soft)' : 'var(--neutral-soft)' },
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  }
}
export function CategoryBar({
  categories,
  selected,
  onSelect,
}: {
  categories: PublicCategory[]
  selected: string | null
  onSelect: (slug: string | null) => void
}) {
  const t = useT()
  if (categories.length === 0) return null

  return (
    <Stack
      direction="row"
      component="nav"
      aria-label={t('store.categories.title')}
      sx={{
        gap: 1,
        overflowX: 'auto',
        pb: 0.5,
        // La barra de scroll en móvil roba altura y no aporta nada: el gesto
        // ya se entiende porque las píldoras se cortan en el borde.
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' },
      }}
    >
      <Chip
        label={t('store.categories.all')}
        onClick={() => onSelect(null)}
        aria-pressed={selected === null}
        sx={pillSx(selected === null)}
      />
      {categories.map((category) => {
        const active = selected === category.slug
        return (
          <Chip
            key={category.category_id}
            label={category.name}
            onClick={() => onSelect(active ? null : category.slug)}
            aria-pressed={active}
            sx={pillSx(active)}
          />
        )
      })}
    </Stack>
  )
}
