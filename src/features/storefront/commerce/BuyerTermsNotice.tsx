import AccountBalanceWalletRoundedIcon from '@mui/icons-material/AccountBalanceWalletRounded'
import GppMaybeRoundedIcon from '@mui/icons-material/GppMaybeRounded'
import { Box, Stack, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { TS } from '@/theme/tokens'
import { useApprovalPreview, useBuyerCredit } from './buyerTerms'

/**
 * Crédito y aprobación, dichos ANTES de pagar.
 *
 * Un comprador empresa necesita dos respuestas al mirar el total: si le alcanza
 * la línea de crédito y si alguien más tiene que firmar. Hasta ahora las dos
 * llegaban como error al confirmar. Se callan del todo cuando no aplican.
 */
export function BuyerTermsNotice({
  storeSlug,
  total,
  currency,
  compact = false,
}: {
  storeSlug: string
  /** El total que se va a cobrar, como texto (dinero). */
  total: string | null
  currency: string
  compact?: boolean
}) {
  const { t, locale } = useI18n()
  const credit = useBuyerCredit(storeSlug)
  const approval = useApprovalPreview(storeSlug, total)
  const importe = total === null ? null : Number(total)

  if (!credit && !approval?.required) return null

  const despues = credit && importe !== null ? credit.available - importe : null
  const alcanza = despues === null || despues >= 0
  const moneda = credit?.currency ?? currency
  const pct = credit?.limit && credit.limit > 0 ? Math.max(0, Math.min(100, (credit.available / credit.limit) * 100)) : null
  const pctPedido =
    credit?.limit && credit.limit > 0 && importe !== null
      ? Math.max(0, Math.min(pct ?? 0, (importe / credit.limit) * 100))
      : 0

  return (
    <Stack sx={{ gap: 1 }} data-buyer-terms>
      {credit ? (
        <Box
          data-buyer-credit={alcanza ? 'ok' : 'short'}
          sx={{
            p: compact ? 1 : 1.5,
            borderRadius: 'var(--sf-radius-sm, 12px)',
            bgcolor: alcanza ? 'color-mix(in srgb, var(--accent) 8%, var(--card))' : 'var(--red-soft)',
          }}
        >
          <Stack direction="row" className="sf-credit-head" sx={{ alignItems: 'center', gap: 0.75 }}>
            <AccountBalanceWalletRoundedIcon aria-hidden sx={{ fontSize: 17, color: alcanza ? 'var(--accent-deep)' : 'var(--red)' }} />
            <Typography sx={{ fontSize: TS.label, fontWeight: 800, color: alcanza ? 'var(--accent-deep)' : 'var(--red)' }}>
              {t('store.terms.credit').replace('{n}', String(credit.termsDays))}
            </Typography>
          </Stack>
          {pct !== null ? (
            <Box
              aria-hidden
              sx={{ display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', bgcolor: 'var(--neutral-soft)', my: 0.75 }}
            >
              <Box className="sf-credit-used" sx={{ width: `${Math.max(pct - pctPedido, 0)}%`, bgcolor: 'var(--accent)' }} />
              <Box className="sf-credit-order" sx={{ width: `${pctPedido}%`, bgcolor: alcanza ? 'var(--accent-deep)' : 'var(--red)' }} />
            </Box>
          ) : null}
          <Typography sx={{ fontSize: TS.label, color: 'var(--text)', mt: pct === null ? 0.5 : 0 }}>
            {despues === null
              ? t('store.terms.available').replace('{amount}', formatMoney(credit.available, moneda ?? currency, locale))
              : alcanza
                ? t('store.terms.after')
                    .replace('{available}', formatMoney(credit.available, moneda ?? currency, locale))
                    .replace('{after}', formatMoney(despues, moneda ?? currency, locale))
                : t('store.terms.short').replace('{amount}', formatMoney(credit.available, moneda ?? currency, locale))}
          </Typography>
        </Box>
      ) : null}

      {approval?.required ? (
        <Stack
          direction="row"
          data-approval-preview={approval.reason ?? 'required'}
          sx={{
            gap: 1,
            p: compact ? 1 : 1.5,
            borderRadius: 'var(--sf-radius-sm, 12px)',
            bgcolor: 'var(--amber-soft)',
          }}
        >
          <GppMaybeRoundedIcon aria-hidden sx={{ fontSize: 18, color: 'var(--amber)', mt: '1px' }} />
          <Box>
            <Typography sx={{ fontSize: TS.label, fontWeight: 800, color: 'var(--amber)' }}>
              {t('store.terms.approvalTitle')}
            </Typography>
            <Typography sx={{ fontSize: TS.label, color: 'var(--text)', lineHeight: 1.45 }}>
              {t(`store.terms.approval.${approval.reason ?? 'account_threshold'}` as MessageKey)}
            </Typography>
          </Box>
        </Stack>
      ) : null}
    </Stack>
  )
}
