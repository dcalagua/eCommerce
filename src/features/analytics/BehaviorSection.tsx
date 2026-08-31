import AddShoppingCartRoundedIcon from '@mui/icons-material/AddShoppingCartRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import FilterAltRoundedIcon from '@mui/icons-material/FilterAltRounded'
import LocalOfferRoundedIcon from '@mui/icons-material/LocalOfferRounded'
import ManageSearchRoundedIcon from '@mui/icons-material/ManageSearchRounded'
import PaymentsRoundedIcon from '@mui/icons-material/PaymentsRounded'
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded'
import RemoveShoppingCartRoundedIcon from '@mui/icons-material/RemoveShoppingCartRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import ShoppingCartCheckoutRoundedIcon from '@mui/icons-material/ShoppingCartCheckoutRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import { Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { NotEntitledState } from '@/features/capabilities/CapabilityGate'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { AppIcon } from '@/shared/ui/AppIcon'
import { MiniBar } from '@/shared/ui/MiniBar'
import { SectionCard } from '@/shared/ui/SectionCard'
import { StatusChip } from '@/shared/ui/StatusChip'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { T } from '@/theme/tokens'
import { isNotEntitled } from './errors'
import { useAnalyticsWindow, useFunnel, useSearchTerms } from './hooks'
import { ANALYTICS_EVENT_TYPES, type AnalyticsRange } from './types'

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
 * Un icono por hecho: el embudo se recorre de arriba abajo y el icono es lo que
 * deja distinguir «empezó la compra» de «terminó la compra» sin leer las dos
 * filas enteras. Decorativo — el nombre del hecho va al lado.
 */
const EVENT_ICON: Record<string, ReactNode> = {
  product_view: <VisibilityRoundedIcon />,
  search: <SearchRoundedIcon />,
  add_to_cart: <AddShoppingCartRoundedIcon />,
  checkout_started: <ShoppingCartCheckoutRoundedIcon />,
  checkout_completed: <PaymentsRoundedIcon />,
  cart_abandoned: <RemoveShoppingCartRoundedIcon />,
  order_created: <ReceiptLongRoundedIcon />,
  order_completed: <CheckCircleRoundedIcon />,
  promotion_used: <LocalOfferRoundedIcon />,
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

/**
 * Orden del embudo: el del enum de la base, que es el del recorrido real —ver,
 * buscar, añadir, pagar—.
 *
 * Un embudo ordenado por cantidad no es un embudo: es un ranking, y deja de
 * responder a la única pregunta que justifica la forma, que es «dónde se cae la
 * gente». Un hecho que no esté en la lista canónica va al final, sin inventarle
 * un sitio.
 */
function funnelOrder(type: string): number {
  const index = (ANALYTICS_EVENT_TYPES as readonly string[]).indexOf(type)
  return index === -1 ? ANALYTICS_EVENT_TYPES.length : index
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

  const rows = [...(funnel.data ?? [])].sort(
    (a, b) => funnelOrder(a.event_type) - funnelOrder(b.event_type),
  )
  const total = rows.reduce((sum, row) => sum + row.events, 0)
  // El largo de cada barra se mide contra el paso MÁS ALTO, que es la boca del
  // embudo. Contra el total sería contra una suma de cosas distintas —vistas
  // más pedidos— y no significaría nada.
  const funnelMax = Math.max(...rows.map((row) => row.events), 0)

  const termRows = terms.data ?? []
  const termsMax = Math.max(...termRows.map((row) => row.searches), 0)

  return (
    <Stack sx={{ gap: 2.5 }}>
      <SectionCard
        icon={<FilterAltRoundedIcon />}
        title={t('analytics.funnel.title')}
        subtitle={t('analytics.funnel.subtitle')}
      >
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
                <TableCell align="right" sx={{ width: 180 }}>
                  {t('analytics.funnel.events')}
                </TableCell>
                <TableCell align="right">{t('analytics.funnel.sessions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.event_type} hover>
                  <TableCell>
                    <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
                      <AppIcon tone="neutral" size="sm">
                        {EVENT_ICON[row.event_type] ?? <VisibilityRoundedIcon />}
                      </AppIcon>
                      <Typography sx={{ fontSize: T.body, fontWeight: 600 }}>
                        {eventLabel(row.event_type, t)}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ width: 180 }}>
                    <Typography className="tnum" sx={{ fontSize: T.body, fontWeight: 800 }}>
                      {row.events}
                    </Typography>
                    <MiniBar value={row.events} max={funnelMax} />
                  </TableCell>
                  <TableCell align="right" className="tnum">
                    {row.sessions ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard
        icon={<ManageSearchRoundedIcon />}
        title={t('analytics.terms.title')}
        subtitle={t('analytics.terms.subtitle')}
        meta={termRows.length > 0 ? String(termRows.length) : undefined}
      >
        {terms.isPending ? (
          <TableSkeleton columns={3} />
        ) : termRows.length === 0 ? (
          <EmptyState
            title={t('analytics.terms.empty')}
            description={t('analytics.terms.emptyBody')}
          />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('analytics.terms.term')}</TableCell>
                <TableCell align="right" sx={{ width: 180 }}>
                  {t('analytics.terms.searches')}
                </TableCell>
                <TableCell align="right">{t('analytics.terms.zero')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {termRows.map((row) => (
                <TableRow key={row.term} hover>
                  <TableCell>
                    <Typography sx={{ fontSize: T.body, fontWeight: 600 }}>{row.term}</Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ width: 180 }}>
                    <Typography className="tnum" sx={{ fontSize: T.body, fontWeight: 800 }}>
                      {row.searches}
                    </Typography>
                    <MiniBar value={row.searches} max={termsMax} />
                  </TableCell>
                  <TableCell align="right">
                    {row.zero_results > 0 ? (
                      // Lo accionable de esta tabla entera: un término buscado y
                      // sin resultados es catálogo que falta o un sinónimo que
                      // falta (P11). Se resalta porque si no, se pierde entre
                      // los que sí encontraron.
                      <StatusChip tone="warning" label={String(row.zero_results)} />
                    ) : (
                      <span className="tnum">{row.zero_results}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </Stack>
  )
}
