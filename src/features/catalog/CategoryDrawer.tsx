import { zodResolver } from '@hookform/resolvers/zod'
import { Alert, Box, Button, FormControlLabel, Stack, Switch, TextField } from '@mui/material'
import { useEffect, useState, type ChangeEvent } from 'react'
import { useForm } from 'react-hook-form'
import { slugify } from '@/shared/lib/slug'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { FormDrawer } from '@/shared/ui/FormDrawer'
import { useFeedback } from '@/shared/ui/feedback-context'
import { CatalogError } from './api/errors'
import { categoryFormSchema, categoryToForm, type Category, type CategoryFormValues } from './types'
import { useSaveCategory } from './useCategories'

/**
 * CRUD mínimo de categoría: nombre, dirección y si se ve en la vitrina.
 *
 * Sin selector de padre a propósito. La tabla admite jerarquía, pero el árbol
 * (y su límite de profundidad) es trabajo de otra fase; ofrecer aquí un padre
 * dejaría crear una jerarquía que ninguna pantalla sabe todavía dibujar.
 */
export function CategoryDrawer({
  open,
  category,
  organizationId,
  companyId,
  storeId,
  canWrite,
  onClose,
}: {
  open: boolean
  category: Category | null
  organizationId: string
  companyId: string
  storeId: string
  canWrite: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const save = useSaveCategory()
  const [serverError, setServerError] = useState<MessageKey | null>(null)
  const [slugEdited, setSlugEdited] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: categoryToForm(category),
  })

  useEffect(() => {
    if (!open) return
    reset(categoryToForm(category))
    setSlugEdited(Boolean(category))
    setServerError(null)
  }, [open, category, reset])

  async function onSubmit(values: CategoryFormValues) {
    setServerError(null)
    try {
      await save.mutateAsync({
        categoryId: category?.id ?? null,
        organizationId,
        companyId,
        storeId,
        values,
      })
      notify(t('catalog.toast.categorySaved'))
      onClose()
    } catch (error) {
      setServerError(error instanceof CatalogError ? error.key : 'catalog.error.generic')
    }
  }

  const fieldError = (key: keyof CategoryFormValues) => {
    const message = errors[key]?.message
    return message ? t(message as MessageKey) : undefined
  }

  const busy = isSubmitting || save.isPending

  return (
    <FormDrawer
      open={open}
      title={category ? t('catalog.categories.edit') : t('catalog.categories.new')}
      onClose={onClose}
      busy={busy}
      width={440}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="category-form"
            variant="contained"
            disabled={busy || !canWrite}
          >
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <Box component="form" id="category-form" onSubmit={handleSubmit(onSubmit)} noValidate>
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

          <TextField
            label={t('catalog.field.slug')}
            fullWidth
            disabled={!canWrite}
            error={Boolean(errors.slug)}
            helperText={fieldError('slug') ?? t('catalog.field.slug.help')}
            inputProps={{ spellCheck: false }}
            {...register('slug', { onChange: () => setSlugEdited(true) })}
          />

          <FormControlLabel
            control={
              <Switch
                checked={watch('is_active')}
                disabled={!canWrite}
                onChange={(_, checked) => setValue('is_active', checked)}
              />
            }
            label={t('catalog.categories.isActive')}
          />
        </Stack>
      </Box>
    </FormDrawer>
  )
}
