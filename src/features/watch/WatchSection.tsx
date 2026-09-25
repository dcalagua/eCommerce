import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded'
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { useMemo, useState } from 'react'
import { AiFeedbackButtons } from '@/features/ai/AiFeedbackButtons'
import { useAiFeature } from '@/features/ai/hooks'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { AppIcon } from '@/shared/ui/AppIcon'
import { T } from '@/theme/tokens'
import { WatchCard } from './WatchList'
import { useWatch, useWatchAnalysis } from './useWatch'

/** Cuántas tarjetas se ven sin pedirlo: las demás van tras «Ver N más». */
const VISIBLES = 4

/**
 * EBIM Crew: el vigilante de la tienda, dentro del Resumen.
 *
 * La lista sale de reglas de SQL y está ahí desde que se abre la pantalla, sin
 * gastar una consulta de IA. El botón «Ejecutar análisis» es lo único que llama
 * al modelo, y solo para ORDENAR los avisos y decir por qué: las cifras siguen
 * siendo las de la base y ninguna acción se ejecuta sola.
 *
 * Se calla del todo cuando no hay nada que mirar: un bloque fijo que casi
 * siempre dice «todo bien» enseña a ignorarlo, y el día que diga algo tampoco
 * se leerá.
 */
export function WatchSection() {
  const { t, locale } = useI18n()
  const watch = useWatch()
  const analysis = useWatchAnalysis()
  const { availability } = useAiFeature('insights')
  const [verTodo, setVerTodo] = useState(false)

  const items = useMemo(() => watch.data?.items ?? [], [watch.data])
  const critical = watch.data?.critical ?? 0

  // Con análisis, el orden y el porqué son los del modelo; sin él, el de las
  // reglas (primero lo crítico). La lista es la MISMA en los dos casos.
  const ordenados = useMemo(() => {
    const orden = analysis.data?.data?.order
    if (!orden) return items
    const posicion = new Map(orden.map((key, index) => [key, index]))
    return [...items].sort((a, b) => (posicion.get(a.key) ?? 99) - (posicion.get(b.key) ?? 99))
  }, [items, analysis.data])

  const porque = useMemo(() => {
    const filas = analysis.data?.data?.reasons ?? []
    return new Map(filas.map((fila) => [fila.key, fila.why]))
  }, [analysis.data])

  if (watch.isPending || watch.isError || items.length === 0) return null

  const visibles = verTodo ? ordenados : ordenados.slice(0, VISIBLES)
  const ocultas = ordenados.length - visibles.length
  const motivo = analysis.data?.motivo ?? null

  return (
    <Box
      sx={{
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        bgcolor: 'var(--card)',
        p: { xs: 1.5, md: 2 },
      }}
    >
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', mb: 1.5 }}>
        <AppIcon tone="accent" size="sm">
          <GroupsRoundedIcon fontSize="small" />
        </AppIcon>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800 }}>
            {t('watch.title')}
          </Typography>
          <Typography sx={{ fontSize: 12, color: 'var(--muted)' }} noWrap>
            {t('watch.subtitle')}
          </Typography>
        </Box>

        {/* El contador de la suite: cuántos avisos hay, en rojo si alguno es
            crítico. Es lo primero que se mira desde lejos. */}
        <Box
          className="tnum"
          aria-label={t('watch.open.panelWith').replace('{n}', String(items.length))}
          sx={{
            minWidth: 26,
            px: 0.9,
            py: 0.15,
            borderRadius: 999,
            textAlign: 'center',
            fontSize: 12.5,
            fontWeight: 800,
            color: '#fff',
            bgcolor: critical > 0 ? 'var(--danger)' : 'var(--warning)',
          }}
        >
          {items.length}
        </Box>

        <Typography sx={{ fontSize: 12, color: 'var(--muted)', display: { xs: 'none', md: 'block' } }}>
          {t('watch.deterministic')}
        </Typography>

        <Tooltip title={t('common.refresh')}>
          <span>
            <IconButton
              aria-label={t('common.refresh')}
              onClick={() => void watch.refetch()}
              disabled={watch.isFetching}
              size="small"
            >
              <RefreshRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Stack spacing={1.25}>
        {visibles.map((finding) => (
          <WatchCard key={finding.key} finding={finding} why={porque.get(finding.key) ?? null} />
        ))}
      </Stack>

      {ordenados.length > VISIBLES && (
        <Box sx={{ textAlign: 'center', mt: 1 }}>
          <Button size="small" variant="text" onClick={() => setVerTodo((v) => !v)}>
            {verTodo ? t('watch.seeLess') : t('watch.seeMore').replace('{n}', String(ocultas))}
          </Button>
        </Box>
      )}

      {/* El análisis es opcional y se paga: por eso es un botón y dice lo que
          cuesta. Sin la funcionalidad contratada ni siquiera se enseña. */}
      {availability !== 'forbidden' && availability !== 'loading' && (
        <Stack spacing={0.75} sx={{ mt: 1.5 }}>
          <Button
            fullWidth
            variant="outlined"
            startIcon={<AutoAwesomeRoundedIcon fontSize="small" />}
            disabled={analysis.isPending || availability !== 'available'}
            onClick={() => analysis.mutate({ locale })}
          >
            {analysis.isPending ? t('watch.analyzing') : t('watch.analyze')}
          </Button>

          {analysis.data?.data && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                {analysis.data.data.headline}
              </Typography>
              {analysis.data.interactionId && (
                <AiFeedbackButtons interactionId={analysis.data.interactionId} />
              )}
            </Stack>
          )}

          {!analysis.data?.data && !analysis.isPending && (
            <Typography sx={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              {t('watch.analyze.hint')}
            </Typography>
          )}

          {motivo && (
            <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>{t(`ai.motivo.${motivo}` as MessageKey)}</Typography>
          )}
          {availability === 'not_entitled' && (
            <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>{t('watch.analyze.notEntitled')}</Typography>
          )}
          {availability === 'quota_exhausted' && (
            <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>{t('watch.analyze.noQuota')}</Typography>
          )}
        </Stack>
      )}
    </Box>
  )
}
