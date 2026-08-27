import { zodResolver } from '@hookform/resolvers/zod'
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined'
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined'
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined'
import {
  Alert,
  Box,
  Button,
  Divider,
  IconButton,
  InputAdornment,
  Link as MuiLink,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { APP_NAME } from '@/shared/lib/env'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { EbimMark } from '@/shared/ui/EbimMark'
import { useAppearance } from '@/theme/appearance-context'
import { R } from '@/theme/tokens'

const schema = z.object({
  email: z.string().min(1, 'auth.required.email').email('auth.invalid.email'),
  password: z.string().min(1, 'auth.required.password'),
})

type FormValues = z.infer<typeof schema>

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
 * Login — anatomía única de suite (contrato §4.5, referencia normativa eSupplier).
 * Lo que varía por app: nombre, eyebrow, párrafo, los 3 bullets, acento, link secundario.
 * Lo que NO varía: estructura, orden, isotipo arriba-izquierda, pie de confianza y lockup.
 */
export function LoginPage() {
  const { t, locale, setLocale } = useI18n()
  const { appearance, toggleMode } = useAppearance()
  const [showPassword, setShowPassword] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  })

  async function onSubmit(values: FormValues) {
    setServerError(null)
    const supabase = tryGetSupabaseClient()
    if (!supabase) {
      setServerError(t('auth.notConfigured'))
      return
    }
    const { error } = await supabase.auth.signInWithPassword({
      email: values.email,
      password: values.password,
    })
    if (error) setServerError(error.message)
  }

  const fieldError = (key: keyof FormValues) => {
    const message = errors[key]?.message
    return message ? t(message as MessageKey) : undefined
  }

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
        <Box
          component="form"
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          sx={{ p: { xs: 3, md: 5 }, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}
        >
          <Typography component="h1" sx={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.5px' }}>
            {t('auth.title')}
          </Typography>
          <Typography sx={{ mt: 1, mb: 3.5, color: 'var(--muted)', fontSize: 13, lineHeight: 1.55 }}>
            {t('auth.subtitle')}
          </Typography>

          {serverError && (
            <Alert severity="error" sx={{ mb: 2, borderRadius: `${R.md}px` }}>
              {serverError}
            </Alert>
          )}

          <Stack spacing={2.25}>
            <Box>
              <Typography
                component="label"
                htmlFor="login-email"
                sx={{ display: 'block', mb: 0.75, fontSize: 12.5, fontWeight: 700 }}
              >
                {t('auth.email')}
              </Typography>
              <TextField
                id="login-email"
                type="email"
                fullWidth
                autoComplete="email"
                error={Boolean(errors.email)}
                helperText={fieldError('email')}
                sx={{ '& .MuiOutlinedInput-root': { borderRadius: '11px' } }}
                {...register('email')}
              />
            </Box>

            <Box>
              <Typography
                component="label"
                htmlFor="login-password"
                sx={{ display: 'block', mb: 0.75, fontSize: 12.5, fontWeight: 700 }}
              >
                {t('auth.password')}
              </Typography>
              <TextField
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                fullWidth
                autoComplete="current-password"
                error={Boolean(errors.password)}
                helperText={fieldError('password')}
                sx={{ '& .MuiOutlinedInput-root': { borderRadius: '11px' } }}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        onClick={() => setShowPassword((v) => !v)}
                        edge="end"
                        aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                      >
                        {showPassword ? (
                          <VisibilityOffOutlinedIcon fontSize="small" />
                        ) : (
                          <VisibilityOutlinedIcon fontSize="small" />
                        )}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
                {...register('password')}
              />
              <Box sx={{ textAlign: 'right', mt: 0.75 }}>
                <MuiLink href="#recuperar" sx={{ fontSize: 12.5, fontWeight: 600 }}>
                  {t('auth.forgot')}
                </MuiLink>
              </Box>
            </Box>

            <Button
              type="submit"
              variant="contained"
              fullWidth
              disabled={isSubmitting}
              sx={{ borderRadius: '11px', py: '14px', fontWeight: 700, boxShadow: 'var(--shadow-lg)' }}
            >
              {t('auth.submit')}
            </Button>

            {/* Un solo link secundario, en texto corriente. */}
            <Typography sx={{ textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
              <MuiLink href="#alta" sx={{ fontWeight: 600 }}>
                {t('auth.secondary')}
              </MuiLink>
            </Typography>
          </Stack>

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
