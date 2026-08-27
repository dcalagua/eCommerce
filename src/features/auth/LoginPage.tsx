import { zodResolver } from '@hookform/resolvers/zod'
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined'
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined'
import {
  Alert,
  Box,
  Button,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
} from '@mui/material'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link as RouterLink, Navigate, useLocation } from 'react-router-dom'
import { z } from 'zod'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { LoadingState } from '@/shared/ui/states'
import { R } from '@/theme/tokens'
import { AuthShell, CTA_SX, FieldLabel, ROUNDED_FIELD_SX } from './AuthShell'
import { AuthActionError, signInWithPassword } from './authApi'
import { useSessionContext } from './session-context'

const schema = z.object({
  email: z.string().min(1, 'auth.required.email').email('auth.invalid.email'),
  password: z.string().min(1, 'auth.required.password'),
})

type FormValues = z.infer<typeof schema>

interface LocationState {
  from?: string
}

/**
 * Login de suite. La pantalla no decide a dónde va el usuario después: fija la
 * sesión y deja que el guard de tenant resuelva backoffice u onboarding, que es
 * lo único que sabe si esa cuenta ya tiene espacio.
 */
export function LoginPage() {
  const { t } = useI18n()
  const { status } = useSessionContext()
  const location = useLocation()
  const [showPassword, setShowPassword] = useState(false)
  const [serverError, setServerError] = useState<MessageKey | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  })

  if (status === 'loading') return <LoadingState />
  if (status === 'recovery') return <Navigate to="/nueva-clave" replace />
  if (status === 'authenticated') {
    const from = (location.state as LocationState | null)?.from
    return <Navigate to={from && from.startsWith('/') ? from : '/app'} replace />
  }

  async function onSubmit(values: FormValues) {
    setServerError(null)
    try {
      await signInWithPassword(values.email, values.password)
    } catch (error) {
      setServerError(error instanceof AuthActionError ? error.key : 'auth.error.generic')
    }
  }

  const fieldError = (key: keyof FormValues) => {
    const message = errors[key]?.message
    return message ? t(message as MessageKey) : undefined
  }

  return (
    <AuthShell
      title={t('auth.title')}
      subtitle={t('auth.subtitle')}
      secondary={
        <Box component={RouterLink} to="/onboarding" sx={{ fontWeight: 600, color: 'var(--accent-deep)' }}>
          {t('auth.secondary')}
        </Box>
      }
    >
      <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate>
        {serverError && (
          <Alert severity="error" sx={{ mb: 2, borderRadius: `${R.md}px` }}>
            {t(serverError)}
          </Alert>
        )}

        <Stack spacing={2.25}>
          <Box>
            <FieldLabel htmlFor="login-email">{t('auth.email')}</FieldLabel>
            <TextField
              id="login-email"
              type="email"
              fullWidth
              autoComplete="email"
              error={Boolean(errors.email)}
              helperText={fieldError('email')}
              sx={ROUNDED_FIELD_SX}
              {...register('email')}
            />
          </Box>

          <Box>
            <FieldLabel htmlFor="login-password">{t('auth.password')}</FieldLabel>
            <TextField
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              fullWidth
              autoComplete="current-password"
              error={Boolean(errors.password)}
              helperText={fieldError('password')}
              sx={ROUNDED_FIELD_SX}
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
              <Box
                component={RouterLink}
                to="/recuperar"
                sx={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent-deep)' }}
              >
                {t('auth.forgot')}
              </Box>
            </Box>
          </Box>

          <Button type="submit" variant="contained" fullWidth disabled={isSubmitting} sx={CTA_SX}>
            {t('auth.submit')}
          </Button>
        </Stack>
      </Box>
    </AuthShell>
  )
}
