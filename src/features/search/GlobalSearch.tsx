import LocalMallRoundedIcon from '@mui/icons-material/LocalMallRounded'
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import {
  Box,
  Dialog,
  DialogContent,
  InputBase,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { NAV_ITEMS, visibleNavItems } from '@/features/admin/navigation'
import { useCapabilities } from '@/features/capabilities/capabilities-context'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { useDebouncedValue } from '@/shared/lib/useDebouncedValue'
import { AppIcon } from '@/shared/ui/AppIcon'
import { R, T } from '@/theme/tokens'
import { useGlobalSearch, type SearchHit } from './searchApi'

interface Entry {
  key: string
  group: 'nav' | 'order' | 'product'
  title: string
  subtitle?: string
  to: string
}

/**
 * Buscador global.
 *
 * Busca en DOS sitios a la vez: las secciones del backoffice y los datos del
 * tenant. Un buscador que solo encuentra datos obliga a saberse el menú, y uno
 * que solo encuentra menús no sirve cuando lo que tienes es un número de pedido
 * en un correo.
 *
 * Las secciones salen de `visibleNavItems`, la MISMA función que pinta el
 * sidebar: así nunca ofrece una pantalla que el usuario no puede abrir por rol o
 * por addon no contratado. Duplicar esa lógica aquí habría creado un atajo a
 * pantallas prohibidas el día que alguien cambie una de las dos listas.
 *
 * Los datos van con debounce: sin él, cada tecla es una consulta a dos tablas.
 */
export function GlobalSearch() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { can, activeStore } = useTenant()
  const { has, status } = useCapabilities()

  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const debounced = useDebouncedValue(term, 250)
  const hits = useGlobalSearch(activeStore?.id ?? null, debounced, open)

  // Ctrl/⌘+K desde cualquier parte. Es el atajo que la gente ya tiene en los
  // dedos de otras herramientas; inventarse otro solo obliga a aprenderlo.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const navEntries: Entry[] = useMemo(() => {
    const visible = visibleNavItems(NAV_ITEMS, {
      can,
      has,
      capabilitiesReady: status === 'ready',
    })
    const needle = term.trim().toLowerCase()
    return visible
      .map((item) => ({
        key: `nav:${item.to}`,
        group: 'nav' as const,
        title: t(item.label),
        to: item.to,
      }))
      .filter((entry) => needle === '' || entry.title.toLowerCase().includes(needle))
  }, [can, has, status, t, term])

  const dataEntries: Entry[] = (hits.data ?? []).map((hit: SearchHit) => ({
    key: `${hit.kind}:${hit.id}`,
    group: hit.kind,
    title: hit.title,
    subtitle: hit.subtitle,
    to: hit.to,
  }))

  const entries = [...navEntries, ...dataEntries]

  // El cursor vuelve arriba al cambiar la consulta: dejarlo donde estaba
  // seleccionaria un resultado distinto del que se estaba mirando.
  useEffect(() => setCursor(0), [term, hits.data])

  function close() {
    setOpen(false)
    setTerm('')
    setCursor(0)
  }

  function go(entry: Entry | undefined) {
    if (!entry) return
    navigate(entry.to)
    close()
  }

  const groupLabel: Record<Entry['group'], string> = {
    nav: t('search.group.pages'),
    order: t('search.group.orders'),
    product: t('search.group.products'),
  }

  const groupIcon: Record<Entry['group'], ReactNode> = {
    nav: <SearchRoundedIcon />,
    order: <ReceiptLongRoundedIcon />,
    product: <LocalMallRoundedIcon />,
  }

  return (
    <>
      <Stack
        component="button"
        type="button"
        direction="row"
        onClick={() => setOpen(true)}
        aria-label={t('search.open')}
        sx={{
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 0.75,
          minWidth: { xs: 44, md: 280 },
          border: '1px solid var(--border)',
          borderRadius: `${R.md}px`,
          bgcolor: 'var(--neutral-soft)',
          color: 'var(--muted)',
          cursor: 'pointer',
          font: 'inherit',
          '&:hover': { borderColor: 'var(--accent)' },
        }}
      >
        <SearchRoundedIcon sx={{ fontSize: 18 }} />
        <Typography sx={{ fontSize: 13, flex: 1, textAlign: 'left', display: { xs: 'none', md: 'block' } }}>
          {t('search.placeholder')}
        </Typography>
        {/* La pista del atajo se enseña: un atajo que nadie descubre no existe. */}
        <Box
          sx={{
            display: { xs: 'none', md: 'block' },
            px: 0.75,
            py: 0.125,
            borderRadius: `${R.sm}px`,
            border: '1px solid var(--border)',
            bgcolor: 'var(--card)',
            fontSize: T.micro,
            fontWeight: 800,
          }}
        >
          Ctrl K
        </Box>
      </Stack>

      <Dialog
        open={open}
        onClose={close}
        fullWidth
        maxWidth="sm"
        slotProps={{ paper: { sx: { borderRadius: `${R.lg}px`, alignSelf: 'flex-start', mt: 8 } } }}
      >
        <Stack
          direction="row"
          spacing={1.25}
          sx={{ alignItems: 'center', px: 2, py: 1.5, borderBottom: '1px solid var(--border)' }}
        >
          <SearchRoundedIcon sx={{ color: 'var(--muted)' }} />
          <InputBase
            inputRef={inputRef}
            autoFocus
            fullWidth
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={t('search.placeholder')}
            inputProps={{ 'aria-label': t('search.placeholder') }}
            sx={{ fontSize: 15 }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((c) => Math.min(c + 1, Math.max(entries.length - 1, 0)))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                go(entries[cursor])
              }
            }}
          />
        </Stack>

        <DialogContent sx={{ p: 0, maxHeight: 420 }}>
          {entries.length === 0 ? (
            <Typography sx={{ p: 3, color: 'var(--muted)', fontSize: T.body }}>
              {hits.isFetching ? t('common.loading') : t('search.empty')}
            </Typography>
          ) : (
            (['nav', 'order', 'product'] as const).map((group) => {
              const list = entries.filter((entry) => entry.group === group)
              if (list.length === 0) return null
              return (
                <Box key={group}>
                  <Typography
                    sx={{
                      px: 2, pt: 1.5, pb: 0.5, fontSize: T.micro, fontWeight: 800,
                      letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--muted)',
                    }}
                  >
                    {groupLabel[group]}
                  </Typography>
                  {list.map((entry) => {
                    const index = entries.indexOf(entry)
                    return (
                      <ListItemButton
                        key={entry.key}
                        selected={index === cursor}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => go(entry)}
                        sx={{ px: 2, py: 1 }}
                      >
                        <ListItemIcon sx={{ minWidth: 0, mr: 1.5 }}>
                          <AppIcon tone={group === 'nav' ? 'neutral' : 'accent'} size="sm">
                            {groupIcon[group]}
                          </AppIcon>
                        </ListItemIcon>
                        <ListItemText
                          primary={entry.title}
                          secondary={entry.subtitle}
                          primaryTypographyProps={{ fontSize: 13, fontWeight: 700 }}
                          secondaryTypographyProps={{ fontSize: 11.5 }}
                        />
                      </ListItemButton>
                    )
                  })}
                </Box>
              )
            })
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
