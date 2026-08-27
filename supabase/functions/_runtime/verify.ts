/**
 * Verificación de firma del token del hub.
 *
 * Vive en `_runtime` porque necesita el SDK y una llamada de red: `_shared` es
 * TypeScript puro que compila el `tsc` del repo.
 *
 * Por qué existe: `decodeClaims` NO verifica nada — solo lee el payload. Eso es
 * suficiente cuando la consulta viaja después con el mismo token y la RLS
 * vuelve a decidir, pero NO cuando el siguiente paso usa `service_role` y salta
 * la RLS, que es exactamente el caso del alta de tenant. Ahí un token inventado
 * a mano crearía un espacio a nombre de cualquiera.
 */
import { bearerToken, decodeClaims, type HubClaims } from '../_shared/auth.ts'
import { unauthorized } from '../_shared/errors.ts'
import { userClient } from './clients.ts'

/**
 * Valida el token contra el servidor de auth del proyecto (que en Modo A lo
 * valida a su vez contra el JWKS del hub) y solo entonces lee sus claims.
 *
 * El `sub` verificado tiene que coincidir con el del payload: si no, el token
 * que se envió a validar no es el mismo del que se están leyendo los claims.
 */
export async function verifyHubToken(request: Request): Promise<HubClaims> {
  const token = bearerToken(request)

  const { data, error } = await userClient(request).auth.getUser(token)
  if (error || !data?.user) {
    throw unauthorized('El token no es valido para este proyecto')
  }

  const claims = decodeClaims(token)
  if (claims.sub !== data.user.id) {
    throw unauthorized('El token no corresponde al usuario verificado')
  }
  return claims
}
