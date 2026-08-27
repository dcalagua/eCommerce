import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined'
import {
  Box,
  Divider,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import type { ReactNode } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { APP_NAME } from '@/shared/lib/env'
import { EbimMark } from '@/shared/ui/EbimMark'
import { useAppearance } from '@/theme/appearance-context'

interface Bullet {
  icon: ReactNode
  title: MessageKey
  body: MessageKey
}

/** Exactamente 3 bullets: ni dos ni cinco (contrato §4.5, punto 5). */
const BULLETS: Bullet[] = [
  { icon: <Inventory2OutlinedIcon fontSize="small" />, title: 'auth.bullet1.title', body: 'auth.bullet1.body' },
  { icon: <ReceiptLongOutlinedIcon fontSize="small" />, title: 'auth.bullet2.title', body: 'auth.bullet2.body' },
  { icon: <PaletteOutlinedIcon fontSize="small" />, title: 'auth.bullet3.title', body: 'auth.bullet3.body' },
]

/**
 * Anatomía única de las pantallas de auth (contrato §4.5, referencia normativa
 * eSupplier). Un solo componente para login, recuperación y clave nueva: es lo
 * que hace que los selectores de idioma/tema floten igual en las tres y que el
 * panel de marca no se degrade en las pantallas "secundarias".
 *
 * Varía por pantalla: encabezado, subtítulo, formulario y link secundario.
 * No varía: estructura, isotipo arriba-izquierda, pie de confianza y lockup.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  secondary,
}: {
  title: string
  subtitle: string
  children: ReactNode
  secondary?: ReactNode
}) {
  const { t, locale, setLocale } = useI18n()
  const { appearance, toggleMode } = useAppearance()

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        bgcolor: 'var(--bg)',
        display: 'grid',
        placeItems: 'center',
        p: { xs: 2, md: 4 },
        position: 'relative',
      }}
    >
      {/* Punto 7: idioma y tema flotan sobre la página, fuera de la tarjeta. */}
      <Stack direction="row" spacing={1} sx={{ position: 'absolute', top: 16, right: 16 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={locale}
          onChange={(_, next: 'es' | 'en' | null) => next && setLocale(next)}
          aria-label={t('common.language')}
        >
          <ToggleButton value="es">ES</ToggleButton>
          <ToggleButton value="en">EN</ToggleButton>
        </ToggleButtonGroup>
        <IconButton
          onClick={toggleMode}
          aria-label={appearance.mode === 'dark' ? t('common.theme.light') : t('common.theme.dark')}
        >
          {appearance.mode === 'dark' ? (
            <LightModeOutlinedIcon fontSize="small" />
          ) : (
            <DarkModeOutlinedIcon fontSize="small" />
          )}
        </IconButton>
      </Stack>

      <Box
        sx={{
          width: '100%',
          maxWidth: 1000,
          minHeight: { md: 580 },
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          borderRadius: '22px',
          overflow: 'hidden',
          bgcolor: 'var(--card)',
          boxShadow: '0 30px 80px -40px rgba(24,93,74,.5)',
        }}
      >
        {/* Panel izquierdo — MARCA. En móvil se oculta, no se apila (§4.5). */}
        <Box
          sx={{
            display: { xs: 'none', md: 'flex' },
            flexDirection: 'column',
            gap: 3,
            p: 5,
            background: 'var(--hero-grad)',
            color: '#fff',
          }}
        >
          <EbimMark variant="white" size={32} />

          <Box>
            <Typography component="div" sx={{ fontSize: 40, fontWeight: 800, letterSpacing: '-1px', lineHeight: 1.05 }}>
              <Box component="span" sx={{ color: '#AEEA94' }}>
                e
              </Box>
              Commerce
            </Typography>
            <Typography
              sx={{
                mt: 1.5,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,.75)',
              }}
            >
              {t('auth.eyebrow')}
            </Typography>
          </Box>

          <Typography sx={{ fontSize: 14, lineHeight: 1.6, color: 'rgba(255,255,255,.9)', maxWidth: 380 }}>
            {t('auth.valueProp')}
          </Typography>

          <Stack spacing={2.5} sx={{ mt: 'auto' }}>
            {BULLETS.map((bullet) => (
              <Stack key={bullet.title} direction="row" spacing={1.75} sx={{ alignItems: 'flex-start' }}>
                <Box
                  sx={{
                    width: 34,
                    height: 34,
                    borderRadius: '10px',
                    display: 'grid',
                    placeItems: 'center',
                    bgcolor: 'rgba(255,255,255,.14)',
                    color: '#fff',
                    flexShrink: 0,
                  }}
                >
                  {bullet.icon}
                </Box>
                <Box>
                  <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>{t(bullet.title)}</Typography>
                  <Typography sx={{ fontSize: 12.5, color: 'rgba(255,255,255,.78)' }}>{t(bullet.body)}</Typography>
                </Box>
              </Stack>
            ))}
          </Stack>

          {/* Pie de confianza (fijo en toda la suite). */}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'rgba(255,255,255,.72)' }}>
            <ShieldOutlinedIcon sx={{ fontSize: 16 }} />
            <Typography sx={{ fontSize: 11.5 }}>{t('auth.trust')}</Typography>
          </Stack>
        </Box>

        {/* Panel derecho — FORMULARIO. */}
        <Box sx={{ p: { xs: 3, md: 5 }, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <Typography component="h1" sx={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.5px' }}>
            {title}
          </Typography>
          <Typography sx={{ mt: 1, mb: 3.5, color: 'var(--muted)', fontSize: 13, lineHeight: 1.55 }}>
            {subtitle}
          </Typography>

          {children}

          {secondary && (
            <Typography sx={{ textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', mt: 2 }}>
              {secondary}
            </Typography>
          )}

          <Divider sx={{ mt: 4, mb: 2 }} />
          <Stack direction="row" spacing={1} sx={{ justifyContent: 'center', alignItems: 'center' }}>
            <EbimMark size={16} />
            <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>
              {APP_NAME} by EBIM
            </Typography>
          </Stack>
        </Box>
      </Box>
    </Box>
  )
}

/** Campo con label ENCIMA del input (punto 9 de la anatomía), reutilizable. */
export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <Typography
      component="label"
      htmlFor={htmlFor}
      sx={{ display: 'block', mb: 0.75, fontSize: 12.5, fontWeight: 700 }}
    >
      {children}
    </Typography>
  )
}

export const ROUNDED_FIELD_SX = { '& .MuiOutlinedInput-root': { borderRadius: '11px' } } as const

export const CTA_SX = {
  borderRadius: '11px',
  py: '14px',
  fontWeight: 700,
  boxShadow: 'var(--shadow-lg)',
} as const
