import { StatusChip } from '@/shared/ui/StatusChip'
import {
  Card,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { NotEntitledState } from '@/features/capabilities/CapabilityGate'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { isNotEntitled } from './errors'
import { useAnalyticsWindow, useFunnel, useSearchTerms } from './hooks'
import type { AnalyticsRange } from './types'

/**
 * Comportamiento del comprador: lo que sale de la SERIE DE HECHOS.
 *
 * Es el módulo vendible (`analytics.advanced`), y el gate de verdad está en la
 * base: `ebim.assert_analytics_advanced` levanta `SIN_MODULO`. Esta pantalla
 * pinta «no está en tu plan» al reconocer ese código, no al mirar la lista de
 * capacidades — así el comportamiento es el mismo si alguien llama a la función
 * desde fuera de la aplicación.
 *
 * ## Los seis hechos que nunca tendrán sesión
 *
 * `sessions` llega en `null` para los seis hechos de servidor —pedido, cobro,
 * canje— porque no nacen en un navegador y no la tendrán nunca. Se pinta «—» y
 * no 0: un cero ahí se leería como «nadie», que es falso.
 */

const EVENT_LABEL: Record<string, MessageKey> = {
  product_view: 'analytics.event.productView',
  search: 'analytics.event.search',
  add_to_cart: 'analytics.event.addToCart',
  checkout_started: 'analytics.event.checkoutStarted',
  checkout_completed: 'analytics.event.checkoutCompleted',
  cart_abandoned: 'analytics.event.cartAbandoned',
  order_created: 'analytics.event.orderCreated',
  order_completed: 'analytics.event.orderCompleted',
  promotion_used: 'analytics.event.promotionUsed',
}

/**
 * Nombre legible del hecho, con respaldo al código crudo.
 *
 * El respaldo no es defensa contra lo imposible: el día que la base gane un
 * décimo hecho canónico, esta tabla lo enseñará con su código en vez de dejar
 * una celda vacía, y quien lo vea sabrá que falta traducirlo.
 */
function eventLabel(type: string, t: (key: MessageKey) => string): string {
  const key = EVENT_LABEL[type]
  return key ? t(key) : type
}

export function BehaviorSection({
  storeId,
  days,
}: {
  storeId: string | null
  days: AnalyticsRange
}) {
  const { t } = useI18n()
  const window = useAnalyticsWindow(storeId, days)
  const funnel = useFunnel(window, true)
  const terms = useSearchTerms(window, true)

  if (isNotEntitled(funnel.error) || isNotEntitled(terms.error)) {
    return <NotEntitledState id="analytics.advanced" />
  }
  if (funnel.isError) return <ErrorState error={funnel.error} onRetry={() => void funnel.refetch()} />
  if (funnel.isPending) return <TableSkeleton columns={3} />

  const rows = funnel.data ?? []
  const total = rows.reduce((sum, row) => sum + row.events, 0)

  return (
    <Stack sx={{ gap: 2.5 }}>
      <Card>
        <Typography component="h3" sx={{ p: 2, pb: 0, fontSize: 14, fontWeight: 800 }}>
          {t('analytics.funnel.title')}
        </Typography>
        {total === 0 ? (
          <EmptyState
            title={t('analytics.funnel.empty')}
            description={t('analytics.funnel.emptyBody')}
          />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('analytics.funnel.event')}</TableCell>
                <TableCell align="right">{t('analytics.funnel.events')}</TableCell>
                <TableCell align="right">{t('analytics.funnel.sessions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.event_type}>
                  <TableCell>{eventLabel(row.event_type, t)}</TableCell>
                  <TableCell align="right">{row.events}</TableCell>
                  <TableCell align="right">{row.sessions ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card>
        <Typography component="h3" sx={{ p: 2, pb: 0, fontSize: 14, fontWeight: 800 }}>
          {t('analytics.terms.title')}
        </Typography>
        {terms.isPending ? (
          <TableSkeleton columns={3} />
        ) : (terms.data ?? []).length === 0 ? (
          <EmptyState
            title={t('analytics.terms.empty')}
            description={t('analytics.terms.emptyBody')}
          />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('analytics.terms.term')}</TableCell>
                <TableCell align="right">{t('analytics.terms.searches')}</TableCell>
                <TableCell align="right">{t('analytics.terms.zero')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(terms.data ?? []).map((row) => (
                <TableRow key={row.term}>
                  <TableCell>{row.term}</TableCell>
                  <TableCell align="right">{row.searches}</TableCell>
                  <TableCell align="right">
                    {row.zero_results > 0 ? (
                      // Lo accionable de esta tabla entera: un término buscado y
                      // sin resultados es catálogo que falta o un sinónimo que
                      // falta (P11). Se resalta porque si no, se pierde entre
                      // los que sí encontraron.
                      <StatusChip tone="warning" label={String(row.zero_results)} />
                    ) : (
                      row.zero_results
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </Stack>
  )
}
