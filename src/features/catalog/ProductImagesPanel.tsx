import { StatusChip } from '@/shared/ui/StatusChip'
import AddPhotoAlternateRoundedIcon from '@mui/icons-material/AddPhotoAlternateRounded'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import StarRoundedIcon from '@mui/icons-material/StarRounded'
import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded'
import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { useFeedback } from '@/shared/ui/feedback-context'
import { GridSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { R } from '@/theme/tokens'
import { ALLOWED_IMAGE_TYPES, moveImage, validateImageFile } from './api/images'
import { CatalogError } from './api/errors'
import type { ProductImage } from './types'
import {
  useDeleteProductImage,
  useProductImages,
  useReorderProductImages,
  useSetPrimaryImage,
  useSignedImageUrls,
  useUploadProductImage,
} from './useProductImages'

const ACCEPT = Object.keys(ALLOWED_IMAGE_TYPES).join(',')

function errorKeyOf(error: unknown): MessageKey {
  return error instanceof CatalogError ? error.key : 'catalog.error.generic'
}

/**
 * Imágenes del producto sobre el bucket privado `product-images`.
 *
 * Todo pasa por la sesión del usuario y la clave publicable: `service_role`
 * no existe en el navegador. Quien autoriza la subida es la policy de Storage,
 * que deriva el tenant de la propia ruta `{org}/{store}/{product}/…`.
 *
 * Este componente no importa Supabase: pide y muta a través de los hooks.
 */
export function ProductImagesPanel({
  organizationId,
  companyId,
  storeId,
  productId,
  canWrite,
}: {
  organizationId: string
  companyId: string
  storeId: string
  /** Null mientras el producto no existe: sin id no hay ruta donde guardar. */
  productId: string | null
  canWrite: boolean
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const images = useProductImages(productId)
  const paths = useMemo(
    () => (images.data ?? []).map((image) => image.storage_path),
    [images.data],
  )
  const urls = useSignedImageUrls(paths)

  const upload = useUploadProductImage(productId)
  const remove = useDeleteProductImage(productId)
  const setPrimary = useSetPrimaryImage(productId)
  const reorder = useReorderProductImages(productId)

  if (!productId) {
    return (
      <EmptyState
        title={t('catalog.images.title')}
        description={t('catalog.images.saveFirst')}
        icon={<AddPhotoAlternateRoundedIcon fontSize="small" />}
      />
    )
  }

  async function onFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0 || !productId) return

    setUploading(true)
    let position = (images.data?.length ?? 0) - 1
    try {
      for (const file of files) {
        const validation = validateImageFile(file)
        if (!validation.ok) {
          // Un archivo malo no cancela los demás: se avisa y se sigue.
          notify(`${file.name}: ${t(validation.key)}`, 'error')
          continue
        }
        position += 1
        try {
          await upload.mutateAsync({
            organizationId,
            companyId,
            storeId,
            productId,
            file,
            position,
          })
          notify(t('catalog.toast.imageUploaded'))
        } catch (error) {
          notify(`${file.name}: ${t(errorKeyOf(error))}`, 'error')
        }
      }
    } finally {
      setUploading(false)
    }
  }

  async function onSetPrimary(image: ProductImage) {
    try {
      await setPrimary.mutateAsync(image.id)
      notify(t('catalog.toast.primarySet'))
    } catch (error) {
      notify(t(errorKeyOf(error)), 'error')
    }
  }

  async function onMove(image: ProductImage, delta: number) {
    if (!productId) return
    const imageIds = moveImage(images.data ?? [], image.id, delta)
    try {
      await reorder.mutateAsync({ productId, imageIds })
      notify(t('catalog.toast.reordered'))
    } catch (error) {
      notify(t(errorKeyOf(error)), 'error')
    }
  }

  async function onRemove(image: ProductImage) {
    try {
      await remove.mutateAsync(image)
      notify(t('catalog.toast.imageDeleted'))
    } catch (error) {
      notify(t(errorKeyOf(error)), 'error')
    }
  }

  const list = images.data ?? []
  const busy = uploading || reorder.isPending || setPrimary.isPending || remove.isPending

  return (
    <Stack spacing={2}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: 'center', justifyContent: 'space-between' }}
      >
        <Box>
          <Typography sx={{ fontWeight: 800 }}>{t('catalog.images.title')}</Typography>
          <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>
            {t('catalog.images.help')}
          </Typography>
        </Box>
        {canWrite && (
          <Button
            variant="outlined"
            size="small"
            startIcon={<AddPhotoAlternateRoundedIcon fontSize="small" />}
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {uploading ? t('catalog.images.uploading') : t('catalog.images.add')}
          </Button>
        )}
      </Stack>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        aria-label={t('catalog.images.add')}
        onChange={(event) => void onFilesPicked(event)}
      />

      {images.isPending && <GridSkeleton />}
      {images.isError && <ErrorState error={images.error} onRetry={() => void images.refetch()} />}

      {!images.isPending && !images.isError && list.length === 0 && (
        <EmptyState
          title={t('catalog.images.empty')}
          description={t('catalog.images.help')}
          icon={<AddPhotoAlternateRoundedIcon fontSize="small" />}
        />
      )}

      {list.length > 0 && (
        <Stack component="ul" spacing={1} sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {list.map((image, index) => (
            <Stack
              key={image.id}
              component="li"
              direction="row"
              spacing={1.5}
              sx={{
                alignItems: 'center',
                border: '1px solid var(--border)',
                borderRadius: `${R.md}px`,
                p: 1,
              }}
            >
              <Box
                component="img"
                src={urls.data?.[image.storage_path] ?? ''}
                alt={image.alt ?? t('catalog.images.alt')}
                loading="lazy"
                sx={{
                  width: 64,
                  height: 64,
                  objectFit: 'cover',
                  borderRadius: `${R.sm}px`,
                  bgcolor: 'var(--neutral-soft)',
                  flexShrink: 0,
                }}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {image.is_primary && (
                  <StatusChip tone="success" label={t('catalog.images.primary')} />
                )}
                <Typography
                  sx={{ fontSize: 11, color: 'var(--muted)', mt: 0.5, wordBreak: 'break-all' }}
                >
                  {image.storage_path.split('/').pop()}
                </Typography>
              </Box>

              {canWrite && (
                <Stack direction="row" spacing={0.5}>
                  <Tooltip title={t('catalog.images.setPrimary')}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={t('catalog.images.setPrimary')}
                        disabled={busy || image.is_primary}
                        onClick={() => void onSetPrimary(image)}
                      >
                        {image.is_primary ? (
                          <StarRoundedIcon fontSize="small" />
                        ) : (
                          <StarBorderRoundedIcon fontSize="small" />
                        )}
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title={t('catalog.images.moveUp')}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={t('catalog.images.moveUp')}
                        disabled={busy || index === 0}
                        onClick={() => void onMove(image, -1)}
                      >
                        <ArrowUpwardRoundedIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title={t('catalog.images.moveDown')}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={t('catalog.images.moveDown')}
                        disabled={busy || index === list.length - 1}
                        onClick={() => void onMove(image, 1)}
                      >
                        <ArrowDownwardRoundedIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title={t('catalog.images.remove')}>
                    <span>
                      <IconButton
                        size="small"
                        color="error"
                        aria-label={t('catalog.images.remove')}
                        disabled={busy}
                        onClick={() => void onRemove(image)}
                      >
                        <DeleteRoundedIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
              )}
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  )
}
