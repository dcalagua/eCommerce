import { Card, Chip, Stack, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatDateTime } from '@/shared/lib/format'
import { ErrorState, UnauthorizedState } from '@/shared/ui/states'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { isForbidden } from './errors'
import { useOpsHealth } from './hooks'
import type { QueueDepth } from './types'

/**
 * Salud del tenant. Y SOLO del tenant.
 *
 * `ops_health` no acepta ningún identificador de organización ni de sociedad:
 * los deriva del JWT. Eso es lo que cumple el requisito de la fase —«health
 * relevante al tenant sin revelar datos de otros tenants»— de forma estructural
 * y no por acuerdo: no existe el parámetro que habría que validar.
 *
 * ## Qué se pinta y qué no
 *
 * No hay porcentajes de disponibilidad ni gráficas de latencia: no hay serie
 * con la que calcularlos, y una barra inventada es peor que su ausencia. Lo que
 * se enseña son cuatro cosas que un operador puede accionar hoy mismo:
 * profundidad de cola con la EDAD de lo más viejo, lo que se rompió en 24 h,
 * los checkouts atascados y la frescura del contexto del hub.
 */

function ageLabel(seconds: number | null | undefined, t: (k: 'ops.health.none') => string): string {
  if (seconds === null || seconds === undefined) return t('ops.health.none')
  if (seconds < 60) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}

function QueueCard({
  title,
  queue,
  waitingLabel,
}: {
  title: string
  queue: QueueDepth
  waitingLabel: string
}) {
  const { t } = useI18n()
  const waiting = queue.pending ?? queue.unprocessed ?? 0
  const stuck = (queue.failed ?? 0) + (queue.dead ?? 0)
  return (
    <Card sx={{ p: 2, flex: '1 1 220px', minWidth: 200 }}>
      <Typography sx={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>{title}</Typography>
      <Stack direction="row" sx={{ gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: 24, fontWeight: 800 }}>{waiting}</Typography>
        <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>{waitingLabel}</Typography>
      </Stack>
      <Stack direction="row" sx={{ gap: 0.75, mt: 1, flexWrap: 'wrap' }}>
        {stuck > 0 && (
          <Chip size="small" color="error" label={`${t('ops.health.stuck')}: ${stuck}`} />
        )}
        {/* La EDAD de lo más viejo, no solo cuántos hay: una cola de 200 que se
            vacía sola está sana; una de 3 parada desde ayer, no. */}
        <Chip
          size="small"
          variant="outlined"
          label={`${t('ops.health.oldest')}: ${ageLabel(queue.oldest_pending_seconds, t)}`}
        />
      </Stack>
    </Card>
  )
}

export function HealthSection({ storeId }: { storeId: string | null }) {
  const { t, locale } = useI18n()
  const health = useOpsHealth(storeId)

  if (isForbidden(health.error)) {
    return <UnauthorizedState title={t('ops.error.forbidden')} description={t('ops.forbiddenBody')} />
  }
  if (health.isError) return <ErrorState error={health.error} onRetry={() => void health.refetch()} />
  if (health.isPending) return <TableSkeleton columns={4} />

  const data = health.data
  const open = Object.entries(data.open_incidents)
  const failureRate =
    data.last_24h.checkouts_total > 0
      ? Math.round((data.last_24h.checkouts_failed / data.last_24h.checkouts_total) * 100)
      : null

  return (
    <Stack sx={{ gap: 2.5 }}>
      <Stack direction="row" sx={{ gap: 1.5, flexWrap: 'wrap' }}>
        <QueueCard
          title={t('ops.health.domainEvents')}
          queue={data.queues.domain_events}
          waitingLabel={t('ops.health.waiting')}
        />
        <QueueCard
          title={t('ops.health.outbox')}
          queue={data.queues.integration_outbox}
          waitingLabel={t('ops.health.waiting')}
        />
        <QueueCard
          title={t('ops.health.inbox')}
          queue={data.queues.integration_inbox}
          waitingLabel={t('ops.health.unprocessed')}
        />
      </Stack>

      <Card sx={{ p: 2 }}>
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 800, mb: 1 }}>
          {t('ops.health.last24h')}
        </Typography>
        <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Chip
            size="small"
            color={data.last_24h.checkouts_failed > 0 ? 'error' : 'default'}
            label={`${t('ops.health.checkoutsFailed')}: ${data.last_24h.checkouts_failed}${
              // El porcentaje solo cuando hay denominador. Sin intentos no hay
              // tasa, y un «0 %» ahí diría que todo va bien cuando lo que pasa
              // es que no se ha intentado comprar.
              failureRate === null ? '' : ` (${failureRate} %)`
            }`}
          />
          <Chip
            size="small"
            color={data.last_24h.payments_failed > 0 ? 'error' : 'default'}
            label={`${t('ops.health.paymentsFailed')}: ${data.last_24h.payments_failed}`}
          />
          <Chip
            size="small"
            color={data.last_24h.integrations_failed > 0 ? 'warning' : 'default'}
            label={`${t('ops.health.integrationsFailed')}: ${data.last_24h.integrations_failed}`}
          />
          <Chip
            size="small"
            color={data.stuck_checkouts > 0 ? 'warning' : 'default'}
            label={`${t('ops.health.stuckCheckouts')}: ${data.stuck_checkouts}`}
          />
          <Chip
            size="small"
            variant="outlined"
            label={`${t('ops.health.slow')}: ${data.slow_operations.count}${
              data.slow_operations.max_ms === null ? '' : ` · ${data.slow_operations.max_ms} ms`
            }`}
          />
        </Stack>
      </Card>

      <Card sx={{ p: 2 }}>
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 800, mb: 1 }}>
          {t('ops.health.incidents')}
        </Typography>
        {open.length === 0 ? (
          <Typography sx={{ color: 'var(--muted)' }}>{t('ops.health.noIncidents')}</Typography>
        ) : (
          <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
            {open.map(([severity, count]) => (
              <Chip
                key={severity}
                size="small"
                color={severity === 'critical' || severity === 'error' ? 'error' : 'warning'}
                label={`${severity}: ${count}`}
              />
            ))}
          </Stack>
        )}
      </Card>

      <Card sx={{ p: 2 }}>
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 800, mb: 1 }}>
          {t('ops.health.platform')}
        </Typography>
        <Typography sx={{ color: 'var(--muted)' }}>
          {data.platform_context === null
            ? t('ops.health.platformNever')
            : t('ops.health.platformSynced')
                .replace('{source}', data.platform_context.source)
                .replace(
                  '{at}',
                  data.platform_context.synced_at === null
                    ? t('ops.health.none')
                    : formatDateTime(data.platform_context.synced_at, locale),
                )}
        </Typography>
      </Card>

      <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>
        {t('ops.health.generatedAt').replace('{at}', formatDateTime(data.generated_at, locale))}
      </Typography>
    </Stack>
  )
}
