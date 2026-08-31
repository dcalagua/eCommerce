import AddPhotoAlternateRoundedIcon from '@mui/icons-material/AddPhotoAlternateRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import { Box, Stack, Typography } from '@mui/material'
import { useRef, useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { GhostButton } from '@/shared/ui/buttons'
import { useFeedback } from '@/shared/ui/feedback-context'
import { R, T } from '@/theme/tokens'
import { SettingsError } from './api'
import { useUploadStoreAsset } from './useStoreSettings'
import type { AssetKind } from './types'

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif'

function errorKeyOf(error: unknown): MessageKey {
  return error instanceof SettingsError ? error.key : 'settings.error.generic'
}

/**
 * Logo, banner o favicon de la tienda.
 *
 * El archivo sube al bucket `store-assets` en cuanto se elige y lo que queda en
 * el formulario es la RUTA; Guardar es lo que la persiste en `store_settings`.
 * Si alguien sube y luego cancela, queda un objeto huérfano en el bucket — que
 * no rompe ninguna pantalla. Al revés (guardar primero, subir después) el
 * riesgo sería una fila apuntando a un objeto que no existe, y eso sí se ve
 * (mismo criterio que P04 #36).
 *
 * ## El hueco ES el botón
 *
 * Antes la vista previa era un rectángulo decorativo y el que abría el
 * selector era un botón al lado. Eso deja el elemento más grande y más obvio de
 * la fila sin hacer nada, que es justo donde todo el mundo hace clic primero.
 * Aquí el hueco es un `<button>` de verdad —con foco, con `Enter` y con nombre
 * accesible—, y las acciones que no son «elegir imagen» quedan debajo en
 * terciario.
 *
 * La proporción del hueco es la del destino real (cuadrado el logo y el
 * favicon, apaisado el banner): así se ve el recorte antes de subir nada, en
 * vez de descubrir en la vitrina que la imagen no cabía.
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
  const busy = disabled || upload.isPending

  return (
    <Stack spacing={1} sx={{ height: '100%' }}>
      <Typography component="h4" sx={{ fontWeight: 700, fontSize: T.bodyStrong }}>
        {label}
      </Typography>

      <Box
        component="button"
        type="button"
        disabled={busy}
        aria-label={`${label}: ${t('settings.asset.upload')}`}
        onClick={() => inputRef.current?.click()}
        sx={{
          width: '100%',
          aspectRatio: ratio,
          p: 0,
          borderRadius: `${R.md}px`,
          border: '1px dashed var(--border)',
          bgcolor: 'var(--neutral-soft)',
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
          color: 'var(--muted)',
          cursor: busy ? 'default' : 'pointer',
          transition: 'border-color 120ms, background-color 120ms',
          '&:hover:not(:disabled)': {
            borderColor: 'var(--accent)',
            bgcolor: 'var(--accent-soft)',
            color: 'var(--accent-deep)',
          },
          '&:disabled': { opacity: 0.6 },
        }}
      >
        {showImage ? (
          <Box
            component="img"
            src={previewUrl ?? undefined}
            alt=""
            onError={() => setBroken(true)}
            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <Stack spacing={0.5} sx={{ alignItems: 'center', px: 1 }}>
            <AddPhotoAlternateRoundedIcon fontSize="small" aria-hidden />
            <Typography sx={{ fontSize: T.label, fontWeight: 700, textAlign: 'center' }}>
              {upload.isPending ? t('common.loading') : t('settings.asset.upload')}
            </Typography>
          </Stack>
        )}
      </Box>

      {/* El texto de ayuda debajo del hueco y no al lado: en una fila de tres
          campos, la ayuda a la derecha partiría en cuatro líneas de dos
          palabras. */}
      <Typography sx={{ color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4, flex: 1 }}>
        {help}
      </Typography>

      {value && (
        <Box>
          <GhostButton
            size="small"
            color="inherit"
            disabled={busy}
            startIcon={<DeleteRoundedIcon fontSize="small" />}
            onClick={() => {
              setBroken(false)
              onChange(null)
            }}
            sx={{ ml: -1 }}
          >
            {t('settings.asset.remove')}
          </GhostButton>
        </Box>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        aria-label={label}
        onChange={(event) => void pick(event.target.files?.[0])}
      />
    </Stack>
  )
}
