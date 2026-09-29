import { Box, Chip } from '@mui/material'
import type { SxProps, Theme } from '@mui/material'
import type { ReactNode } from 'react'
import { ScrollRow } from './ScrollRow'
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
/**
 * Resumen v2 · La cantidad, pegada al nombre en una pastilla tenue: se compara
 * de un vistazo cuánto hay en cada familia sin abrirla.
 */
function Etiqueta({ nombre, cuenta }: { nombre: string; cuenta: number | undefined }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
      {nombre}
      {/* El espacio no se ve (contenedor flex) pero separa el nombre de la
          cifra al leerlo: «Mesas 3» y no «Mesas3». */}
      {cuenta !== undefined ? ' ' : null}
      {cuenta !== undefined ? (
        <Box
          component="span"
          className="tnum"
          sx={{ px: 0.75, borderRadius: 'var(--sf-pill)', bgcolor: 'var(--neutral-soft)', color: 'var(--muted)', fontSize: 11.5, fontWeight: 700, lineHeight: 1.6 }}
        >
          {cuenta}
        </Box>
      ) : null}
    </Box>
  )
}

export function CategoryBar({
  categories,
  selected,
  onSelect,
  counts,
  total,
  trailing,
}: {
  categories: PublicCategory[]
  selected: string | null
  onSelect: (slug: string | null) => void
  /** Cuántos hay por familia, si se saben. Sin ellos no se inventa ninguno. */
  counts?: ReadonlyMap<string, number | null> | null
  /** Cuántos hay en total, para «Todos». */
  total?: number | null
  /** Lo que va al final de la fila (p. ej. «Pedido rápido por SKU»). */
  trailing?: ReactNode
}) {
  const t = useT()
  if (categories.length === 0) return null

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <ScrollRow component="nav" ariaLabel={t('store.categories.title')} gap={1}>
          <Chip
            label={<Etiqueta nombre={t('store.categories.all')} cuenta={total ?? undefined} />}
            onClick={() => onSelect(null)}
            aria-pressed={selected === null}
            sx={pillSx(selected === null)}
          />
          {categories.map((category) => {
            const active = selected === category.slug
            return (
              <Chip
                key={category.category_id}
                label={<Etiqueta nombre={category.name} cuenta={counts?.get(category.slug) ?? undefined} />}
                onClick={() => onSelect(active ? null : category.slug)}
                aria-pressed={active}
                sx={pillSx(active)}
              />
            )
          })}
        </ScrollRow>
      </Box>
      {trailing ? <Box sx={{ flexShrink: 0, display: { xs: 'none', md: 'block' } }}>{trailing}</Box> : null}
    </Box>
  )
}
