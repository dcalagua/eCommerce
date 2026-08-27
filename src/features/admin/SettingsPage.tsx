import LaunchOutlinedIcon from '@mui/icons-material/LaunchOutlined'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Link as MuiLink,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, type ReactNode } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SectionTabs } from '@/shared/ui/SectionTabs'
import { TaxesSection } from './settings/TaxesSection'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState, LoadingState, UnauthorizedState } from '@/shared/ui/states'
import { useAppearance } from '@/theme/appearance-context'
import { COLOR_MODES, DENSITIES, type ColorMode, type Density } from '@/theme/tokens'
import { SettingsError } from './settings/api'
import { StoreAssetField } from './settings/StoreAssetField'
import { storeFormSchema, toForm, type StoreFormValues } from './settings/types'
import {
  useAssetUrls,
  useSaveStoreSettings,
  useStoreSettings,
} from './settings/useStoreSettings'

function errorKeyOf(error: unknown): MessageKey {
  return error instanceof SettingsError ? error.key : 'settings.error.generic'
}

/** El mensaje de zod ES la clave de i18n: nunca se enseña texto en un solo idioma. */
function fieldError(message: string | undefined, t: (key: MessageKey) => string): string | undefined {
  return message ? t(message as MessageKey) : undefined
}

/**
 * Apariencia por usuario: SOLO modo y densidad.
 * No hay selector de paleta — el color es 100% del tenant (contrato §4.4).
 */
function AppearanceSection() {
  const { t } = useI18n()
  const { appearance, setMode, setDensity } = useAppearance()

  return (
    <Card>
      <CardContent>
        <Stack spacing={3}>
          <Alert severity="info" icon={false}>
            {t('admin.settings.appearance.note')}
          </Alert>

          <Box>
            <Typography sx={{ fontWeight: 700, mb: 1 }}>{t('admin.settings.appearance.mode')}</Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={appearance.mode}
              onChange={(_, next: ColorMode | null) => next && setMode(next)}
              aria-label={t('admin.settings.appearance.mode')}
            >
              {COLOR_MODES.map((mode) => (
                <ToggleButton key={mode} value={mode}>
                  {mode === 'light' ? t('common.theme.light') : t('common.theme.dark')}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>

          <Box>
            <Typography sx={{ fontWeight: 700, mb: 1 }}>{t('admin.settings.appearance.density')}</Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={appearance.density}
              onChange={(_, next: Density | null) => next && setDensity(next)}
              aria-label={t('admin.settings.appearance.density')}
            >
              {DENSITIES.map((density) => (
                <ToggleButton key={density} value={density} sx={{ textTransform: 'none' }}>
                  {density}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  )
}

/**
 * Sección que solo el propietario o un administrador pueden tocar. La UI lo
 * oculta y la RLS lo impide: son dos capas del mismo requisito, no una sola
 * repetida (contrato §13, doble enforcement).
 */
function ManagedSection({ children }: { children: ReactNode }) {
  const { can } = useTenant()
  const { t } = useI18n()
  if (!can('store.manage')) {
    return <UnauthorizedState description={t('admin.settings.unauthorized')} />
  }
  return <>{children}</>
}

/**
 * Personalización de la tienda.
 *
 * Un solo formulario para las dos pestañas de contenido (General y Marca) y una
 * sola barra de Guardar persistente: la regla de suite es tabs centrados +
 * barra sticky, no un botón por pestaña que deje cambios sin guardar al cambiar
 * de sección.
 *
 * Todo lo que se edita aquí lo lee la vitrina de `public_stores`, así que el
 * cambio se ve en `/s/:slug` en cuanto react-query revalida.
 */
export function SettingsPage() {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { activeStore, activeCompanyId, tenant, status: tenantStatus, can } = useTenant()
  const canManage = can('store.manage')

  const storeId = activeStore?.id ?? null
  const settings = useStoreSettings(canManage ? storeId : null)
  const save = useSaveStoreSettings()

  // `values` reconstruye el formulario cuando llega la fila de la base. Se
  // memoriza para no rearmar el objeto en cada tecla.
  const values = useMemo(
    () => toForm(activeStore?.name ?? '', settings.data ?? null),
    [activeStore?.name, settings.data],
  )

  const form = useForm<StoreFormValues>({ resolver: zodResolver(storeFormSchema), values })

  const logo = form.watch('logo_url')
  const banner = form.watch('banner_url')
  const assetUrls = useAssetUrls([logo, banner])

  async function onSubmit(values: StoreFormValues) {
    if (!storeId || !activeCompanyId || !tenant) return
    try {
      await save.mutateAsync({
        storeId,
        organizationId: tenant.organization_id,
        companyId: activeCompanyId,
        currentName: activeStore?.name ?? '',
        values,
      })
      notify(t('settings.toast.saved'))
      form.reset(values)
    } catch (error) {
      notify(t(errorKeyOf(error)), 'error')
    }
  }

  const busy = save.isPending || form.formState.isSubmitting
  const storeUrl = activeStore ? `/s/${activeStore.slug}` : null

  /**
   * Estado previo al formulario, calculado UNA vez.
   *
   * A propósito no es un componente envolvente: un componente definido dentro
   * del render se recrea en cada tecla y React remonta su árbol — el campo
   * perdería el foco a la primera letra.
   */
  const gate: ReactNode | null =
    tenantStatus === 'loading' ? (
      <LoadingState />
    ) : !storeId ? (
      <EmptyState title={t('admin.store.none')} description={t('admin.store.noneBody')} />
    ) : settings.isError ? (
      <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
    ) : settings.isPending ? (
      <LoadingState />
    ) : null

  return (
    <Box component="form" onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <PageHeader
        title={t('admin.settings.title')}
        actions={
          storeUrl && (
            <Button
              component={MuiLink}
              href={storeUrl}
              target="_blank"
              rel="noreferrer"
              variant="outlined"
              endIcon={<LaunchOutlinedIcon fontSize="small" />}
            >
              {t('settings.viewStore')}
            </Button>
          )
        }
      />
      <SectionTabs
        ariaLabel={t('admin.settings.title')}
        items={[
          {
            id: 'general',
            label: t('admin.settings.tab.general'),
            content: (
              <Card>
                <CardContent>
                  <ManagedSection>
                    {gate ?? (
                      <Stack spacing={2.5}>
                        <TextField
                          label={t('settings.name')}
                          helperText={
                            fieldError(form.formState.errors.name?.message, t) ??
                            t('settings.nameHelp')
                          }
                          error={Boolean(form.formState.errors.name)}
                          disabled={busy}
                          inputProps={{ maxLength: 200 }}
                          {...form.register('name')}
                        />
                        <TextField
                          label={t('settings.description')}
                          helperText={
                            fieldError(form.formState.errors.hero_subtitle?.message, t) ??
                            t('settings.descriptionHelp')
                          }
                          error={Boolean(form.formState.errors.hero_subtitle)}
                          disabled={busy}
                          multiline
                          minRows={2}
                          inputProps={{ maxLength: 240 }}
                          {...form.register('hero_subtitle')}
                        />

                        <Typography sx={{ fontWeight: 800, fontSize: 14, pt: 1 }}>
                          {t('settings.contact')}
                        </Typography>
                        <TextField
                          label={t('settings.contactEmail')}
                          type="email"
                          helperText={fieldError(form.formState.errors.support_email?.message, t)}
                          error={Boolean(form.formState.errors.support_email)}
                          disabled={busy}
                          inputProps={{ maxLength: 320 }}
                          {...form.register('support_email')}
                        />
                        <TextField
                          label={t('settings.contactPhone')}
                          helperText={fieldError(form.formState.errors.contact_phone?.message, t)}
                          error={Boolean(form.formState.errors.contact_phone)}
                          disabled={busy}
                          inputProps={{ maxLength: 40 }}
                          {...form.register('contact_phone')}
                        />
                        <TextField
                          label={t('settings.contactAddress')}
                          helperText={fieldError(form.formState.errors.contact_address?.message, t)}
                          error={Boolean(form.formState.errors.contact_address)}
                          disabled={busy}
                          inputProps={{ maxLength: 240 }}
                          {...form.register('contact_address')}
                        />
                      </Stack>
                    )}
                  </ManagedSection>
                </CardContent>
              </Card>
            ),
          },
          {
            id: 'branding',
            label: t('admin.settings.tab.branding'),
            content: (
              <Card>
                <CardContent>
                  <ManagedSection>
                    {gate ?? (
                      <Stack spacing={3}>
                        <Controller
                          control={form.control}
                          name="accent_color"
                          render={({ field, fieldState }) => (
                            <Stack spacing={1}>
                              <Typography sx={{ fontWeight: 700, fontSize: 14 }}>
                                {t('settings.accent')}
                              </Typography>
                              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                                <Box
                                  component="input"
                                  type="color"
                                  aria-label={t('settings.accent')}
                                  value={field.value}
                                  disabled={busy}
                                  onChange={(event) => field.onChange(event.target.value)}
                                  sx={{
                                    width: 52,
                                    height: 40,
                                    p: 0,
                                    border: '1px solid var(--border)',
                                    borderRadius: '8px',
                                    background: 'none',
                                    cursor: 'pointer',
                                  }}
                                />
                                <TextField
                                  size="small"
                                  value={field.value}
                                  onChange={(event) => field.onChange(event.target.value)}
                                  disabled={busy}
                                  error={Boolean(fieldState.error)}
                                  helperText={
                                    fieldError(fieldState.error?.message, t) ?? t('settings.accentHelp')
                                  }
                                  inputProps={{ maxLength: 7, 'aria-label': t('settings.accentHex') }}
                                  sx={{ maxWidth: 220 }}
                                />
                              </Stack>
                            </Stack>
                          )}
                        />

                        <Controller
                          control={form.control}
                          name="logo_url"
                          render={({ field }) => (
                            <StoreAssetField
                              kind="logo"
                              ratio="1 / 1"
                              label={t('settings.logo')}
                              help={t('settings.logoHelp')}
                              value={field.value}
                              previewUrl={field.value ? (assetUrls[field.value] ?? null) : null}
                              disabled={busy}
                              organizationId={tenant?.organization_id ?? ''}
                              storeId={storeId ?? ''}
                              onChange={field.onChange}
                            />
                          )}
                        />

                        <Controller
                          control={form.control}
                          name="banner_url"
                          render={({ field }) => (
                            <StoreAssetField
                              kind="banner"
                              ratio="16 / 6"
                              label={t('settings.banner')}
                              help={t('settings.bannerHelp')}
                              value={field.value}
                              previewUrl={field.value ? (assetUrls[field.value] ?? null) : null}
                              disabled={busy}
                              organizationId={tenant?.organization_id ?? ''}
                              storeId={storeId ?? ''}
                              onChange={field.onChange}
                            />
                          )}
                        />
                      </Stack>
                    )}
                  </ManagedSection>
                </CardContent>
              </Card>
            ),
          },
          {
            id: 'taxes',
            label: t('admin.settings.tab.taxes'),
            content: (
              <Card>
                <CardContent>
                  <ManagedSection>
                    <TaxesSection
                      organizationId={tenant?.organization_id ?? null}
                      companyId={activeCompanyId}
                      canManage={canManage}
                    />
                  </ManagedSection>
                </CardContent>
              </Card>
            ),
          },
          {
            id: 'appearance',
            label: t('admin.settings.tab.appearance'),
            content: <AppearanceSection />,
          },
        ]}
      />
      <Box
        sx={{
          display: canManage ? 'flex' : 'none',
          position: 'sticky',
          bottom: 0,
          mt: 3,
          py: 2,
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 1,
          bgcolor: 'var(--bg)',
          borderTop: '1px solid var(--border)',
        }}
      >
        {form.formState.isDirty && (
          <Typography sx={{ color: 'var(--muted)', fontSize: 13, mr: 'auto' }}>
            {t('settings.unsaved')}
          </Typography>
        )}
        <Button
          variant="text"
          type="button"
          disabled={busy || !form.formState.isDirty}
          onClick={() => form.reset()}
        >
          {t('common.cancel')}
        </Button>
        <Button variant="contained" type="submit" disabled={busy || !storeId}>
          {t('common.save')}
        </Button>
      </Box>
    </Box>
  )
}
