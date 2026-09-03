import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded'
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
import { FilterBar } from '@/shared/ui/FilterBar'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SearchField } from '@/shared/ui/SearchField'
import { StatusChip } from '@/shared/ui/StatusChip'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { AssortmentDrawer } from './AssortmentDrawer'
import { useAssortments } from './hooks'
import type { Assortment } from './types'

/**
 * Surtidos: qué puede comprar cada cliente del canal.
 *
 * ## Lista blanca y lista negra son lo mismo con el signo cambiado
 *
 * Un distribuidor necesita las dos: «solo estos 200» para el canal moderno y
 * «todo menos estos 5» para el tradicional. Se distinguen en la propia lista con
 * una etiqueta y no escondidas dentro del cajón, porque confundirlas invierte
 * exactamente el catálogo que ve el cliente.
 *
 * ## La precedencia no se decide aquí
 *
 * `ebim.assortment_for_customer` es el ÚNICO sitio donde vive la regla
 * (cliente > segmento > territorio > canal > tienda). Esta pantalla administra
 * las listas; si además calculara cuál gana, habría dos verdades sobre qué ve
 * un cliente y acabarían discrepando.
 */
export function AssortmentsPage() {
  const { t } = useI18n()
  const { tenant, activeStore, activeCompanyId, status: tenantStatus, can } = useTenant()
  const canWrite = can('catalog.write')

  const [search, setSearch] = useState('')
  const [abierto, setAbierto] = useState<Assortment | null>(null)
  const [creando, setCreando] = useState(false)

  const query = useAssortments()

  const surtidos = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = query.data ?? []
    if (!term) return all
    return all.filter(
      (row) => row.code.toLowerCase().includes(term) || row.name.toLowerCase().includes(term),
    )
  }, [query.data, search])

  const isEmpty = !query.isPending && !query.isError && surtidos.length === 0

  const scope =
    tenant && activeCompanyId && activeStore
      ? {
          organizationId: tenant.organization_id,
          companyId: activeCompanyId,
          storeId: activeStore.id,
        }
      : null

  const cabecera = (
    <PageHeader
      icon={<Inventory2RoundedIcon />}
      title={t('trade.assortments.title')}
      subtitle={activeStore?.name ?? t('trade.assortments.subtitle')}
      actions={
        <Button
          variant="contained"
          disabled={!canWrite || !scope}
          onClick={() => {
            setAbierto(null)
            setCreando(true)
          }}
        >
          {t('trade.assortments.new')}
        </Button>
      }
    />
  )

  if (tenantStatus === 'loading') {
    return (
      <>
        {cabecera}
        <Card>
          <TableSkeleton columns={4} />
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
        <Typography sx={{ color: 'var(--muted)' }}>{t('trade.assortments.help')}</Typography>

        <FilterBar>
          <Box sx={{ minWidth: { xs: '100%', sm: 300 } }}>
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder={t('trade.assortments.search')}
              ariaLabel={t('trade.assortments.search')}
            />
          </Box>
        </FilterBar>

        <Card>
          {query.isPending && <TableSkeleton columns={4} />}
          {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
          {isEmpty && (
            <EmptyState
              title={search ? t('trade.noResults') : t('trade.assortments.empty')}
              description={search ? undefined : t('trade.assortments.emptyBody')}
              icon={<Inventory2RoundedIcon fontSize="small" />}
            />
          )}

          {!query.isPending && !query.isError && surtidos.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('trade.field.code')}</TableCell>
                  <TableCell>{t('trade.field.name')}</TableCell>
                  <TableCell>{t('trade.field.listKind')}</TableCell>
                  <TableCell>{t('common.status')}</TableCell>
                  <TableCell align="right">{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {surtidos.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{row.code}</TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>
                      {/* Blanca o negra en la LISTA, no dentro del cajón:
                          confundirlas invierte el catálogo del cliente. */}
                      <StatusChip
                        tone={row.is_allow_list ? 'info' : 'warning'}
                        label={
                          row.is_allow_list ? t('trade.list.allow') : t('trade.list.block')
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <StatusChip
                        tone={row.is_active ? 'success' : 'default'}
                        label={row.is_active ? t('common.active') : t('common.inactive')}
                      />
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() => {
                          setCreando(false)
                          setAbierto(row)
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
        </Card>
      </Stack>

      <AssortmentDrawer
        open={creando || abierto !== null}
        assortment={abierto}
        scope={scope}
        canWrite={canWrite}
        onClose={() => {
          setCreando(false)
          setAbierto(null)
        }}
      />
    </>
  )
}
