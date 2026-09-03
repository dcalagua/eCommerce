import ReceiptRoundedIcon from '@mui/icons-material/ReceiptRounded'
import {
  Alert,
  Box,
  Card,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import { useMemo, useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { FilterBar } from '@/shared/ui/FilterBar'
import { SearchField } from '@/shared/ui/SearchField'
import { StatusChip } from '@/shared/ui/StatusChip'
import { TablePager } from '@/shared/ui/TablePager'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { usePagedRows } from '@/shared/ui/usePagedRows'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { useInvoices } from './hooks'
import type { InvoiceStatus } from './types'

/**
 * Comprobantes emitidos.
 *
 * ## Es una pantalla de LECTURA, y lo dice
 *
 * Un comprobante no se edita: la base lo impide en cuanto la autoridad lo
 * acepta, y se corrige con una nota. Poner aquí un botón de editar sería
 * ofrecer algo que va a fallar.
 *
 * ## Y avisa de lo que todavía no hay
 *
 * La emisión sale por el outbox de integraciones, y ese productor **aún no está
 * cableado** (deuda D3 de la auditoría). Decirlo en la pantalla es lo honesto:
 * una tabla vacía sin explicación se lee como «no hay comprobantes», cuando lo
 * cierto es «todavía no se emiten desde aquí».
 */
export function InvoicesSection() {
  const { t, locale } = useI18n()
  const [search, setSearch] = useState('')

  const query = useInvoices()

  const invoices = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = query.data ?? []
    if (!term) return all
    return all.filter(
      (invoice) =>
        (invoice.number ?? '').toLowerCase().includes(term) ||
        invoice.series.toLowerCase().includes(term) ||
        invoice.customer_name.toLowerCase().includes(term),
    )
  }, [query.data, search])

  const isEmpty = !query.isPending && !query.isError && invoices.length === 0
  const pager = usePagedRows(invoices)

  const tono = (status: InvoiceStatus) => {
    if (status === 'accepted') return 'success' as const
    if (status === 'rejected' || status === 'cancelled') return 'error' as const
    if (status === 'issued') return 'info' as const
    return 'default' as const
  }

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('credit.invoices.help')}</Typography>

      {/* Lo que falta se dice, no se esconde. */}
      <Alert severity="info">{t('credit.invoices.pendingWiring')}</Alert>

      <FilterBar>
        <Box sx={{ minWidth: { xs: '100%', sm: 300 } }}>
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('credit.invoices.search')}
            ariaLabel={t('credit.invoices.search')}
          />
        </Box>
      </FilterBar>

      <Card>
        {query.isPending && <TableSkeleton columns={6} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('credit.noResults') : t('credit.invoices.empty')}
            description={search ? undefined : t('credit.invoices.emptyBody')}
            icon={<ReceiptRoundedIcon fontSize="small" />}
          />
        )}

        {!query.isPending && !query.isError && invoices.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('credit.field.series')}</TableCell>
                <TableCell>{t('credit.field.customer')}</TableCell>
                <TableCell>{t('credit.field.issuedAt')}</TableCell>
                <TableCell align="right">{t('credit.field.net')}</TableCell>
                <TableCell align="right">{t('credit.field.tax')}</TableCell>
                <TableCell align="right">{t('credit.field.gross')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pager.rows.map((invoice) => (
                <TableRow key={invoice.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>
                    {/* Sin número todavía: la autoridad no ha contestado. Un
                        guion es más honesto que inventar un correlativo. */}
                    {invoice.number ? `${invoice.series}-${invoice.number}` : invoice.series}
                  </TableCell>
                  <TableCell>{invoice.customer_name}</TableCell>
                  <TableCell>{invoice.issued_at.slice(0, 10)}</TableCell>
                  <TableCell align="right">
                    {formatMoney(Number(invoice.net_total), invoice.currency, locale)}
                  </TableCell>
                  <TableCell align="right">
                    {formatMoney(Number(invoice.tax_total), invoice.currency, locale)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800 }}>
                    {formatMoney(Number(invoice.gross_total), invoice.currency, locale)}
                  </TableCell>
                  {/* Ancho tope: sin el, un motivo de rechazo largo estira la
                      columna y estruja las de importes, que son las que se
                      comparan de un vistazo. */}
                  <TableCell sx={{ maxWidth: 260 }}>
                    {/* `flex-start`: en columna, un Stack estira a sus hijos a
                        todo el ancho, y el chip pasaba de etiqueta a barra. */}
                    <Stack spacing={0.25} sx={{ alignItems: 'flex-start' }}>
                      <StatusChip
                        tone={tono(invoice.status)}
                        label={t(`credit.invoiceStatus.${invoice.status}` as MessageKey)}
                      />
                      {/* El motivo del rechazo es lo único accionable de una
                          factura rechazada: sin él nadie sabe qué corregir. */}
                      {invoice.reject_reason && (
                        <Typography sx={{ fontSize: 11, color: 'var(--red)' }}>
                          {invoice.reject_reason}
                        </Typography>
                      )}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {pager.total > 0 && (
          <TablePager
            page={pager.page}
            pageSize={pager.pageSize}
            total={pager.total}
            onPageChange={pager.setPage}
          />
        )}
      </Card>
    </Stack>
  )
}
