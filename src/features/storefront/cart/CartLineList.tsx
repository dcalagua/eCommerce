import AddRoundedIcon from '@mui/icons-material/AddRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import RemoveRoundedIcon from '@mui/icons-material/RemoveRounded'
import { Box, IconButton, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { R, T } from '@/theme/tokens'
import { useSignedThumbnails } from '../hooks'
import { MAX_LINE_QUANTITY, lineKey, lineTotalCents, type Cart, type CartLine } from './cart'
import { useCart } from './cart-context'

/**
 * Líneas del carrito. Se usa igual en el panel lateral y en la página del
 * carrito: una sola implementación para que sumar, restar y quitar se comporten
 * exactamente igual en los dos sitios.
 */
export function CartLineList({
  cart,
  storeSlug,
  onNavigate,
  compact = false,
}: {
  cart: Cart
  storeSlug: string
  /** El panel se cierra al pulsar un enlace; la página no necesita nada. */
  onNavigate?: () => void
  compact?: boolean
}) {
  const thumbs = useSignedThumbnails(cart.lines.map((line) => line.image_path))

  return (
    <Stack component="ul" sx={{ listStyle: 'none', m: 0, p: 0, gap: compact ? 1.5 : 2 }}>
      {cart.lines.map((line) => (
        <CartLineRow
          key={lineKey(line)}
          line={line}
          storeSlug={storeSlug}
          imageUrl={line.image_path ? (thumbs[line.image_path] ?? null) : null}
          onNavigate={onNavigate}
          compact={compact}
        />
      ))}
    </Stack>
  )
}

function CartLineRow({
  line,
  storeSlug,
  imageUrl,
  onNavigate,
  compact,
}: {
  line: CartLine
  storeSlug: string
  imageUrl: string | null
  onNavigate?: () => void
  compact: boolean
}) {
  const { t, locale } = useI18n()
  const { setQuantity, remove } = useCart()
  const size = compact ? 56 : 72

  return (
    <Stack
      component="li"
      direction="row"
      sx={{
        gap: 1.5,
        alignItems: 'flex-start',
        pb: compact ? 1.5 : 2,
        borderBottom: '1px solid var(--border)',
        '&:last-of-type': { borderBottom: 'none', pb: 0 },
      }}
    >
      <Box
        component={Link}
        to={`/s/${storeSlug}/product/${line.slug}`}
        onClick={onNavigate}
        aria-label={line.name}
        sx={{
          width: size,
          height: size,
          flexShrink: 0,
          borderRadius: `${R.md}px`,
          bgcolor: 'var(--neutral-soft)',
          overflow: 'hidden',
          display: 'block',
        }}
      >
        {imageUrl && (
          <Box
            component="img"
            src={imageUrl}
            alt=""
            sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
      </Box>

      <Stack sx={{ flex: 1, minWidth: 0, gap: 0.5 }}>
        <Box
          component={Link}
          to={`/s/${storeSlug}/product/${line.slug}`}
          onClick={onNavigate}
          sx={{ textDecoration: 'none', color: 'inherit' }}
        >
          <Typography sx={{ fontSize: T.cardTitle, fontWeight: 700, lineHeight: 1.35 }}>
            {line.name}
          </Typography>
          {/* La variante va en su propia linea y no pegada al nombre: es lo que
              distingue dos lineas del mismo producto en el carrito. */}
          {line.variant_name && (
            <Typography sx={{ fontSize: T.label, color: 'var(--muted)', fontWeight: 700 }}>
              {line.variant_name}
            </Typography>
          )}
        </Box>
        <Typography sx={{ fontSize: T.label, color: 'var(--muted)', fontWeight: 600 }}>
          {formatMoney(Number(line.unit_price), line.currency, locale)} · {t('store.cart.each')}
        </Typography>

        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mt: 0.25 }}>
          <QuantityButton
            label={t('store.cart.decrease')}
            onClick={() => setQuantity(line.product_id, line.quantity - 1, line.variant_id)}
          >
            <RemoveRoundedIcon fontSize="inherit" />
          </QuantityButton>
          {/* `output` + `aria-live`: al pulsar +/- el lector canta la cantidad
              nueva sin tener que volver a leer toda la línea. */}
          <Typography
            component="output"
            aria-live="polite"
            aria-label={t('store.cart.quantity')}
            sx={{ minWidth: 28, textAlign: 'center', fontWeight: 800, fontSize: T.bodyStrong }}
          >
            {line.quantity}
          </Typography>
          <QuantityButton
            label={t('store.cart.increase')}
            disabled={line.quantity >= MAX_LINE_QUANTITY}
            onClick={() => setQuantity(line.product_id, line.quantity + 1, line.variant_id)}
          >
            <AddRoundedIcon fontSize="inherit" />
          </QuantityButton>

          <IconButton
            size="small"
            aria-label={`${t('store.cart.remove')}: ${line.name}${line.variant_name ? ` ${line.variant_name}` : ''}`}
            onClick={() => remove(line.product_id, line.variant_id)}
            sx={{ ml: 0.5, color: 'var(--muted)' }}
          >
            <DeleteRoundedIcon fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>

      <Typography sx={{ fontWeight: 800, fontSize: T.bodyStrong, whiteSpace: 'nowrap' }}>
        {formatMoney(lineTotalCents(line) / 100, line.currency, locale)}
      </Typography>
    </Stack>
  )
}

function QuantityButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <IconButton
      size="small"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      sx={{
        border: '1px solid var(--border)',
        borderRadius: `${R.sm}px`,
        width: 26,
        height: 26,
        fontSize: 16,
      }}
    >
      {children}
    </IconButton>
  )
}
