import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SectionTabs } from '@/shared/ui/SectionTabs'
import { EmptyState } from '@/shared/ui/states'
import { useAppearance } from '@/theme/appearance-context'
import { COLOR_MODES, DENSITIES, type ColorMode, type Density } from '@/theme/tokens'

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

/** Pantalla larga → tabs centrados con deep-link `#hash` y barra de Guardar persistente. */
export function SettingsPage() {
  const { t } = useI18n()

  return (
    <>
      <PageHeader title={t('admin.settings.title')} />
      <SectionTabs
        ariaLabel={t('admin.settings.title')}
        items={[
          {
            id: 'general',
            label: t('admin.settings.tab.general'),
            content: (
              <Card>
                <EmptyState />
              </Card>
            ),
          },
          {
            id: 'branding',
            label: t('admin.settings.tab.branding'),
            content: (
              <Card>
                <EmptyState />
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
          position: 'sticky',
          bottom: 0,
          mt: 3,
          py: 2,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 1,
          bgcolor: 'var(--bg)',
          borderTop: '1px solid var(--border)',
        }}
      >
        <Button variant="text">{t('common.cancel')}</Button>
        <Button variant="contained">{t('common.save')}</Button>
      </Box>
    </>
  )
}
