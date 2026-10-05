import CancelRoundedIcon from '@mui/icons-material/CancelRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import VideoCallRoundedIcon from '@mui/icons-material/VideoCallRounded'
import { Alert, Box, Button, Stack, Typography } from '@mui/material'
import { useRef, useState } from 'react'
import { inspectPromoVideo, uploadStoreVideo, useStoreVideoPreview } from '@/features/admin/settings/homeVideosAdmin'
import { PROMO_VIDEO_RULES, type HomeVideoIssue } from '@/features/storefront/homeVideos'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { GhostButton } from '@/shared/ui/buttons'
import { useFeedback } from '@/shared/ui/feedback-context'
import { R, T } from '@/theme/tokens'

const REQUISITOS: ReadonlyArray<{ issues: HomeVideoIssue[]; key: MessageKey }> = [
  { issues: ['type', 'unreadable'], key: 'promotions.video.rule.type' },
  { issues: ['orientation'], key: 'promotions.video.rule.landscape' },
  { issues: ['short', 'long'], key: 'promotions.video.rule.duration' },
  { issues: ['weight'], key: 'promotions.video.rule.weight' },
]

const conValores = (texto: string) =>
  texto
    .replace('{min}', String(PROMO_VIDEO_RULES.minSeconds))
    .replace('{max}', String(PROMO_VIDEO_RULES.maxSeconds))
    .replace('{mb}', String(PROMO_VIDEO_RULES.maxBytes / 1024 / 1024))

/**
 * Video de fondo de la campaña (2026-10-04 · migración 20261004110000).
 *
 * Se reproduce mudo y en bucle detrás del texto de la campaña en la portada.
 * Pide IMAGEN antes: la imagen es lo que se ve si el video no carga o si el
 * comprador pidió menos movimiento (la base también lo exige). Lo que no
 * cumple los requisitos no llega al bucket, y la lista dice qué falló.
 */
export function PromotionVideoField({
  value,
  hasImage,
  disabled,
  organizationId,
  storeId,
  onChange,
}: {
  value: string | null
  hasImage: boolean
  disabled: boolean
  organizationId: string
  storeId: string
  onChange: (next: string | null) => void
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const inputRef = useRef<HTMLInputElement>(null)
  const [fallos, setFallos] = useState<HomeVideoIssue[] | null>(null)
  const [subiendo, setSubiendo] = useState(false)
  const [previa, setPrevia] = useState<{ path: string; url: string | null } | null>(null)
  const firmada = useStoreVideoPreview(value && previa?.path !== value ? value : null)
  const url = value ? (previa?.path === value ? previa.url : (firmada.data ?? null)) : null
  const ocupado = disabled || subiendo || !hasImage

  async function elegir(file: File | undefined) {
    if (inputRef.current) inputRef.current.value = ''
    if (!file || !organizationId || !storeId) return
    const problemas = await inspectPromoVideo(file)
    setFallos(problemas)
    if (problemas.length > 0) return
    setSubiendo(true)
    try {
      const subido = await uploadStoreVideo({ organizationId, storeId, file })
      setPrevia({ path: subido.path, url: subido.preview })
      onChange(subido.path)
    } catch {
      notify(t('promotions.video.uploadError'), 'error')
    } finally {
      setSubiendo(false)
    }
  }

  return (
    <Stack spacing={1.25} data-promotion-video>
      <Typography component="h4" sx={{ fontWeight: 700, fontSize: T.bodyStrong }}>
        {t('promotions.video.label')}
      </Typography>

      {value ? (
        <Box
          sx={{
            width: '100%',
            aspectRatio: '16 / 9',
            borderRadius: `${R.md}px`,
            overflow: 'hidden',
            bgcolor: '#0b0b0b',
          }}
        >
          {url ? (
            <Box
              component="video"
              src={url}
              muted
              loop
              autoPlay
              playsInline
              controls
              sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : null}
        </Box>
      ) : null}

      <Stack component="ul" spacing={0.5} sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {REQUISITOS.map((req) => {
          const falla = fallos?.some((issue) => req.issues.includes(issue)) ?? false
          const cumple = fallos !== null && !falla
          return (
            <Stack component="li" key={req.key} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              {falla ? (
                <CancelRoundedIcon sx={{ fontSize: 17, color: 'var(--danger, #C62828)', mt: '1px' }} aria-hidden />
              ) : (
                <CheckCircleRoundedIcon
                  sx={{ fontSize: 17, mt: '1px', color: cumple ? 'var(--accent-deep)' : 'var(--border)' }}
                  aria-hidden
                />
              )}
              <Typography sx={{ fontSize: 13, lineHeight: 1.45, color: falla ? 'var(--danger, #C62828)' : 'var(--text)' }}>
                {conValores(t(req.key))}
              </Typography>
            </Stack>
          )
        })}
      </Stack>
      {fallos && fallos.length > 0 ? <Alert severity="error">{t('promotions.video.rejected')}</Alert> : null}
      {!hasImage ? (
        <Typography sx={{ fontSize: 12.5, color: 'var(--muted)' }}>{t('promotions.video.needsImage')}</Typography>
      ) : null}

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Button
          variant="outlined"
          size="small"
          startIcon={<VideoCallRoundedIcon />}
          disabled={ocupado}
          onClick={() => inputRef.current?.click()}
        >
          {subiendo ? t('promotions.video.uploading') : value ? t('promotions.video.replace') : t('promotions.video.add')}
        </Button>
        {value ? (
          <GhostButton
            size="small"
            color="inherit"
            disabled={disabled || subiendo}
            startIcon={<DeleteRoundedIcon fontSize="small" />}
            onClick={() => {
              setFallos(null)
              onChange(null)
            }}
          >
            {t('promotions.video.remove')}
          </GhostButton>
        ) : null}
      </Stack>
      <input
        ref={inputRef}
        type="file"
        accept={PROMO_VIDEO_RULES.types.join(',')}
        hidden
        aria-label={t('promotions.video.label')}
        onChange={(event) => void elegir(event.target.files?.[0])}
      />
    </Stack>
  )
}
