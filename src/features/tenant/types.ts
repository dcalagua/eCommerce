import { z } from 'zod'

/**
 * Shape de branding homologado de suite (contrato §4.3). Nombres exactos:
 * `accent_color`, `brand_slug`, `white_label` — no inventar variantes.
 */
export const tenantBrandingSchema = z.object({
  name: z.string().min(1),
  logo_url: z.string().url().nullable().default(null),
  accent_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'accent_color debe ser un hex #RRGGBB')
    .nullable()
    .default(null),
  white_label: z.boolean().default(false),
  brand_slug: z.string().min(1),
})

export type TenantBranding = z.infer<typeof tenantBrandingSchema>

/**
 * Contexto de tenant del backoffice. `organization_id` y `company_id` son los
 * uuid del hub y SIEMPRE provienen del JWT — nunca del body, query o localStorage.
 */
export const tenantContextSchema = z.object({
  organization_id: z.string().uuid(),
  active_company: z.string().uuid(),
  companies: z.array(z.string().uuid()),
  apps: z.array(z.string()).default([]),
})

export type TenantContext = z.infer<typeof tenantContextSchema>
