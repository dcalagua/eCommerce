import { Box, Tab, Tabs } from '@mui/material'
import { useEffect, useState, type ReactNode } from 'react'

export interface SectionTabItem {
  /** Se usa como `#hash` para el deep-link. */
  id: string
  label: string
  content: ReactNode
}

/**
 * Tabs centrados para pantallas largas/densas (contrato §8, regla gmao-025).
 * Deep-link por `#hash`: la pestaña abierta es compartible y sobrevive al refresco.
 */
export function SectionTabs({ items, ariaLabel }: { items: SectionTabItem[]; ariaLabel: string }) {
  const fallback = items[0]?.id ?? ''
  const [active, setActive] = useState<string>(() => {
    const hash = typeof window === 'undefined' ? '' : window.location.hash.replace('#', '')
    return items.some((i) => i.id === hash) ? hash : fallback
  })

  useEffect(() => {
    function onHashChange() {
      const hash = window.location.hash.replace('#', '')
      if (items.some((i) => i.id === hash)) setActive(hash)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [items])

  function select(id: string) {
    setActive(id)
    if (typeof window !== 'undefined') window.history.replaceState(null, '', `#${id}`)
  }

  const current = items.find((i) => i.id === active) ?? items[0]

  return (
    <Box>
      <Tabs
        value={current?.id ?? false}
        onChange={(_, value: string) => select(value)}
        centered
        aria-label={ariaLabel}
        sx={{
          borderBottom: '1px solid var(--border)',
          '& .MuiTab-root': { fontWeight: 700, textTransform: 'none', minHeight: 44 },
        }}
      >
        {items.map((item) => (
          <Tab key={item.id} value={item.id} label={item.label} id={`tab-${item.id}`} aria-controls={`panel-${item.id}`} />
        ))}
      </Tabs>
      {current && (
        <Box role="tabpanel" id={`panel-${current.id}`} aria-labelledby={`tab-${current.id}`} sx={{ pt: 3 }}>
          {current.content}
        </Box>
      )}
    </Box>
  )
}
