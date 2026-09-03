import RequestQuoteRoundedIcon from '@mui/icons-material/RequestQuoteRounded'
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded'
import {
  Box,
  Button,
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
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { FilterBar } from '@/shared/ui/FilterBar'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SearchField } from '@/shared/ui/SearchField'
import { StatusChip } from '@/shared/ui/StatusChip'
import { TablePager } from '@/shared/ui/TablePager'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { usePagedRows } from '@/shared/ui/usePagedRows'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { QuoteDrawer } from './QuoteDrawer'
import { useQuotes } from './hooks'
import { isExpired, type Quote, type QuoteStatus } from './types'

/**
 * Cotizaciones: qué se le ofreció a quién, por cuánto y hasta cuándo.
 *
 * ## La vigencia se calcula al pintar
 *
 * `expired` es un estado que alguien tiene que poner, y hasta que lo pone la
 * fila sigue diciendo `sent`. La pantalla marca «caducada» comparando la fecha
 * con hoy, sin tocar la base: enseñar como vigente algo que venció hace un mes
 * es cómo se acaba honrando un precio que ya no existe.
 *
 * ## Un buscador general, no un panel de filtros
 *
 * Regla de suite: `TextField` único más pestañas de estado. Aquí las pestañas
 * son un desplegable de estado porque son cinco y ninguno es el «normal».
 */
export function QuotesPage() {
  const { t, locale } = useI18n()
  const { tenant, activeStore, activeCompanyId, status: tenantStatus, can } = useTenant()
  const canWrite = can('orders.write')

  const [search, setSearch] = useState('')
  const [estado, setEstado] = useState<QuoteStatus | 'all'>('all')
  const [abierta, setAbierta] = useState<Quote | null>(null)
  const [creando, setCreando] = useState(false)

  const query = useQuotes()

  const cotizaciones = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (query.data ?? []).filter((quote) => {
      if (estado !== 'all' && quote.status !== estado) return false
      if (!term) return true
      return (
        quote.quote_number.toLowerCase().includes(term) ||
        (quote.customer_name ?? '').toLowerCase().includes(term) ||
        (quote.customer_code ?? '').toLowerCase().includes(term)
      )
    })
  }, [query.data, search, estado])

  const isEmpty = !query.isPending && !query.isError && cotizaciones.length === 0
  const pager = usePagedRows(cotizaciones)

  const scope =
    tenant && activeCompanyId && activeStore
      ? {
          organizationId: tenant.organization_id,
          companyId: activeCompanyId,
          storeId: activeStore.id,
        }
      : null

  function tono(quote: Quote) {
    if (quote.status === 'accepted') return 'success' as const
    if (quote.status === 'rejected' || quote.status === 'expired') return 'error' as const
    if (quote.status === 'sent') return 'info' as const
    return 'default' as const
  }

  const cabecera = (
    <PageHeader
      icon={<RequestQuoteRoundedIcon />}
      title={t('trade.quotes.title')}
      subtitle={activeStore?.name ?? t('trade.quotes.subtitle')}
      actions={
        <Button
          variant="contained"
          disabled={!canWrite || !scope}
          onClick={() => {
            setAbierta(null)
            setCreando(true)
          }}
        >
          {t('trade.quotes.new')}
        </Button>
      }
    />
  )

  if (tenantStatus === 'loading') {
    return (
      <>
        {cabecera}
        <Card>
          <TableSkeleton columns={6} />
        </Card>
      </>
    )
  }

  if (!scope) {
    return (
      <>
        {cabecera}
        <Card>
          <EmptyState
            title={t('admin.store.none')}
            description={t('admin.store.noneBody')}
            icon={<StorefrontRoundedIcon fontSize="small" />}
          />
        </Card>
      </>
    )
  }

  return (
    <>
      {cabecera}

      <Stack spacing={2}>
        <Typography sx={{ color: 'var(--muted)' }}>{t('trade.quotes.help')}</Typography>

        <FilterBar
          actions={
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {(['all', 'draft', 'sent', 'accepted', 'rejected', 'expired'] as const).map((id) => (
                <Button
                  key={id}
                  size="small"
                  variant={estado === id ? 'contained' : 'text'}
                  onClick={() => setEstado(id)}
                >
                  {id === 'all' ? t('common.all') : t(`trade.status.${id}` as MessageKey)}
                </Button>
              ))}
            </Stack>
          }
        >
          <Box sx={{ minWidth: { xs: '100%', sm: 300 } }}>
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder={t('trade.quotes.search')}
              ariaLabel={t('trade.quotes.search')}
            />
          </Box>
        </FilterBar>

        <Card>
          {query.isPending && <TableSkeleton columns={6} />}
          {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
          {isEmpty && (
            <EmptyState
              title={search || estado !== 'all' ? t('trade.noResults') : t('trade.quotes.empty')}
              description={
                search || estado !== 'all' ? undefined : t('trade.quotes.emptyBody')
              }
              icon={<RequestQuoteRoundedIcon fontSize="small" />}
            />
          )}

          {!query.isPending && !query.isError && cotizaciones.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('trade.field.number')}</TableCell>
                  <TableCell>{t('trade.field.customer')}</TableCell>
                  <TableCell>{t('trade.field.validUntil')}</TableCell>
                  <TableCell align="right">{t('trade.field.grandTotal')}</TableCell>
                  <TableCell>{t('common.status')}</TableCell>
                  <TableCell align="right">{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pager.rows.map((quote) => (
                  <TableRow key={quote.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{quote.quote_number}</TableCell>
                    <TableCell>
                      <Box>
                        <Typography sx={{ fontSize: 13 }}>{quote.customer_name ?? '—'}</Typography>
                        <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>
                          {quote.customer_code ?? ''}
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <span>{quote.valid_until}</span>
                        {/* Caducada de hecho aunque la fila siga diciendo otra
                            cosa: nadie ha pasado a marcarla, y el precio de un
                            documento vencido no se honra. */}
                        {quote.status !== 'expired' && isExpired(quote.valid_until) && (
                          <StatusChip tone="warning" label={t('trade.quotes.lapsed')} />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800 }}>
                      {formatMoney(Number(quote.grand_total), quote.currency, locale)}
                    </TableCell>
                    <TableCell>
                      <StatusChip
                        tone={tono(quote)}
                        label={t(`trade.status.${quote.status}` as MessageKey)}
                      />
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() => {
                          setCreando(false)
                          setAbierta(quote)
                        }}
                      >
                        {t('common.open')}
                      </Button>
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

      <QuoteDrawer
        open={creando || abierta !== null}
        quote={abierta}
        scope={scope}
        currency={activeStore?.currency ?? 'PEN'}
        canWrite={canWrite}
        onClose={() => {
          setCreando(false)
          setAbierta(null)
        }}
      />
    </>
  )
}
