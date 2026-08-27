import { Chip, Stack } from '@mui/material'
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
 */
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
        color={selected === null ? 'primary' : 'default'}
        variant={selected === null ? 'filled' : 'outlined'}
        aria-pressed={selected === null}
        sx={{ fontWeight: 700, flexShrink: 0 }}
      />
      {categories.map((category) => {
        const active = selected === category.slug
        return (
          <Chip
            key={category.category_id}
            label={category.name}
            onClick={() => onSelect(active ? null : category.slug)}
            color={active ? 'primary' : 'default'}
            variant={active ? 'filled' : 'outlined'}
            aria-pressed={active}
            sx={{ fontWeight: 700, flexShrink: 0 }}
          />
        )
      })}
    </Stack>
  )
}
