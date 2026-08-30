import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import ImageRoundedIcon from '@mui/icons-material/ImageRounded'
import { Box, Button, Stack, Typography } from '@mui/material'
import { useRef, useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { useFeedback } from '@/shared/ui/feedback-context'
import { R } from '@/theme/tokens'
import { SettingsError } from './api'
import { useUploadStoreAsset } from './useStoreSettings'
import type { AssetKind } from './types'

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif'

function errorKeyOf(error: unknown): MessageKey {
  return error instanceof SettingsError ? error.key : 'settings.error.generic'
}

/**
 * Logo o banner de la tienda.
 *
 * El archivo sube al bucket `store-assets` en cuanto se elige y lo que queda en
 * el formulario es la RUTA; Guardar es lo que la persiste en `store_settings`.
 * Si alguien sube y luego cancela, queda un objeto huérfano en el bucket — que
 * no rompe ninguna pantalla. Al revés (guardar primero, subir después) el
 * riesgo sería una fila apuntando a un objeto que no existe, y eso sí se ve
 * (mismo criterio que P04 #36).
 */
export function StoreAssetField({
  kind,
  label,
  help,
  value,
  previewUrl,
  disabled,
  organizationId,
  storeId,
  onChange,
  ratio,
}: {
  kind: AssetKind
  label: string
  help: string
  value: string | null
  previewUrl: string | null
  disabled: boolean
  organizationId: string
  storeId: string
  onChange: (next: string | null) => void
  /** Proporción del hueco de vista previa: cuadrado para logo, ancho para banner. */
  ratio: string
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const upload = useUploadStoreAsset()
  const inputRef = useRef<HTMLInputElement>(null)
  const [broken, setBroken] = useState(false)

  async function pick(file: File | undefined) {
    if (!file) return
    try {
      const path = await upload.mutateAsync({ organizationId, storeId, kind, file })
      setBroken(false)
      onChange(path)
    } catch (error) {
      notify(t(errorKeyOf(error)), 'error')
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const showImage = Boolean(previewUrl) && !broken

  return (
    <Stack spacing={1}>
      <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{label}</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Box
          sx={{
            width: { xs: '100%', sm: kind === 'logo' ? 96 : 240 },
            aspectRatio: ratio,
            borderRadius: `${R.md}px`,
            border: '1px dashed var(--border)',
            bgcolor: 'var(--neutral-soft)',
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            color: 'var(--muted)',
            flexShrink: 0,
          }}
        >
          {showImage ? (
            <Box
              component="img"
              src={previewUrl ?? undefined}
              alt=""
              onError={() => setBroken(true)}
              sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <ImageRoundedIcon fontSize="small" aria-hidden />
          )}
        </Box>

        <Stack spacing={1} sx={{ flex: 1 }}>
          <Typography sx={{ color: 'var(--muted)', fontSize: 12 }}>{help}</Typography>
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              size="small"
              disabled={disabled || upload.isPending}
              onClick={() => inputRef.current?.click()}
            >
              {upload.isPending ? t('common.loading') : t('settings.asset.upload')}
            </Button>
            {value && (
              <Button
                variant="text"
                size="small"
                color="inherit"
                disabled={disabled || upload.isPending}
                startIcon={<DeleteRoundedIcon fontSize="small" />}
                onClick={() => {
                  setBroken(false)
                  onChange(null)
                }}
              >
                {t('settings.asset.remove')}
              </Button>
            )}
          </Stack>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            hidden
            aria-label={label}
            onChange={(event) => void pick(event.target.files?.[0])}
          />
        </Stack>
      </Stack>
    </Stack>
  )
}
