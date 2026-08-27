import { Box, Stack, Typography } from '@mui/material'
import { useT } from '@/shared/i18n/i18n-context'
import { R, T } from '@/theme/tokens'
import type { PublicStore } from '../types'

/**
 * Banner de portada, configurable por el tenant desde `store_settings`.
 *
 * Los tres campos son opcionales y cada uno tiene su fallback:
 *   · sin `banner_url` → degradado de tokens (`--hero-grad`), que ya lleva el
 *     acento del tenant; nunca una foto de archivo ni una marca ajena.
 *   · sin `hero_title` → el nombre de la tienda.
 *   · sin `hero_subtitle` → una frase neutra de suite.
 *
 * Sin animación de entrada: es lo primero que se ve y un fundido solo retrasa
 * la lectura (y molesta con `prefers-reduced-motion`).
 */
export function StoreHero({ store }: { store: PublicStore }) {
  const t = useT()
  const title = store.hero_title?.trim() || store.name
  const subtitle = store.hero_subtitle?.trim() || t('store.hero.fallbackSubtitle')
  const hasImage = Boolean(store.banner_url)

  return (
    <Box
      component="section"
      aria-label={title}
      sx={{
        position: 'relative',
        borderRadius: `${R.xl}px`,
        overflow: 'hidden',
        border: '1px solid var(--border)',
        background: hasImage ? 'var(--neutral-soft)' : 'var(--hero-grad)',
        minHeight: { xs: 180, md: 260 },
        display: 'flex',
      }}
    >
      {hasImage && (
        <>
          <Box
            component="img"
            src={store.banner_url ?? undefined}
            alt=""
            aria-hidden
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
          {/* Velo para que el texto mantenga contraste AA sobre cualquier foto
              que suba el tenant: no controlamos qué imagen va a poner. */}
          <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(0,0,0,0.45)' }} aria-hidden />
        </>
      )}

      <Stack
        sx={{
          position: 'relative',
          justifyContent: 'flex-end',
          gap: 0.75,
          p: { xs: 2.5, md: 4 },
          maxWidth: 640,
          color: hasImage ? '#FFFFFF' : 'var(--text)',
        }}
      >
        <Typography component="h1" sx={{ fontSize: { xs: 22, md: T.hero }, fontWeight: 800 }}>
          {title}
        </Typography>
        <Typography sx={{ fontSize: T.bodyStrong, opacity: hasImage ? 0.92 : 1 }}>
          {subtitle}
        </Typography>
      </Stack>
    </Box>
  )
}
