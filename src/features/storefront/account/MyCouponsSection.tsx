import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import LocalActivityRoundedIcon from '@mui/icons-material/LocalActivityRounded'
import { Box, Card, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatDate, formatMoney } from '@/shared/lib/format'
import { BrandLoader } from '@/shared/ui/BrandLoader'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { fetchMyCoupons, myCouponsKey, type MyCoupon } from '../portal'

/**
 * Mis cupones.
 *
 * Aquí NO está el catálogo de cupones de la tienda: están los que le apuntan a
 * esta persona —abiertos a todos, o dirigidos a su cuenta—. Un cupón es una
 * llave, y la lista completa de llaves activas no se le da a nadie.
 *
 * Cada tarjeta enseña el código en monoespaciada y con un botón de copiar: el
 * código se teclea en el checkout, y transcribir «DERMO20» a mano es la forma
 * más fácil de que una promoción no se use.
 */
export function MyCouponsSection({ storeId }: { storeId: string }) {
  const { t } = useI18n()
  const query = useQuery({
    queryKey: myCouponsKey(storeId),
    queryFn: () => fetchMyCoupons(storeId),
  })

  if (query.isPending) return <BrandLoader />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />

  const cupones = query.data ?? []
  if (cupones.length === 0) {
    return (
      <EmptyState
        title={t('account.coupons.empty')}
        description={t('account.coupons.emptyBody')}
        icon={<LocalActivityRoundedIcon fontSize="small" />}
      />
    )
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
      }}
    >
      {cupones.map((cupon) => (
        <CuponCard key={cupon.code} cupon={cupon} />
      ))}
    </Box>
  )
}

function CuponCard({ cupon }: { cupon: MyCoupon }) {
  const { t, locale } = useI18n()
  const [copiado, setCopiado] = useState(false)

  async function copiar() {
    try {
      await navigator.clipboard.writeText(cupon.code)
      setCopiado(true)
      window.setTimeout(() => setCopiado(false), 2000)
    } catch {
      // Sin permiso de portapapeles el código sigue a la vista para teclearlo.
    }
  }

  const valor =
    cupon.value_percent !== null
      ? `${Number(cupon.value_percent)} %`
      : cupon.value_amount !== null
        ? formatMoney(Number(cupon.value_amount), 'PEN', locale)
        : null

  return (
    <Card
      sx={{
        p: 2,
        borderRadius: 'var(--sf-radius)',
        // Borde discontinuo: es el gesto de siempre para un vale recortable, y
        // separa el cupón de las tarjetas de producto sin inventar un color.
        border: '1px dashed color-mix(in srgb, var(--accent) 50%, transparent)',
        bgcolor: 'color-mix(in srgb, var(--accent) 6%, var(--card))',
      }}
    >
      <Stack sx={{ gap: 1.25 }}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {valor && (
            <Typography sx={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em' }}>
              {valor}
            </Typography>
          )}
          <Typography sx={{ fontSize: T.bodyStrong, fontWeight: 700 }}>
            {cupon.promotion_name}
          </Typography>
        </Stack>

        {cupon.promotion_description && (
          <Typography sx={{ fontSize: T.body, color: 'var(--muted)' }}>
            {cupon.promotion_description}
          </Typography>
        )}

        <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
          <Box
            sx={{
              px: 1.25,
              py: 0.5,
              borderRadius: 'var(--sf-radius-sm)',
              bgcolor: 'var(--card)',
              border: '1px solid var(--sf-line-strong)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontWeight: 800,
              letterSpacing: '0.08em',
            }}
          >
            {cupon.code}
          </Box>
          <Tooltip title={copiado ? t('account.coupons.copied') : t('account.coupons.copy')}>
            <IconButton size="small" onClick={() => void copiar()} aria-label={t('account.coupons.copy')}>
              <ContentCopyRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
          {cupon.min_subtotal !== null && Number(cupon.min_subtotal) > 0 && (
            <Chip
              size="small"
              label={t('account.coupons.minSubtotal').replace(
                '{amount}',
                formatMoney(Number(cupon.min_subtotal), 'PEN', locale),
              )}
              sx={{ bgcolor: 'var(--neutral-soft)', color: 'var(--muted)', fontWeight: 700 }}
            />
          )}
          {cupon.valid_to && (
            <Chip
              size="small"
              label={t('account.coupons.validUntil').replace(
                '{date}',
                formatDate(new Date(cupon.valid_to), locale),
              )}
              sx={{ bgcolor: 'var(--neutral-soft)', color: 'var(--muted)', fontWeight: 700 }}
            />
          )}
          {/* `null` es «sin límite», y por eso no se pinta un número: decir
              «te quedan 999» sería inventar una cifra que nadie fijó. */}
          {cupon.remaining_uses !== null && (
            <Chip
              size="small"
              label={t('account.coupons.remaining').replace('{n}', String(cupon.remaining_uses))}
              sx={{ bgcolor: 'var(--accent-soft)', color: 'var(--accent-deep)', fontWeight: 700 }}
            />
          )}
        </Stack>
      </Stack>
    </Card>
  )
}
