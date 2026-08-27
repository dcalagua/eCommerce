import type { CSSProperties } from 'react'

/**
 * Isotipo EBIM — swirl de 6 figuras, viewBox 200x200.
 * Réplica byte a byte del asset de suite (contrato §4.6 / eexpense-015).
 * Brand-locked: NO cambia por tema ni por acento.
 */
export function EbimMark({
  variant = 'teal',
  size = 32,
  style,
}: {
  variant?: 'white' | 'teal'
  size?: number
  style?: CSSProperties
}) {
  const color = variant === 'white' ? '#FFFFFF' : '#0A5A52'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill={color}
      role="img"
      aria-label="EBIM"
      style={{ display: 'block', flexShrink: 0, ...style }}
    >
      <circle cx="100" cy="38" r="26" />
      <rect x="127.7" y="43" width="52" height="52" rx="4" transform="rotate(15 153.7 69)" />
      <rect x="127.7" y="105" width="52" height="52" rx="14" transform="rotate(-10 153.7 131)" />
      <rect x="74" y="136" width="52" height="52" rx="13" transform="rotate(45 100 162)" />
      <rect x="20.3" y="105" width="52" height="52" rx="16" transform="rotate(8 46.3 131)" />
      <rect x="20.3" y="43" width="52" height="52" rx="23" transform="rotate(-6 46.3 69)" />
    </svg>
  )
}
