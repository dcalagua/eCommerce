import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import MenuIcon from '@mui/icons-material/Menu'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import SpaceDashboardOutlinedIcon from '@mui/icons-material/SpaceDashboardOutlined'
import {
  Box,
  Drawer,
  IconButton,
  Stack,
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import { useState, type ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { ErrorBoundary } from '@/app/ErrorBoundary'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { BrandLockup } from '@/shared/ui/BrandLockup'
import { useAppearance } from '@/theme/appearance-context'

const SIDEBAR_WIDTH = 244

interface NavItem {
  to: string
  label: MessageKey
  icon: ReactNode
  end?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/app', label: 'nav.dashboard', icon: <SpaceDashboardOutlinedIcon fontSize="small" />, end: true },
  { to: '/app/products', label: 'nav.products', icon: <Inventory2OutlinedIcon fontSize="small" /> },
  { to: '/app/orders', label: 'nav.orders', icon: <ReceiptLongOutlinedIcon fontSize="small" /> },
  { to: '/app/settings', label: 'nav.settings', icon: <SettingsOutlinedIcon fontSize="small" /> },
]

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n()
  return (
    <Box
      component="nav"
      aria-label="Backoffice"
      sx={{ height: '100%', background: 'var(--sidebar)', color: '#fff', px: 2, py: 2.5 }}
    >
      <Box sx={{ px: 0.5, mb: 3 }}>
        <BrandLockup variant="white" size={30} />
      </Box>
      <Stack spacing={0.5}>
        {NAV_ITEMS.map((item) => (
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
    </Box>
  )
}

/**
 * Layout del backoffice del tenant. Área separada del storefront: rutas, layout
 * y guards propios, design system compartido.
 */
export function AdminLayout() {
  const { t } = useI18n()
  const { appearance, toggleMode } = useAppearance()
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const [drawerOpen, setDrawerOpen] = useState(false)

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
            minHeight: { xs: 56, md: 60 },
          }}
        >
          {!isDesktop && (
            <IconButton edge="start" onClick={() => setDrawerOpen(true)} aria-label="Abrir menú">
              <MenuIcon />
            </IconButton>
          )}
          <Typography sx={{ fontWeight: 800, fontSize: 13.5, flex: 1 }}>eCommerce</Typography>
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
        </Toolbar>

        <Box component="main" sx={{ flex: 1, p: { xs: 2, md: 4 } }}>
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </Box>
      </Box>
    </Box>
  )
}
