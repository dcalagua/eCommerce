import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded'
import { Card } from '@mui/material'
import { useMemo } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SectionTabs } from '@/shared/ui/SectionTabs'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState } from '@/shared/ui/states'
import { AlertsSection } from './AlertsSection'
import { LevelsSection } from './LevelsSection'
import { MovementsSection } from './MovementsSection'
import { WarehousesSection } from './WarehousesSection'

/**
 * Inventario: dónde hay, cuánto queda, por qué cambió y qué hay que mirar.
 *
 * Cuatro caras de la misma pregunta, así que van en tabs centrados con
 * deep-link `#hash` (regla de suite §8) y no en cuatro entradas de menú. Las
 * alertas están al lado de las existencias y no escondidas en el panel de
 * inicio por una razón concreta: un almacén se descuadra despacio, y el aviso
 * solo sirve si aparece donde se corrige.
 *
 * La ruta está gateada por `inventory.multiwarehouse`: sin el módulo
 * contratado, `CapabilityGate` pinta «no está en tu plan» y esta pantalla no se
 * monta — el tenant sigue vendiendo contra la existencia del catálogo, que es
 * baseline. La autoridad, como siempre, es la RLS.
 */
export function InventoryPage() {
  const { t } = useI18n()
  const { activeStore, activeCompanyId, tenant, status } = useTenant()

  const items = useMemo(
    () => [
      { id: 'almacenes', label: t('inventory.tab.warehouses'), content: <WarehousesSection /> },
      { id: 'existencias', label: t('inventory.tab.levels'), content: <LevelsSection /> },
      { id: 'movimientos', label: t('inventory.tab.movements'), content: <MovementsSection /> },
      { id: 'alertas', label: t('inventory.tab.alerts'), content: <AlertsSection /> },
    ],
    [t],
  )

  // Mismo criterio que el resto del backoffice: mientras el espacio de trabajo
  // se resuelve NO se afirma que no hay tiendas.
  if (status === 'loading') {
    return (
      <>
        <PageHeader title={t('inventory.title')} subtitle={t('inventory.subtitle')} />
        <Card>
          <TableSkeleton columns={5} />
        </Card>
      </>
    )
  }

  if (!tenant || !activeCompanyId) {
    return (
      <>
        <PageHeader title={t('inventory.title')} subtitle={t('inventory.subtitle')} />
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
        title={t('inventory.title')}
        subtitle={activeStore?.name ?? t('inventory.subtitle')}
      />
      <SectionTabs items={items} ariaLabel={t('inventory.title')} />
    </>
  )
}
