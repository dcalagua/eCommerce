import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * Una pantalla que se carga aparte y SOBREVIVE a un despliegue.
 *
 * El fallo que arregla se ve así: alguien tiene el backoffice abierto, se
 * despliega una versión nueva y, al pulsar «Promociones», sale «Algo salió
 * mal · Failed to fetch dynamically imported module». No es un fallo del
 * despliegue ni de la red: el `index.html` que esa pestaña cargó nombra los
 * trozos de la versión ANTERIOR, y esos ficheros ya no existen — el nombre
 * lleva el hash del contenido, así que cada versión estrena los suyos.
 *
 * La pestaña, por tanto, se quedó hablando de una versión que ya no está. Y no
 * hay forma de pedir «el trozo equivalente de la versión nueva»: hay que
 * recargar para que el navegador vuelva a leer el `index.html` y con él los
 * nombres de ahora.
 *
 * Así que eso es lo que se hace, y en este orden:
 *
 *  1. **un segundo intento** — un corte de red de un segundo se arregla solo y
 *     no merece perder el estado de la página;
 *  2. **una recarga, UNA** — con marca en `sessionStorage`, porque una recarga
 *     que vuelve a fallar y vuelve a recargar es un bucle infinito, y un bucle
 *     infinito es peor que el error que venía a tapar;
 *  3. **el error, tal cual** — si ya se recargó, el problema no era la versión:
 *     que lo cuente la pantalla de error, que ofrece recargar a mano.
 */
const RELOAD_KEY = 'ecommerce-chunk-reload'

/** Cuánto vale una recarga. Pasado ese rato, el siguiente fallo merece otra. */
const RELOAD_TTL_MS = 30_000

/**
 * ¿Se puede recargar sin arriesgar un bucle?
 *
 * `sessionStorage` puede lanzar (navegación privada, cookies bloqueadas). Si no
 * hay dónde apuntar la marca, NO se recarga: sin marca no hay forma de parar el
 * bucle, y un error visible siempre es mejor que una pestaña que parpadea.
 */
function puedeRecargar(now: number): boolean {
  try {
    const previo = window.sessionStorage.getItem(RELOAD_KEY)
    if (previo && now - Number(previo) < RELOAD_TTL_MS) return false
    window.sessionStorage.setItem(RELOAD_KEY, String(now))
    return true
  } catch {
    return false
  }
}

/*
 * El `any` de la restriccion es el de `React.lazy`, copiado a proposito: una
 * pantalla con props concretas NO es un `ComponentType<unknown>` (las props van
 * al reves), asi que con `unknown` este ayudante solo valdria para las pantallas
 * sin props. Aqui no cruza ningun dato: solo dice "lo que sea que React acepte".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await load()
    } catch (error) {
      try {
        return await load()
      } catch {
        // El segundo intento tampoco: o la versión cambió bajo los pies, o de
        // verdad no hay red.
      }

      if (typeof window !== 'undefined' && puedeRecargar(Date.now())) {
        window.location.reload()
        // La recarga no es inmediata: sin esto React pintaría el error medio
        // segundo antes de que la página se vaya, que es un parpadeo feo y una
        // alarma falsa.
        return new Promise<{ default: T }>(() => {})
      }

      throw error
    }
  })
}
