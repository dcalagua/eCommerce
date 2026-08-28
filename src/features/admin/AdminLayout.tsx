import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined'
import MenuIcon from '@mui/icons-material/Menu'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import {
  Box,
  Chip,
  Divider,
  Drawer,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/app/ErrorBoundary'
import { useSessionContext } from '@/features/auth/session-context'
import { useCapabilities } from '@/features/capabilities/capabilities-context'
import { RequireTenant } from '@/features/tenant/RequireTenant'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { AppBreadcrumbs } from '@/shared/ui/AppBreadcrumbs'
import { BrandLockup } from '@/shared/ui/BrandLockup'
import { useAppearance } from '@/theme/appearance-context'
import { NAV_ITEMS, crumbsForPath, visibleNavItems } from './navigation'
import { CompanySwitcher, StoreSwitcher } from './StoreSwitcher'

const SIDEBAR_WIDTH = 244

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n()
  const { tenant, can } = useTenant()
  const { has, status } = useCapabilities()
  // Se calcula aqui y no en el modulo: el menu depende del rol Y de lo que la
  // sociedad tenga contratado, y las dos cosas cambian con el selector.
  const items = visibleNavItems(NAV_ITEMS, {
    can,
    has,
    capabilitiesReady: status === 'ready',
  })

  return (
    <Box
      component="nav"
      aria-label="Backoffice"
      sx={{
        height: '100%',
        background: 'var(--sidebar)',
        color: '#fff',
        px: 2,
        py: 2.5,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ px: 0.5, mb: 3 }}>
        <BrandLockup variant="white" size={30} />
      </Box>
      <Stack spacing={0.5}>
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className="eb-nav-h"
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 12px',
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 700,
              textDecoration: 'none',
              minHeight: 40,
              color: isActive ? '#fff' : 'rgba(237,247,241,.9)',
              background: isActive ? 'rgba(255,255,255,.16)' : 'transparent',
              boxShadow: isActive ? 'inset 0 0 0 1px rgba(255,255,255,.14)' : 'none',
              borderLeft: isActive ? '3px solid #D6F5C9' : '3px solid transparent',
            })}
          >
            {item.icon}
            {t(item.label)}
          </NavLink>
        ))}
      </Stack>

      {/* El nombre del espacio, siempre visible: con un usuario que administra
          más de una cuenta, saber en cuál estás no es un adorno (gmao-038). */}
      {tenant && (
        <Box sx={{ mt: 'auto', pt: 3, px: 0.5 }}>
          <Typography
            sx={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'rgba(237,247,241,.6)',
            }}
          >
            {t('admin.tenant.label')}
          </Typography>
          <Typography sx={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{tenant.name}</Typography>
        </Box>
      )}
    </Box>
  )
}

function AccountMenu() {
  const { t } = useI18n()
  const { email, role } = useTenant()
  const { signOut } = useSessionContext()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  return (
    <>
      <IconButton onClick={(event) => setAnchor(event.currentTarget)} aria-label={t('admin.account')}>
        <PersonOutlineIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <Box sx={{ px: 2, py: 1.25, maxWidth: 280 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 700, wordBreak: 'break-all' }}>
            {email || '—'}
          </Typography>
          {role && <Chip size="small" label={role} sx={{ mt: 0.75, fontWeight: 700 }} />}
        </Box>
        <Divider />
        <MenuItem
          onClick={() => {
            setAnchor(null)
            void signOut()
          }}
        >
          <ListItemIcon>
            <LogoutOutlinedIcon fontSize="small" />
          </ListItemIcon>
          {t('nav.signOut')}
        </MenuItem>
      </Menu>
    </>
  )
}

function AdminChrome() {
  const { t } = useI18n()
  const { appearance, toggleMode } = useAppearance()
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh', bgcolor: 'var(--bg)' }}>
      {isDesktop ? (
        <Box sx={{ width: SIDEBAR_WIDTH, flexShrink: 0 }}>
          <Box sx={{ position: 'fixed', width: SIDEBAR_WIDTH, height: '100dvh' }}>
            <SidebarContent />
          </Box>
        </Box>
      ) : (
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          PaperProps={{ sx: { width: SIDEBAR_WIDTH, border: 0 } }}
        >
          <SidebarContent onNavigate={() => setDrawerOpen(false)} />
        </Drawer>
      )}

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Topbar neutro (tratamiento A del contrato §4.4): la marca vive en el sidebar. */}
        <Toolbar
          sx={{
            bgcolor: 'var(--card)',
            borderBottom: '1px solid var(--border)',
            gap: 1,
            minHeight: { xs: 56, md: 64 },
            py: { xs: 1, md: 0.5 },
          }}
        >
          {!isDesktop && (
            <IconButton edge="start" onClick={() => setDrawerOpen(true)} aria-label={t('admin.openMenu')}>
              <MenuIcon />
            </IconButton>
          )}

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <AppBreadcrumbs
              items={crumbsForPath(location.pathname, t)}
              ariaLabel={t('admin.breadcrumb')}
            />
          </Box>

          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
              <CompanySwitcher />
            </Box>
            <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
              <StoreSwitcher />
            </Box>
            <IconButton
              onClick={toggleMode}
              aria-label={appearance.mode === 'dark' ? t('common.theme.light') : t('common.theme.dark')}
            >
              {appearance.mode === 'dark' ? (
                <LightModeOutlinedIcon fontSize="small" />
              ) : (
                <DarkModeOutlinedIcon fontSize="small" />
              )}
            </IconButton>
            <AccountMenu />
          </Stack>
        </Toolbar>

        {/* En móvil los selectores bajan a su propia fila: apretarlos en la
            barra los dejaría ilegibles justo donde menos espacio hay. */}
        <Stack
          direction="row"
          spacing={1}
          sx={{
            display: { xs: 'flex', sm: 'none' },
            px: 2,
            py: 1.5,
            bgcolor: 'var(--card)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <CompanySwitcher />
          <StoreSwitcher />
        </Stack>

        <Box component="main" sx={{ flex: 1, p: { xs: 2, md: 4 } }}>
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </Box>
      </Box>
    </Box>
  )
}

/**
 * Layout del backoffice del tenant. Área separada del storefront: rutas, layout
 * y guards propios, design system compartido.
 *
 * El guard de tenant envuelve al layout completo y no solo al contenido: sin
 * espacio resuelto no hay ni sidebar ni selectores que mostrar, y pintar el
 * chrome vacío mientras se decide es peor que no pintarlo.
 */
export function AdminLayout() {
  return (
    <RequireTenant>
      <AdminChrome />
    </RequireTenant>
  )
}
