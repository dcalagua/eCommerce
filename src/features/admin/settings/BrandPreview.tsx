import ShoppingBagRoundedIcon from '@mui/icons-material/ShoppingBagRounded'
import { Box, Stack, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { brandFontStack, brandRadiusScale, T } from '@/theme/tokens'

const HEX = /^#[0-9a-fA-F]{6}$/

/**
 * Muestra de marca: qué pinta de verdad lo que se está eligiendo.
 *
 * Un `#056769` en una caja de texto no le dice a nadie cómo va a quedar su
 * tienda, y el color, el redondeo y la tipografía se eligen en tres campos
 * separados que solo se ven juntos en la vitrina —a la que hay que ir, mirar y
 * volver—. Aquí los tres caen sobre la misma pieza: cabecera, botón de compra y
 * etiqueta, que es donde el comprador los va a ver.
 *
 * **No es la vitrina, y no finge serlo.** Es una muestra pequeña y rotulada: si
 * imitara la portada entera, cualquier diferencia con la tienda real —una
 * sombra, un tamaño— se leería como un fallo.
 *
 * El color se aplica tal cual, incluso como color de TEXTO, porque es lo que
 * hace el tema cuando hay acento de tenant (`accentDeep` cae en el mismo hex).
 * Enseñar aquí una versión oscurecida sería una muestra más bonita que la
 * verdad. Un hex a medio escribir no pinta nada: se cae al acento de suite
 * hasta que el valor es válido, en vez de parpadear a negro con cada tecla.
 */
export function BrandPreview({
  color,
  radius,
  font,
  storeName,
}: {
  color: string
  /** Token de `BRAND_RADII` o cadena vacía: el redondeo elegido en el formulario. */
  radius: string
  /** Token de `BRAND_FONTS` o cadena vacía. */
  font: string
  storeName: string
}) {
  const { t } = useI18n()

  const accent = HEX.test(color) ? color : 'var(--accent)'
  const scale = brandRadiusScale(radius || null)
  const fontFamily = brandFontStack(font || null)
  const initial = storeName.trim().charAt(0).toUpperCase() || 'T'

  return (
    <Stack spacing={1}>
      <Typography
        sx={{
          fontSize: T.label,
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        {t('settings.preview')}
      </Typography>

      <Box
        sx={{
          fontFamily,
          border: '1px solid var(--border)',
          borderRadius: `${scale.lg}px`,
          overflow: 'hidden',
          bgcolor: 'var(--card)',
        }}
      >
        {/* Cabecera de la tienda: el acento en su uso de RELLENO. */}
        <Stack
          direction="row"
          spacing={1.25}
          sx={{
            alignItems: 'center',
            px: 1.75,
            py: 1.25,
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Box
            aria-hidden
            sx={{
              width: 30,
              height: 30,
              borderRadius: `${scale.md}px`,
              display: 'grid',
              placeItems: 'center',
              bgcolor: accent,
              color: '#fff',
              fontWeight: 800,
              fontSize: 13,
              flexShrink: 0,
            }}
          >
            {initial}
          </Box>
          <Typography
            sx={{
              fontWeight: 800,
              fontSize: T.bodyStrong,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {storeName || t('settings.preview.store')}
          </Typography>
        </Stack>

        <Stack spacing={1.25} sx={{ p: 1.75 }}>
          <Typography sx={{ fontSize: T.body, color: 'var(--muted)' }}>
            {t('settings.preview.product')}
          </Typography>

          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.75,
                px: 1.75,
                py: 0.875,
                borderRadius: `${scale.md}px`,
                bgcolor: accent,
                color: '#fff',
                fontWeight: 700,
                fontSize: T.body,
                lineHeight: 1.2,
              }}
            >
              <ShoppingBagRoundedIcon sx={{ fontSize: 16 }} aria-hidden />
              {t('store.product.addToCart')}
            </Box>

            {/* El mismo color como TEXTO sobre su propio fondo tenue: es el otro
                uso que hace la vitrina, y el que decide si el hex elegido se lee
                o no se lee. */}
            <Box
              component="span"
              sx={{
                px: 1.25,
                py: 0.5,
                borderRadius: `${scale.pill}px`,
                bgcolor: `color-mix(in srgb, ${accent} 14%, transparent)`,
                color: accent,
                fontWeight: 700,
                fontSize: T.label,
              }}
            >
              {t('settings.preview.badge')}
            </Box>
          </Stack>
        </Stack>
      </Box>
    </Stack>
  )
}
