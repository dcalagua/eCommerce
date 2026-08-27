/**
 * Validadores mínimos y sin dependencias. Las Edge Functions corren en Deno y
 * no comparten el `node_modules` del front: se prefiere código propio y corto
 * a arrastrar una librería de esquemas al runtime del borde.
 */
import { badRequest } from './errors.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function requireUuid(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw badRequest('CAMPO_INVALIDO', `\`${field}\` debe ser un uuid`)
  }
  return value.toLowerCase()
}

export function optionalUuid(body: Record<string, unknown>, field: string): string | null {
  const value = body[field]
  if (value === undefined || value === null) return null
  return requireUuid(body, field)
}

export function requireSlug(body: Record<string, unknown>, field: string): string {
  const value = typeof body[field] === 'string' ? (body[field] as string).trim().toLowerCase() : ''
  if (!SLUG_RE.test(value)) {
    throw badRequest(
      'CAMPO_INVALIDO',
      `\`${field}\` debe ser un slug en minusculas (a-z, 0-9, guiones), 3 a 62 caracteres`,
    )
  }
  return value
}

export function requireEmail(body: Record<string, unknown>, field: string): string {
  const value = typeof body[field] === 'string' ? (body[field] as string).trim().toLowerCase() : ''
  if (!EMAIL_RE.test(value)) {
    throw badRequest('CAMPO_INVALIDO', `\`${field}\` debe ser un correo valido`)
  }
  return value
}

export function requireText(
  body: Record<string, unknown>,
  field: string,
  { min = 1, max = 240 }: { min?: number; max?: number } = {},
): string {
  const value = typeof body[field] === 'string' ? (body[field] as string).trim() : ''
  if (value.length < min || value.length > max) {
    throw badRequest('CAMPO_INVALIDO', `\`${field}\` debe tener entre ${min} y ${max} caracteres`)
  }
  return value
}

export function optionalText(
  body: Record<string, unknown>,
  field: string,
  max = 2000,
): string | null {
  const value = body[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw badRequest('CAMPO_INVALIDO', `\`${field}\` debe ser texto`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > max) {
    throw badRequest('CAMPO_INVALIDO', `\`${field}\` supera los ${max} caracteres`)
  }
  return trimmed
}

export function requireEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = body[field]
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest('CAMPO_INVALIDO', `\`${field}\` debe ser uno de: ${allowed.join(', ')}`)
  }
  return value as T
}

/**
 * Rechaza claves desconocidas. Un campo que el servidor decide y que llega en
 * el payload es un error del cliente, no ruido a descartar.
 */
export function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw badRequest('CAMPO_NO_PERMITIDO', `Campos no admitidos: ${unknown.join(', ')}`)
  }
}
