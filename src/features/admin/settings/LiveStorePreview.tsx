import LockRoundedIcon from '@mui/icons-material/LockRounded'
import PhoneIphoneRoundedIcon from '@mui/icons-material/PhoneIphoneRounded'
import TabletMacRoundedIcon from '@mui/icons-material/TabletMacRounded'
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded'
import DesktopWindowsRoundedIcon from '@mui/icons-material/DesktopWindowsRounded'
import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PREVIEW_HIGHLIGHT, PREVIEW_MESSAGE, PREVIEW_PARAM, PREVIEW_READY } from '@/features/storefront/previewBridge'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { R, TS } from '@/theme/tokens'

type Pagina = 'home' | 'catalog' | 'product' | 'cart' | 'checkout'
type Dispositivo = 'desktop' | 'tablet' | 'mobile'

const ANCHO: Record<Dispositivo, number> = { desktop: 1280, tablet: 768, mobile: 390 }
/** Cuánto se ve de alto, en píxeles de pantalla (el iframe se desplaza dentro). */
const ALTO_VISIBLE = 760

const PAGINAS: readonly { id: Pagina; etiqueta: MessageKey }[] = [
  { id: 'home', etiqueta: 'settings.design.live.home' },
  { id: 'catalog', etiqueta: 'settings.design.live.catalog' },
  { id: 'product', etiqueta: 'settings.design.live.product' },
  { id: 'cart', etiqueta: 'settings.design.live.cart' },
  { id: 'checkout', etiqueta: 'settings.design.live.checkout' },
]

/**
 * La vista previa CON LA TIENDA DE VERDAD (Resumen v2).
 *
 * La anterior era un dibujo que imitaba la vitrina: sus propias cabeceras,
 * portadas y tarjetas de ejemplo. Cada tema nuevo —la feria de Retail, la
 * banda relámpago, las familias con icono— había que volver a dibujarlo allí,
 * y no se hacía: se elegía Retail y se veía una portada genérica.
 *
 * Ahora es la vitrina real en un iframe (`/s/:slug?vista_previa=1`), con sus
 * productos, sus fotos y sus puntos de corte (el iframe tiene el ancho del
 * dispositivo, y las media queries responden a él). Lo que hay en el
 * formulario SIN GUARDAR viaja por `postMessage` y la vitrina lo pinta encima:
 * ver `storefront/previewBridge.ts`. La tienda pública no se entera.
 */
export function LiveStorePreview({
  storeSlug,
  overrides,
  productSlug,
  highlight = null,
}: {
  storeSlug: string
  /** Lo que hay en el formulario, con los nombres de los campos de la tienda. */
  overrides: Record<string, unknown>
  /** Un producto real para la página «Producto». Sin él, se ofrece el catálogo. */
  productSlug: string | null
  /** Resumen v2 · La sección que se está tocando, para rodearla en la tienda. */
  highlight?: { section: string; label: string } | null
}) {
  const { t } = useI18n()
  const [pagina, setPagina] = useState<Pagina>('home')
  const [dispositivo, setDispositivo] = useState<Dispositivo>('desktop')
  const marco = useRef<HTMLIFrameElement | null>(null)
  const caja = useRef<HTMLDivElement | null>(null)
  const [disponible, setDisponible] = useState(900)

  // El ancho que hay, para encoger el dispositivo sin recortarlo.
  useLayoutEffect(() => {
    const nodo = caja.current
    if (!nodo || typeof ResizeObserver === 'undefined') return
    const observador = new ResizeObserver(([entrada]) => {
      if (entrada) setDisponible(entrada.contentRect.width)
    })
    observador.observe(nodo)
    return () => observador.disconnect()
  }, [])

  const ancho = ANCHO[dispositivo]
  const escala = Math.min(1, disponible / ancho)

  const ruta =
    pagina === 'catalog'
      ? `/s/${storeSlug}?ver=todo&${PREVIEW_PARAM}=1`
      : pagina === 'product' && productSlug
        ? `/s/${storeSlug}/product/${productSlug}?${PREVIEW_PARAM}=1`
        : pagina === 'cart'
          ? `/s/${storeSlug}/cart?${PREVIEW_PARAM}=1`
          : pagina === 'checkout'
            ? `/s/${storeSlug}/checkout?${PREVIEW_PARAM}=1`
            : `/s/${storeSlug}?${PREVIEW_PARAM}=1`

  // Enviar lo del formulario: al cambiar, y cuando la vitrina dice «ya estoy».
  const ultimo = useRef(overrides)
  ultimo.current = overrides
  const enviar = () =>
    marco.current?.contentWindow?.postMessage(
      { type: PREVIEW_MESSAGE, overrides: JSON.parse(JSON.stringify(ultimo.current)) },
      window.location.origin,
    )
  useEffect(() => {
    enviar()
  }, [overrides])
  useEffect(() => {
    marco.current?.contentWindow?.postMessage(
      { type: PREVIEW_HIGHLIGHT, section: highlight?.section ?? null, label: highlight?.label ?? '' },
      window.location.origin,
    )
  }, [highlight?.section, highlight?.label])
  useEffect(() => {
    const alRecibir = (evento: MessageEvent) => {
      if (evento.origin !== window.location.origin || evento.source !== marco.current?.contentWindow) return
      if ((evento.data as { type?: unknown } | null)?.type === PREVIEW_READY) enviar()
    }
    window.addEventListener('message', alRecibir)
    return () => window.removeEventListener('message', alRecibir)
  }, [])

  return (
    <Stack spacing={1.25} data-live-preview={pagina}>
      {/* La barra: página, dispositivo y el sello de que son datos reales. */}
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          gap: 1,
          flexWrap: 'wrap',
          p: 1,
          borderRadius: `${R.lg}px`,
          border: '1px solid var(--border)',
          bgcolor: 'var(--card)',
        }}
      >
        <ToggleButtonGroup
          exclusive
          size="small"
          value={pagina}
          aria-label={t('settings.design.live.page')}
          onChange={(_, valor: Pagina | null) => valor && setPagina(valor)}
          sx={{ '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 700, px: 1.5 } }}
        >
          {PAGINAS.map((p) => (
            <ToggleButton key={p.id} value={p.id} disabled={p.id === 'product' && !productSlug}>
              {t(p.etiqueta)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Box sx={{ flex: 1 }} />
        <ToggleButtonGroup
          exclusive
          size="small"
          value={dispositivo}
          aria-label={t('settings.design.live.device')}
          onChange={(_, valor: Dispositivo | null) => valor && setDispositivo(valor)}
        >
          <ToggleButton value="desktop" aria-label={t('settings.design.live.desktop')}>
            <DesktopWindowsRoundedIcon fontSize="small" />
          </ToggleButton>
          <ToggleButton value="tablet" aria-label={t('settings.design.live.tablet')}>
            <TabletMacRoundedIcon fontSize="small" />
          </ToggleButton>
          <ToggleButton value="mobile" aria-label={t('settings.design.live.mobile')}>
            <PhoneIphoneRoundedIcon fontSize="small" />
          </ToggleButton>
        </ToggleButtonGroup>
        <Stack
          direction="row"
          sx={{ alignItems: 'center', gap: 0.5, px: 1.25, py: 0.5, borderRadius: 999, bgcolor: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
        >
          <VerifiedRoundedIcon sx={{ fontSize: 15 }} aria-hidden />
          <Typography sx={{ fontSize: TS.label, fontWeight: 800 }}>{t('settings.design.live.real')}</Typography>
        </Stack>
      </Stack>

      {/* El navegador: barra con la dirección y la tienda debajo. */}
      <Box
        ref={caja}
        sx={{
          borderRadius: `${R.lg}px`,
          border: '1px solid var(--border)',
          overflow: 'hidden',
          bgcolor: 'var(--card)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1, px: 1.5, py: 1, bgcolor: 'var(--neutral-soft)' }}>
          {['#F28B82', '#FBD46D', '#8BD3A3'].map((color) => (
            <Box key={color} aria-hidden sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: color }} />
          ))}
          <Stack
            direction="row"
            sx={{ flex: 1, alignItems: 'center', gap: 0.75, px: 1.5, py: 0.5, borderRadius: 999, bgcolor: 'var(--card)', minWidth: 0 }}
          >
            <LockRoundedIcon aria-hidden sx={{ fontSize: 13, color: 'var(--muted)' }} />
            <Typography noWrap sx={{ fontSize: 12, color: 'var(--muted)' }}>
              {`${window.location.host}/s/${storeSlug}`}
            </Typography>
          </Stack>
        </Stack>
        <Box sx={{ height: ALTO_VISIBLE, display: 'flex', justifyContent: 'center', bgcolor: 'var(--neutral-soft)' }}>
          <Box sx={{ width: ancho * escala, height: ALTO_VISIBLE, overflow: 'hidden' }}>
            <Box
              component="iframe"
              ref={marco}
              title={t('settings.design.live.frameTitle')}
              src={ruta}
              sx={{
                border: 0,
                display: 'block',
                width: ancho,
                height: ALTO_VISIBLE / escala,
                transform: `scale(${escala})`,
                transformOrigin: 'top left',
                bgcolor: '#fff',
              }}
            />
          </Box>
        </Box>
      </Box>
      <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>{t('settings.design.live.note')}</Typography>
    </Stack>
  )
}
