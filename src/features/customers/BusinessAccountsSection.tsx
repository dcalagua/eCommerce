import ApartmentOutlinedIcon from '@mui/icons-material/ApartmentOutlined'
import {
  Box,
  Button,
  Card,
  Chip,
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
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { BusinessAccountDrawer } from './BusinessAccountDrawer'
import { useBusinessAccounts } from './hooks'
import type { BusinessAccount } from './types'

/**
 * Cuentas B2B.
 *
 * La cuenta es la ACTIVACIÓN del portal sobre un cliente empresa: no se crea
 * desde cero, se elige a qué cliente se le abre. Por eso el alta pide un
 * cliente existente de tipo empresa en vez de duplicar aquí razón social, RUC y
 * direcciones — que es exactamente el fork de ficha que el principio 2 del
 * contrato prohíbe.
 */
export function BusinessAccountsSection() {
  const { t } = useI18n()
  const { tenant, activeCompanyId, can } = useTenant()
  const canWrite = can('tenant.manage')

  const [search, setSearch] = useState('')
  const [drawer, setDrawer] = useState<{ open: boolean; account: BusinessAccount | null }>({
    open: false,
    account: null,
  })

  const query = useBusinessAccounts()

  const accounts = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = query.data ?? []
    if (!term) return all
    return all.filter(
      (account) =>
        account.name.toLowerCase().includes(term) || account.code.toLowerCase().includes(term),
    )
  }, [query.data, search])

  const isEmpty = !query.isPending && !query.isError && accounts.length === 0

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('customers.accounts.help')}</Typography>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' } }}>
        <Box sx={{ flex: 1 }}>
          <SearchField value={search} onChange={setSearch} placeholder={t('customers.accounts.search')} />
        </Box>
        {canWrite && (
          <Button variant="contained" onClick={() => setDrawer({ open: true, account: null })}>
            {t('customers.accounts.new')}
          </Button>
        )}
      </Stack>

      <Card>
        {query.isPending && <TableSkeleton columns={5} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('customers.noResults') : t('customers.accounts.empty')}
            description={search ? undefined : t('customers.accounts.emptyBody')}
            icon={<ApartmentOutlinedIcon fontSize="small" />}
          />
        )}
        {!query.isPending && !query.isError && accounts.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('customers.field.code')}</TableCell>
                <TableCell>{t('customers.field.name')}</TableCell>
                <TableCell>{t('customers.field.approval')}</TableCell>
                <TableCell>{t('customers.field.purchaseOrder')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {accounts.map((account) => (
                <TableRow key={account.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>{account.code}</TableCell>
                  <TableCell>{account.name}</TableCell>
                  <TableCell>
                    {account.requires_approval
                      ? (account.approval_threshold ?? t('customers.approval.always'))
                      : t('common.no')}
                  </TableCell>
                  <TableCell>{account.purchase_order_required ? t('common.yes') : t('common.no')}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={account.is_active ? 'success' : 'default'}
                      label={account.is_active ? t('customers.field.active') : t('common.no')}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => setDrawer({ open: true, account })}
                      aria-label={`${t('common.edit')}: ${account.name}`}
                    >
                      {t('common.edit')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <BusinessAccountDrawer
        open={drawer.open}
        account={drawer.account}
        canWrite={canWrite}
        scope={
          tenant && activeCompanyId
            ? { organizationId: tenant.organization_id, companyId: activeCompanyId }
            : null
        }
        onClose={() => setDrawer({ open: false, account: null })}
      />
    </Stack>
  )
}
