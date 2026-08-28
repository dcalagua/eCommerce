import { zodResolver } from '@hookform/resolvers/zod'
import {
  Alert,
  Box,
  Button,
  Divider,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
} from '@mui/material'
import { useEffect, useState, type ChangeEvent } from 'react'
import { useForm } from 'react-hook-form'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { slugify } from '@/shared/lib/slug'
import { FormDrawer } from '@/shared/ui/FormDrawer'
import { useFeedback } from '@/shared/ui/feedback-context'
import { CatalogError } from './api/errors'
import { ProductImagesPanel } from './ProductImagesPanel'
import {
  PRODUCT_STATUSES,
  productFormSchema,
  productToForm,
  type Category,
  type Product,
  type ProductFormValues,
  type ProductStatus,
} from './types'
import { useSaveProduct } from './useProducts'

const STATUS_LABEL: Record<ProductStatus, MessageKey> = {
  draft: 'catalog.status.draft',
  published: 'catalog.status.published',
  archived: 'catalog.status.archived',
}

/**
 * Alta y edición de producto en panel lateral.
 *
 * El drawer no contradice ningún lineamiento: la regla de tabs centrados es
 * para pantallas largas y densas, y esto son ocho campos. Lo que sí respeta es
 * la barra de guardar persistente al pie, que sale de la misma regla.
 *
 * Las imágenes solo aparecen al editar: la ruta de Storage lleva el id del
 * producto, así que antes de existir no hay dónde guardarlas.
 */
export function ProductDrawer({
  open,
  product,
  categories,
  organizationId,
  companyId,
  storeId,
  currency,
  canWrite,
  onClose,
}: {
  open: boolean
  /** Null = alta. */
  product: Product | null
  categories: Category[]
  organizationId: string
  companyId: string
  storeId: string
  currency: string
  canWrite: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const save = useSaveProduct()
  const [serverError, setServerError] = useState<MessageKey | null>(null)
  const [slugEdited, setSlugEdited] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: productToForm(product),
  })

  // Al abrir con otro producto (o para un alta) el formulario se recarga
  // entero: reusar el estado anterior mostraría datos del producto anterior.
  useEffect(() => {
    if (!open) return
    reset(productToForm(product))
    setSlugEdited(Boolean(product))
    setServerError(null)
  }, [open, product, reset])

  async function onSubmit(values: ProductFormValues) {
    setServerError(null)
    try {
      await save.mutateAsync({ productId: product?.id ?? null, storeId, values })
      notify(t('catalog.toast.saved'))
      onClose()
    } catch (error) {
      // El drawer NO se cierra: lo escrito se queda donde está.
      setServerError(error instanceof CatalogError ? error.key : 'catalog.error.generic')
    }
  }

  const fieldError = (key: keyof ProductFormValues) => {
    const message = errors[key]?.message
    return message ? t(message as MessageKey) : undefined
  }

  const busy = isSubmitting || save.isPending

  return (
    <FormDrawer
      open={open}
      title={product ? t('catalog.products.edit') : t('catalog.products.new')}
      subtitle={product?.sku}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="product-form"
            variant="contained"
            disabled={busy || !canWrite}
          >
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <Box component="form" id="product-form" onSubmit={handleSubmit(onSubmit)} noValidate>
        <Stack spacing={2.5}>
          {!canWrite && <Alert severity="info">{t('catalog.products.unauthorized')}</Alert>}
          {serverError && <Alert severity="error">{t(serverError)}</Alert>}

          <TextField
            label={t('catalog.field.name')}
            fullWidth
            autoFocus
            disabled={!canWrite}
            error={Boolean(errors.name)}
            helperText={fieldError('name')}
            {...register('name', {
              onChange: (event: ChangeEvent<HTMLInputElement>) => {
                if (!slugEdited) setValue('slug', slugify(event.target.value))
              },
            })}
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label={t('catalog.field.sku')}
              fullWidth
              disabled={!canWrite}
              error={Boolean(errors.sku)}
              helperText={fieldError('sku')}
              inputProps={{ spellCheck: false }}
              {...register('sku')}
            />
            <TextField
              label={t('catalog.field.slug')}
              fullWidth
              disabled={!canWrite}
              error={Boolean(errors.slug)}
              helperText={fieldError('slug') ?? t('catalog.field.slug.help')}
              inputProps={{ spellCheck: false }}
              {...register('slug', { onChange: () => setSlugEdited(true) })}
            />
          </Stack>

          <TextField
            label={t('catalog.field.description')}
            fullWidth
            multiline
            minRows={3}
            disabled={!canWrite}
            error={Boolean(errors.description)}
            helperText={fieldError('description') ?? t('common.optional')}
            {...register('description')}
          />

          <TextField
            select
            label={t('catalog.field.category')}
            fullWidth
            disabled={!canWrite}
            value={watch('category_id')}
            error={Boolean(errors.category_id)}
            helperText={fieldError('category_id')}
            {...register('category_id')}
          >
            <MenuItem value="">{t('common.none')}</MenuItem>
            {categories.map((category) => (
              <MenuItem key={category.id} value={category.id}>
                {category.name}
              </MenuItem>
            ))}
          </TextField>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label={t('catalog.field.price')}
              fullWidth
              disabled={!canWrite}
              error={Boolean(errors.price)}
              helperText={fieldError('price')}
              InputProps={{
                startAdornment: <InputAdornment position="start">{currency}</InputAdornment>,
              }}
              inputProps={{ inputMode: 'decimal' }}
              {...register('price')}
            />
            <TextField
              label={t('catalog.field.stock')}
              fullWidth
              disabled={!canWrite}
              error={Boolean(errors.stock)}
              helperText={fieldError('stock')}
              inputProps={{ inputMode: 'numeric' }}
              {...register('stock')}
            />
          </Stack>

          <TextField
            select
            label={t('catalog.field.status')}
            fullWidth
            disabled={!canWrite}
            value={watch('status')}
            error={Boolean(errors.status)}
            helperText={fieldError('status')}
            {...register('status')}
          >
            {PRODUCT_STATUSES.map((status) => (
              <MenuItem key={status} value={status}>
                {t(STATUS_LABEL[status])}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </Box>

      <Divider sx={{ my: 3 }} />

      <ProductImagesPanel
        organizationId={organizationId}
        companyId={companyId}
        storeId={storeId}
        productId={product?.id ?? null}
        canWrite={canWrite}
      />
    </FormDrawer>
  )
}
