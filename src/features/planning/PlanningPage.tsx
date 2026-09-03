import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded'
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded'
import { Card } from '@mui/material'
import { useMemo } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SectionTabs } from '@/shared/ui/SectionTabs'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState } from '@/shared/ui/states'
import { ForecastsSection } from './ForecastsSection'
import { SuggestionsSection } from './SuggestionsSection'

/**
 * Planificación: qué conviene pedir y cuánto se espera vender.
 *
 * Dos pestañas del mismo asunto en dos escalas: la previsión mira el agregado
 * —producto, periodo, territorio— y el sugerido lo baja a un cliente concreto.
 * Separarlas en dos entradas de menú obligaría a saltar de módulo para
 * contrastar lo que se espera con lo que se va a pedir.
 *
 * **La ruta va gateada por `planning.demand`.** Sin la capacidad no se ve una
 * tabla vacía —que parecería un fallo— sino qué módulo falta.
 */
export function PlanningPage() {
  const { t } = useI18n()
  const { activeStore, activeCompanyId, tenant, status } = useTenant()

  const items = useMemo(
    () => [
      { id: 'sugerido', label: t('planning.tab.suggestions'), content: <SuggestionsSection /> },
      { id: 'prevision', label: t('planning.tab.forecasts'), content: <ForecastsSection /> },
    ],
    [t],
  )

  if (status === 'loading') {
    return (
      <>
        <PageHeader
          icon={<InsightsRoundedIcon />}
          title={t('planning.title')}
          subtitle={t('planning.subtitle')}
        />
        <Card>
          <TableSkeleton columns={5} />
        </Card>
      </>
    )
  }

  if (!tenant || !activeCompanyId) {
    return (
      <>
        <PageHeader
          icon={<InsightsRoundedIcon />}
          title={t('planning.title')}
          subtitle={t('planning.subtitle')}
        />
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
      <PageHeader
        icon={<InsightsRoundedIcon />}
        title={t('planning.title')}
        subtitle={activeStore?.name ?? t('planning.subtitle')}
      />
      <SectionTabs items={items} ariaLabel={t('planning.title')} />
    </>
  )
}
