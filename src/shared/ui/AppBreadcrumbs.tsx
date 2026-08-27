import NavigateNextIcon from '@mui/icons-material/NavigateNext'
import { Breadcrumbs, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'

export interface Crumb {
  label: string
  /** Sin `to` = página actual: se marca con `aria-current`, no es un link. */
  to?: string
}

/**
 * Migas del backoffice. La última nunca es un enlace: llevar a la página en la
 * que ya estás es ruido para un lector de pantalla.
 */
export function AppBreadcrumbs({ items, ariaLabel }: { items: Crumb[]; ariaLabel: string }) {
  return (
    <Breadcrumbs
      aria-label={ariaLabel}
      separator={<NavigateNextIcon sx={{ fontSize: 16 }} />}
      sx={{ fontSize: 12.5, '& .MuiBreadcrumbs-separator': { mx: 0.5, color: 'var(--muted)' } }}
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1
        if (isLast || !item.to) {
          return (
            <Typography
              key={item.label}
              aria-current={isLast ? 'page' : undefined}
              sx={{ fontSize: 12.5, fontWeight: 700 }}
            >
              {item.label}
            </Typography>
          )
        }
        return (
          <Typography
            key={item.label}
            component={RouterLink}
            to={item.to}
            sx={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', textDecoration: 'none' }}
          >
            {item.label}
          </Typography>
        )
      })}
    </Breadcrumbs>
  )
}
