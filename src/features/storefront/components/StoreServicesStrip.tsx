import LocalShippingRoundedIcon from '@mui/icons-material/LocalShippingRounded'
import LockRoundedIcon from '@mui/icons-material/LockRounded'
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded'
import SupportAgentRoundedIcon from '@mui/icons-material/SupportAgentRounded'
import { Box, Stack, Typography } from '@mui/material'
import type { ComponentType } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { TS } from '@/theme/tokens'

/**
 * La franja de servicio, justo bajo la portada.
 *
 * ## Qué problema resuelve
 *
 * Quien entra por primera vez a una botica en línea tiene cuatro dudas antes
 * que el precio: **cuándo llega**, **si es seguro pagar**, **quién le asesora**
 * y **si puede recogerlo**. Si esas respuestas están en el pie, se leen después
 * de decidir — o sea, no se leen.
 *
 * ## Por qué es fija y no contenido del CMS
 *
 * Porque no es una promesa del comercio, es una descripción de lo que la
 * plataforma ya hace: hay métodos de entrega, la pasarela va por el servidor,
 * el comercio atiende y hay retiro en tienda si lo configura. Un bloque
 * editable aquí invitaría a escribir «entrega en 24 h» a quien no la tiene, y
 * eso no es una portada más rica: es una promesa que se rompe en el primer
 * pedido.
 *
 * Los textos viven en i18n, así que traducen; los plazos concretos —«24-48 h»,
 * «+50 sedes»— NO se escriben aquí por lo mismo: dependen del comercio y de la
 * dirección, y quien los sabe es el paso de entrega del checkout.
 */
const SERVICIOS: readonly {
  readonly icon: ComponentType<{ sx?: object }>
  readonly title: MessageKey
  readonly body: MessageKey
}[] = [
  {
    icon: LocalShippingRoundedIcon,
    title: 'store.services.delivery',
    body: 'store.services.deliveryBody',
  },
  { icon: LockRoundedIcon, title: 'store.services.secure', body: 'store.services.secureBody' },
  {
    icon: SupportAgentRoundedIcon,
    title: 'store.services.advice',
    body: 'store.services.adviceBody',
  },
  { icon: StorefrontRoundedIcon, title: 'store.services.pickup', body: 'store.services.pickupBody' },
]

export function StoreServicesStrip() {
  const { t } = useI18n()

  return (
    <Box
      component="section"
      aria-label={t('store.services.title')}
      sx={{
        display: 'grid',
        gap: { xs: 1.5, md: 0 },
        gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
        p: { xs: 2, md: 2.25 },
        borderRadius: 'var(--sf-radius)',
        border: '1px solid var(--sf-line)',
        bgcolor: 'var(--card)',
        boxShadow: 'var(--sf-shadow)',
      }}
    >
      {SERVICIOS.map(({ icon: Icono, title, body }, indice) => (
        <Stack
          key={title}
          direction="row"
          sx={{
            gap: 1.25,
            alignItems: 'center',
            px: { xs: 0, md: 2 },
            // Separadores entre columnas, no cajas: cuatro tarjetas aquí
            // competirían con las tarjetas de producto, que son las que venden.
            borderLeft: {
              xs: 'none',
              md: indice === 0 ? 'none' : '1px solid var(--sf-line)',
            },
          }}
        >
          <Box
            aria-hidden
            sx={{
              width: 38,
              height: 38,
              flexShrink: 0,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '50%',
              bgcolor: 'var(--accent-soft)',
              color: 'var(--accent-deep)',
            }}
          >
            <Icono sx={{ fontSize: 20 }} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: 13.5, fontWeight: 800, lineHeight: 1.3 }}>
              {t(title)}
            </Typography>
            <Typography sx={{ fontSize: TS.label, color: 'var(--muted)', lineHeight: 1.4 }}>
              {t(body)}
            </Typography>
          </Box>
        </Stack>
      ))}
    </Box>
  )
}
