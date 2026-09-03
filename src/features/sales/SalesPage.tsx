import BadgeRoundedIcon from '@mui/icons-material/BadgeRounded'
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded'
import { Card } from '@mui/material'
import { useMemo } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SectionTabs } from '@/shared/ui/SectionTabs'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState } from '@/shared/ui/states'
import { RepsSection } from './RepsSection'

/**
 * Fuerza de ventas: quién vende y a quién.
 *
 * Una pestaña hoy —vendedores, con su cartera dentro del cajón— y sitio hecho
 * para las que faltan: territorios, rutas, visitas y comisiones. Se deja como
 * `SectionTabs` desde el principio y no como una tabla suelta porque añadir la
 * segunda pestaña después obliga a mover la primera, y eso cambia la URL que la
 * gente ya tenía guardada.
 *
 * **La ruta va gateada por `sales.force`.** Sin la capacidad no se ve una tabla
 * vacía —que parecería un fallo— sino qué módulo falta.
 */
export function SalesPage() {
  const { t } = useI18n()
  const { activeStore, activeCompanyId, tenant, status } = useTenant()

  const items = useMemo(
    () => [{ id: 'vendedores', label: t('sales.tab.reps'), content: <RepsSection /> }],
    [t],
  )

  // Mientras el espacio de trabajo se resuelve NO se afirma que no hay nada:
  // mismo criterio que el resto del backoffice.
  if (status === 'loading') {
    return (
      <>
        <PageHeader icon={<BadgeRoundedIcon />} title={t('sales.title')} subtitle={t('sales.subtitle')} />
        <Card>
          <TableSkeleton columns={5} />
        </Card>
      </>
    )
  }

  if (!tenant || !activeCompanyId) {
    return (
      <>
        <PageHeader icon={<BadgeRoundedIcon />} title={t('sales.title')} subtitle={t('sales.subtitle')} />
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
        icon={<BadgeRoundedIcon />}
        title={t('sales.title')}
        subtitle={activeStore?.name ?? t('sales.subtitle')}
      />
      <SectionTabs items={items} ariaLabel={t('sales.title')} />
    </>
  )
}
