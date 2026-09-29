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

  // En cajas los segundos van SIEMPRE: un reloj que solo cambia cada minuto
  // parece una fecha impresa, y lo que lo hace reloj es verlo avanzar. En la
  // línea de la banda relámpago se quedan fuera con días, para que quepa.
  const conSegundos = variant === 'boxes' || partes.dias === 0
  const unidades = [
    ...(partes.dias > 0 ? [{ valor: partes.dias, etiqueta: t('store.countdown.days') }] : []),
    { valor: partes.horas, etiqueta: t('store.countdown.hours') },
    { valor: partes.minutos, etiqueta: t('store.countdown.minutes') },
    ...(conSegundos ? [{ valor: partes.segundos, etiqueta: t('store.countdown.seconds') }] : []),
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
            minWidth: { xs: 46, md: 58 },
            px: 1,
            py: { xs: 0.625, md: 0.875 },
            borderRadius: 'var(--sf-radius-sm)',
            // Cristal sobre el degradado de la tienda: se lee en cualquier
            // acento sin meter un color que no sea suyo.
            bgcolor: 'rgba(255, 255, 255, 0.14)',
            border: '1px solid rgba(255, 255, 255, 0.24)',
            boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.18)',
            backdropFilter: 'blur(6px)',
          }}
        >
          <Typography className="tnum" sx={{ fontSize: { xs: 20, md: 26 }, fontWeight: 800, lineHeight: 1.1 }}>
            {dos(u.valor)}
          </Typography>
          <Typography
            sx={{ fontSize: 10, fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.06em' }}
          >
            {u.etiqueta}
          </Typography>
        </Stack>
      ))}
    </Stack>
  )
}
