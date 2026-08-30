import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded'
import { MenuItem, Stack, TextField, Typography } from '@mui/material'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'

/**
 * Selector de tienda.
 *
 * Con UNA sola tienda no es un selector: es una etiqueta. Un desplegable
 * deshabilitado de un solo elemento promete una eleccion que no existe, y el
 * usuario que trabaja siempre en el mismo cliente lo lee como algo roto. Mismo
 * criterio que `CompanySwitcher`, que ya se ocultaba con una sola sociedad.
 *
 * El componente sigue existiendo porque el modelo admite varias tiendas por
 * sociedad (`stores.company_id`): en cuanto haya una segunda, el selector
 * aparece solo, sin repasar una consulta del backoffice.
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

  // Una sola tienda: se muestra cual es, sin fingir que se puede cambiar.
  if (stores.length === 1) {
    return (
      <Stack
        direction="row"
        spacing={0.75}
        sx={{ alignItems: 'center', color: 'var(--muted)' }}
      >
        <StorefrontRoundedIcon sx={{ fontSize: 16 }} />
        <Typography sx={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
          {activeStore?.name ?? stores[0]?.name}
        </Typography>
      </Stack>
    )
  }

  return (
    <TextField
      select
      size="small"
      value={activeStore?.id ?? ''}
      onChange={(event) => setActiveStore(event.target.value)}
      label={t('admin.store.label')}
      sx={{ minWidth: 180, '& .MuiInputBase-root': { fontSize: 13, fontWeight: 700 } }}
    >
      {stores.map((store) => (
        <MenuItem key={store.id} value={store.id}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <StorefrontRoundedIcon sx={{ fontSize: 16 }} />
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
