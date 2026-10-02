import AddPhotoAlternateRoundedIcon from '@mui/icons-material/AddPhotoAlternateRounded'
import CancelRoundedIcon from '@mui/icons-material/CancelRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import { Alert, Box, Button, FormControlLabel, Radio, RadioGroup, Stack, Typography } from '@mui/material'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { EbimMark } from '@/shared/ui/EbimMark'
import { GhostButton } from '@/shared/ui/buttons'
import { useFeedback } from '@/shared/ui/feedback-context'
import type { LoaderAnimation } from '@/shared/ui/loaderMark'
import { LoadingState } from '@/shared/ui/states'
import { R, T } from '@/theme/tokens'
import { uploadLoaderImage, useSaveStoreLoader, useStoreLoader } from './loader'
import { inspectLoaderFile, LOADER_RULES, type LoaderIssue } from './loaderImage'

const REQUISITOS: ReadonlyArray<{ issues: LoaderIssue[]; key: MessageKey }> = [
  { issues: ['type'], key: 'settings.loader.rule.type' },
  { issues: ['background'], key: 'settings.loader.rule.background' },
  { issues: ['square'], key: 'settings.loader.rule.square' },
  { issues: ['small', 'large'], key: 'settings.loader.rule.size' },
  { issues: ['weight'], key: 'settings.loader.rule.weight' },
]

const ANIMACIONES: ReadonlyArray<{ value: LoaderAnimation; key: MessageKey }> = [
  { value: 'spin', key: 'settings.loader.animation.spin' },
  { value: 'pulse', key: 'settings.loader.animation.pulse' },
  { value: 'none', key: 'settings.loader.animation.none' },
]

const claseDe = (animacion: LoaderAnimation) =>
  animacion === 'spin' ? 'eb-logo-anim' : animacion === 'pulse' ? 'eb-loader-pulse' : undefined

/**
 * Indicador de carga propio de la tienda (2026-10-02).
 *
 * La imagen se EXIGE con requisitos (ver `loaderImage.ts`) y se comprueban
 * antes de subir: lo que no cumple no llega al bucket y la lista marca qué
 * falló. La vista previa lo enseña girando sobre fondo claro y oscuro a la
 * vez, que es donde se ve si el fondo era de verdad transparente.
 */
export function LoaderSection({
  storeId,
  organizationId,
  canManage,
}: {
  storeId: string | null
  organizationId: string | null
  canManage: boolean
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const actual = useStoreLoader(storeId)
  const guardar = useSaveStoreLoader(storeId)
  const inputRef = useRef<HTMLInputElement>(null)

  const [ruta, setRuta] = useState<string | null>(null)
  const [vista, setVista] = useState<string | null>(null)
  const [animacion, setAnimacion] = useState<LoaderAnimation>('spin')
  const [fallos, setFallos] = useState<LoaderIssue[] | null>(null)
  const [subiendo, setSubiendo] = useState(false)

  useEffect(() => {
    if (!actual.data) return
    setRuta(actual.data.loader_url)
    setVista(actual.data.preview)
    setAnimacion(actual.data.loader_animation)
  }, [actual.data])

  if (actual.isPending) return <LoadingState />
  if (actual.isError) return <Alert severity="error">{t('settings.error.generic')}</Alert>

  const cambiado = ruta !== actual.data.loader_url || animacion !== actual.data.loader_animation
  const ocupado = !canManage || subiendo || guardar.isPending

  async function elegir(file: File | undefined) {
    if (inputRef.current) inputRef.current.value = ''
    if (!file || !storeId || !organizationId) return
    const problemas = await inspectLoaderFile(file)
    setFallos(problemas)
    if (problemas.length > 0) return
    setSubiendo(true)
    try {
      const subida = await uploadLoaderImage({ organizationId, storeId, file })
      setRuta(subida.path)
      setVista(subida.preview)
    } catch {
      notify(t('settings.error.generic'), 'error')
    } finally {
      setSubiendo(false)
    }
  }

  async function onGuardar() {
    try {
      await guardar.mutateAsync({ loader_url: ruta, loader_animation: animacion })
      notify(t('settings.loader.saved'), 'success')
    } catch {
      notify(t('settings.error.generic'), 'error')
    }
  }

  const muestra = (fondo: string, etiqueta: MessageKey) => (
    <Stack spacing={0.75} sx={{ alignItems: 'center', flex: 1, minWidth: 0 }}>
      <Box
        sx={{
          width: '100%',
          aspectRatio: '4 / 3',
          borderRadius: `${R.md}px`,
          border: '1px solid var(--border)',
          bgcolor: fondo,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <Box className={claseDe(animacion)} aria-hidden sx={{ lineHeight: 0 }}>
          {vista ? (
            <Box component="img" src={vista} alt="" sx={{ width: 44, height: 44, objectFit: 'contain', display: 'block' }} />
          ) : (
            <EbimMark size={44} />
          )}
        </Box>
      </Box>
      <Typography sx={{ fontSize: T.label, color: 'var(--muted)', fontWeight: 700 }}>{t(etiqueta)}</Typography>
    </Stack>
  )

  return (
    <Stack spacing={2.5}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
        {/* Requisitos: lo que la imagen TIENE que cumplir, marcado tras elegir. */}
        <Stack spacing={1} sx={{ flex: 1.1, minWidth: 0 }}>
          <Typography component="h4" sx={{ fontWeight: 700, fontSize: T.bodyStrong }}>
            {t('settings.loader.rules')}
          </Typography>
          <Stack component="ul" spacing={0.75} sx={{ listStyle: 'none', p: 0, m: 0 }}>
            {REQUISITOS.map((req) => {
              const falla = fallos?.some((issue) => req.issues.includes(issue)) ?? false
              const cumple = fallos !== null && !falla
              return (
                <Stack component="li" key={req.key} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                  {falla ? (
                    <CancelRoundedIcon sx={{ fontSize: 18, color: 'var(--danger, #C62828)', mt: '1px' }} aria-hidden />
                  ) : (
                    <CheckCircleRoundedIcon
                      sx={{ fontSize: 18, mt: '1px', color: cumple ? 'var(--accent-deep)' : 'var(--border)' }}
                      aria-hidden
                    />
                  )}
                  <Typography
                    sx={{ fontSize: 13.5, lineHeight: 1.45, color: falla ? 'var(--danger, #C62828)' : 'var(--text)' }}
                  >
                    {t(req.key)
                      .replace('{min}', String(LOADER_RULES.minSide))
                      .replace('{max}', String(LOADER_RULES.maxSide))
                      .replace('{kb}', String(LOADER_RULES.maxBytes / 1024))}
                  </Typography>
                </Stack>
              )
            })}
          </Stack>
          {fallos && fallos.length > 0 && <Alert severity="error">{t('settings.loader.rejected')}</Alert>}
        </Stack>

        {/* La imagen: el hueco ES el botón, como en logo y favicon. */}
        <Stack spacing={1} sx={{ width: { xs: '100%', md: 180 }, flexShrink: 0 }}>
          <Typography component="h4" sx={{ fontWeight: 700, fontSize: T.bodyStrong }}>
            {t('settings.loader.image')}
          </Typography>
          <Box
            component="button"
            type="button"
            disabled={ocupado}
            aria-label={`${t('settings.loader.image')}: ${t('settings.asset.upload')}`}
            onClick={() => inputRef.current?.click()}
            sx={{
              width: '100%',
              aspectRatio: '1 / 1',
              p: 2,
              borderRadius: `${R.md}px`,
              border: '1px dashed var(--border)',
              // Damero: la transparencia se ve como transparencia.
              background:
                'repeating-conic-gradient(var(--neutral-soft) 0% 25%, var(--surface, #fff) 0% 50%) 50% / 16px 16px',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--muted)',
              cursor: ocupado ? 'default' : 'pointer',
              '&:hover:not(:disabled)': { borderColor: 'var(--accent)', color: 'var(--accent-deep)' },
              '&:disabled': { opacity: 0.6 },
            }}
          >
            {vista ? (
              <Box component="img" src={vista} alt="" sx={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            ) : (
              <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
                <AddPhotoAlternateRoundedIcon fontSize="small" aria-hidden />
                <Typography sx={{ fontSize: T.label, fontWeight: 700 }}>
                  {subiendo ? t('common.loading') : t('settings.asset.upload')}
                </Typography>
              </Stack>
            )}
          </Box>
          {ruta && (
            <Box>
              <GhostButton
                size="small"
                color="inherit"
                disabled={ocupado}
                startIcon={<DeleteRoundedIcon fontSize="small" />}
                onClick={() => {
                  setRuta(null)
                  setVista(null)
                  setFallos(null)
                }}
                sx={{ ml: -1 }}
              >
                {t('settings.loader.useSuite')}
              </GhostButton>
            </Box>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={LOADER_RULES.types.join(',')}
            hidden
            aria-label={t('settings.loader.image')}
            onChange={(event) => void elegir(event.target.files?.[0])}
          />
        </Stack>

        {/* Así se ve: en claro y en oscuro, ya animado. */}
        <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h4" sx={{ fontWeight: 700, fontSize: T.bodyStrong }}>
            {t('settings.loader.preview')}
          </Typography>
          <Stack direction="row" spacing={1.5}>
            {muestra('#FFFFFF', 'settings.loader.light')}
            {muestra('#121212', 'settings.loader.dark')}
          </Stack>
          <RadioGroup
            row
            value={animacion}
            onChange={(event) => setAnimacion(event.target.value as LoaderAnimation)}
            aria-label={t('settings.loader.animation')}
          >
            {ANIMACIONES.map((opcion) => (
              <FormControlLabel
                key={opcion.value}
                value={opcion.value}
                control={<Radio size="small" disabled={!canManage} />}
                label={<Typography sx={{ fontSize: 13.5 }}>{t(opcion.key)}</Typography>}
              />
            ))}
          </RadioGroup>
        </Stack>
      </Stack>

      <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
        <Button variant="contained" disabled={ocupado || !cambiado} onClick={() => void onGuardar()}>
          {t('settings.loader.save')}
        </Button>
      </Stack>
    </Stack>
  )
}
