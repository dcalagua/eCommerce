import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import {
  Button,
  Card,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@mui/material'
import { useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SearchField } from '@/shared/ui/SearchField'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { formatMoney } from '@/shared/lib/format'
import { useProducts } from './useProducts'

/**
 * Listado de productos del backoffice.
 * Un buscador general + Exportar; sin paneles de filtros multi-campo (contrato §8).
 */
export function ProductsPage() {
  const { t, locale } = useI18n()
  const [search, setSearch] = useState('')
  const { activeStore } = useTenant()
  const { data, isPending, isError, error, refetch } = useProducts(search, activeStore?.id ?? null)

  return (
    <>
      <PageHeader
        title={t('admin.products.title')}
        actions={<Button variant="outlined">{t('common.export')}</Button>}
      />
      <Stack spacing={2}>
        <SearchField value={search} onChange={setSearch} placeholder={t('admin.products.search')} />
        <Card>
          {isPending && <LoadingState />}
          {!isPending && isError && <ErrorState error={error} onRetry={() => void refetch()} />}
          {!isPending && !isError && (data?.length ?? 0) === 0 && (
            <EmptyState title={t('admin.products.empty')} icon={<Inventory2OutlinedIcon fontSize="small" />} />
          )}
          {!isPending && !isError && (data?.length ?? 0) > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>SKU</TableCell>
                  <TableCell>{t('admin.products.title')}</TableCell>
                  <TableCell align="right">{t('common.price')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data?.map((product) => (
                  <TableRow key={product.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{product.sku}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <span>{product.name}</span>
                        <Chip size="small" label={product.status} />
                      </Stack>
                    </TableCell>
                    <TableCell align="right" className="tnum">
                      {formatMoney(product.price, product.currency, locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </Stack>
    </>
  )
}
