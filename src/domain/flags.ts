/**
 * Feature flags TÉCNICOS (P02-SaaS).
 *
 * Archivo separado de `capabilities.ts` a propósito, y no por prolijidad: son
 * dos conceptos con distinto dueño, distinta vida y distinto poder, y
 * mezclarlos es cómo se acaba con un plan comercial editable desde la pantalla
 * de ajustes del propio cliente.
 *
 * |  | Entitlement | Flag técnico |
 * |---|---|---|
 * | Responde a | ¿lo contrató? | ¿está encendido? |
 * | Lo cambia | el hub (contrato §5/§6) | el administrador del tenant |
 * | Vive en | `tenant_entitlements` (cache del hub) | `tenant_feature_flags` |
 * | Puede conceder | sí | **nunca** |
 * | Puede apagar | sí | sí, salvo lo baseline |
 * | Se factura | sí | no |
 *
 * El poder asimétrico —solo restan— es la propiedad que sostiene todo lo
 * demás. Con ella, un flag es un corte de emergencia o un despliegue
 * progresivo; sin ella, es una vía para usar un módulo sin contratarlo.
 */

/**
 * Clave de flag. Es `string` y no una unión cerrada porque un flag nace para
 * apagar algo hoy y desaparece cuando el incidente termina: obligar a un
 * despliegue de la app para poder apagar un módulo derrota su motivo de
 * existir. La base valida la FORMA (`tenant_feature_flags_key_fmt`), no la
 * pertenencia a una lista.
 *
 * Convención: si la clave coincide con el `CapabilityId` de un módulo
 * vendible, el flag actúa de corte de emergencia sobre ese módulo. Cualquier
 * otra clave es un interruptor interno que solo entiende quien lo lee.
 */
export type FeatureFlagKey = string

export type FeatureFlags = Readonly<Record<FeatureFlagKey, boolean>>

export const NO_FLAGS: FeatureFlags = Object.freeze({})

/**
 * Un flag ausente está ENCENDIDO.
 *
 * Es la decisión correcta para un interruptor cuyo propósito es apagar: si la
 * ausencia se leyera como «apagado», una tabla vacía dejaría el producto
 * entero a oscuras y cada módulo nuevo nacería invisible hasta que alguien
 * recordara insertar su fila.
 */
export function isFlagEnabled(flags: FeatureFlags | null | undefined, key: FeatureFlagKey): boolean {
  return flags?.[key] !== false
}

/**
 * Lo que el hub o la base devuelven, normalizado.
 *
 * Todo lo que no sea booleano se descarta en vez de convertirse: un
 * `"false"` en texto es `true` para JavaScript, y un flag de apagado que se lee
 * al revés es exactamente el fallo que un flag existe para evitar.
 */
export function parseFeatureFlags(value: unknown): FeatureFlags {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return NO_FLAGS
  const out: Record<string, boolean> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'boolean') out[key] = raw
  }
  return Object.freeze(out)
}
