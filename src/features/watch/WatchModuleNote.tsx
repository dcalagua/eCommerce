import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import { Box, Button, Stack, Typography } from '@mui/material'
import { useLocation } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { watchModuleFromPath } from './modules'
import { useWatch } from './useWatch'

/**
 * Una línea en la cabecera del módulo: «aquí hay dos avisos».
 *
 * No repite cifras ni tarjetas —eso ya lo enseña el módulo y lo enseña el
 * panel—: solo dice cuántos avisos de ESTA pantalla están abiertos y abre el
 * centro de vigilancia, que es donde se atienden. Sale de la misma consulta que
 * el carril del Resumen, así que no cuesta una lectura más.
 *
 * Se calla cuando no hay nada, cuando la pantalla no es de ningún módulo
 * vigilado y mientras la consulta no ha respondido: un hueco que parpadea en
 * cada navegación molesta más de lo que avisa.
 */
export function WatchModuleNote({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n()
  const location = useLocation()
  const watch = useWatch()

  const modulo = watchModuleFromPath(location.pathname)
  if (!modulo || watch.isPending || watch.isError) return null

  const propios = (watch.data?.items ?? []).filter((item) => item.module === modulo)
  if (propios.length === 0) return null

  const critico = propios.some((item) => item.severity === 'critica')
  const color = critico ? 'var(--red)' : 'var(--amber)'
  const texto =
    propios.length === 1
      ? t('watch.moduleNote.one')
      : t('watch.moduleNote.many').replace('{n}', String(propios.length))

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        mb: 2,
        px: 1.5,
        py: 0.75,
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`,
        bgcolor: critico ? 'var(--red-soft)' : 'var(--amber-soft)',
      }}
    >
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flex: 1, minWidth: 0 }}>
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: color }} aria-hidden />
        <Typography sx={{ fontSize: 13, fontWeight: 700, color }}>{texto}</Typography>
      </Stack>
      <Button size="small" endIcon={<ArrowForwardRoundedIcon fontSize="small" />} onClick={onOpen}>
        {t('watch.moduleNote.open')}
      </Button>
    </Box>
  )
}
