import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined'
import { MenuItem, Stack, TextField, Typography } from '@mui/material'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'

/**
 * Selector de tienda.
 *
 * Hoy casi todos los tenants tienen una sola tienda y el selector se
 * autoselecciona y queda deshabilitado — pero existe desde ya, porque el
 * modelo de datos admite varias tiendas por sociedad (`stores.company_id`) y
 * añadir el selector después obligaría a repasar cada consulta del backoffice
 * para meterle el `store_id` que hoy ya viaja.
 */
export function StoreSwitcher() {
  const { stores, activeStore, setActiveStore } = useTenant()
  const { t } = useI18n()

  if (stores.length === 0) {
    return (
      <Typography sx={{ fontSize: 12.5, color: 'var(--muted)' }}>
        {t('admin.store.none')}
      </Typography>
    )
  }

  return (
    <TextField
      select
      size="small"
      value={activeStore?.id ?? ''}
      onChange={(event) => setActiveStore(event.target.value)}
      disabled={stores.length === 1}
      label={t('admin.store.label')}
      sx={{ minWidth: 180, '& .MuiInputBase-root': { fontSize: 13, fontWeight: 700 } }}
    >
      {stores.map((store) => (
        <MenuItem key={store.id} value={store.id}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <StorefrontOutlinedIcon sx={{ fontSize: 16 }} />
            <span>{store.name}</span>
          </Stack>
        </MenuItem>
      ))}
    </TextField>
  )
}

/**
 * Selector de sociedad. Solo aparece cuando el usuario tiene rol en más de una
 * sociedad de su cuenta; con una, mostrar un desplegable de un elemento sería
 * un adorno. Las opciones salen de las membresías que devolvió la RLS, así que
 * no se puede "elegir" una sociedad a la que no se pertenece.
 */
export function CompanySwitcher() {
  const { companies, memberships, activeCompanyId, setActiveCompany } = useTenant()
  const { t } = useI18n()

  if (companies.length <= 1) return null

  return (
    <TextField
      select
      size="small"
      value={activeCompanyId ?? ''}
      onChange={(event) => setActiveCompany(event.target.value)}
      label={t('admin.company.label')}
      sx={{ minWidth: 170, '& .MuiInputBase-root': { fontSize: 13, fontWeight: 700 } }}
    >
      {memberships.map((membership) => (
        <MenuItem key={membership.company_id} value={membership.company_id}>
          {/* El hub es el dueño del nombre de la sociedad; hasta que
              `platform-context` esté cableado (P03 pendiente de project ref) se
              muestra un identificador corto en vez de inventar un nombre. */}
          {membership.company_id.slice(0, 8)} · {membership.role}
        </MenuItem>
      ))}
    </TextField>
  )
}
