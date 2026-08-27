import { Box, Skeleton, Stack, Table, TableBody, TableCell, TableRow } from '@mui/material'
import { visuallyHidden } from '@mui/utils'
import { useT } from '@/shared/i18n/i18n-context'

/**
 * Esqueleto de listado. Se usa en lugar del spinner cuando ya se sabe la forma
 * de lo que va a llegar: la tabla no salta de alto al resolverse la consulta.
 * `aria-hidden` porque el anuncio accesible lo da el `role="status"` de fuera.
 */
export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  const t = useT()
  return (
    <Box role="status" aria-live="polite" aria-busy="true">
      <Box component="span" sx={visuallyHidden}>
        {t('common.loading')}
      </Box>
      <Table size="small" aria-hidden>
        <TableBody>
          {Array.from({ length: rows }, (_, rowIndex) => (
            <TableRow key={rowIndex}>
              {Array.from({ length: columns }, (_, columnIndex) => (
                <TableCell key={columnIndex}>
                  <Skeleton variant="text" width={columnIndex === 0 ? '60%' : '80%'} height={20} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  )
}

/** Esqueleto de rejilla, para las miniaturas de imagen. */
export function GridSkeleton({ items = 3 }: { items?: number }) {
  return (
    <Stack direction="row" spacing={1.5} aria-hidden>
      {Array.from({ length: items }, (_, index) => (
        <Skeleton key={index} variant="rounded" width={96} height={96} />
      ))}
    </Stack>
  )
}
