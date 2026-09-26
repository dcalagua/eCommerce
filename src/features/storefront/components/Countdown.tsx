import { Box, Stack, Typography } from '@mui/material'
import { useEffect, useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import { partesRestantes } from '../feria'

/**
 * El tiempo que le queda a una campaña, en segundos, desde su `ends_at` REAL.
 *
 * Sin fecha de fin no hay reloj: un contador que se reinicia en cada visita es
 * una urgencia inventada, y eso se paga en confianza. Cuando llega a cero
 * devuelve `null` y el reloj desaparece en vez de quedarse en «00:00:00».
 */
function useCountdown(endsAt: string | null): ReturnType<typeof partesRestantes> {
  const [ahora, setAhora] = useState(() => Date.now())
  useEffect(() => {
    if (!endsAt) return
    const id = window.setInterval(() => setAhora(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [endsAt])
  return endsAt ? partesRestantes(endsAt, ahora) : null
}

const dos = (n: number) => String(n).padStart(2, '0')

/**
 * Los dígitos del reloj, en dos formas: cajas (la portada) o una línea (la
 * banda relámpago). El texto completo va en `aria-label` y el reloj NO se
 * anuncia a cada segundo: `role="timer"` ya es `aria-live="off"`.
 */
export function Countdown({
  endsAt,
  variant = 'boxes',
}: {
  endsAt: string | null
  variant?: 'boxes' | 'inline'
}) {
  const { t } = useI18n()
  const partes = useCountdown(endsAt)
  if (!partes) return null

  const unidades = [
    ...(partes.dias > 0 ? [{ valor: partes.dias, etiqueta: t('store.countdown.days') }] : []),
    { valor: partes.horas, etiqueta: t('store.countdown.hours') },
    { valor: partes.minutos, etiqueta: t('store.countdown.minutes') },
    ...(partes.dias > 0 ? [] : [{ valor: partes.segundos, etiqueta: t('store.countdown.seconds') }]),
  ]
  const leido = unidades.map((u) => `${u.valor} ${u.etiqueta}`).join(', ')

  if (variant === 'inline') {
    return (
      <Box component="span" role="timer" aria-label={leido} className="tnum" data-countdown="inline">
        {unidades.map((u) => dos(u.valor)).join(':')}
      </Box>
    )
  }

  return (
    <Stack direction="row" role="timer" aria-label={leido} data-countdown="boxes" sx={{ gap: 1 }}>
      {unidades.map((u) => (
        <Stack
          key={u.etiqueta}
          aria-hidden
          sx={{
            alignItems: 'center',
            minWidth: { xs: 48, md: 56 },
            px: 1,
            py: 0.75,
            borderRadius: 'var(--sf-radius-sm)',
            bgcolor: 'rgba(0, 0, 0, 0.32)',
          }}
        >
          <Typography className="tnum" sx={{ fontSize: { xs: 20, md: 24 }, fontWeight: 800, lineHeight: 1.1 }}>
            {dos(u.valor)}
          </Typography>
          <Typography sx={{ fontSize: 10.5, fontWeight: 600, opacity: 0.85 }}>{u.etiqueta}</Typography>
        </Stack>
      ))}
    </Stack>
  )
}
