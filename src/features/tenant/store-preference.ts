/**
 * Qué tienda estaba mirando este navegador.
 *
 * ## Por qué se guarda, si la sociedad NO se guarda
 *
 * La sociedad es jerarquía del token (contrato §3): guardarla en el navegador
 * la haría sobrevivir a un cambio de permisos en el hub, y eso es exactamente
 * lo que no puede pasar. La tienda no es eso — es un dato de negocio que llega
 * por RLS, y lo que se guarda aquí es una PREFERENCIA de pantalla: «de las
 * tuyas, empieza por esta».
 *
 * Y no manda nunca. El id guardado se busca en la lista de tiendas que devolvió
 * el servidor para la sociedad activa; si no está —porque se archivó, porque
 * cambió de sociedad o porque alguien escribió a mano en `localStorage`— se cae
 * a la primera. El navegador propone, la RLS dispone.
 *
 * ## Por qué una tienda POR SOCIEDAD
 *
 * Quien trabaja en dos sociedades tiene dos tiendas habituales, y recordar solo
 * la última le devolvería la de la otra sociedad cada vez que cambia. El mapa
 * crece con el número de sociedades del usuario, que son unidades, no miles.
 */
const KEY = 'ecommerce-active-store'

export type StorePreferences = Readonly<Record<string, string>>

/**
 * Lee el mapa. Cualquier fallo devuelve vacío: `localStorage` lanza en
 * navegación privada y con cookies bloqueadas, y una preferencia de pantalla no
 * puede tumbar el backoffice.
 */
export function readStorePreferences(): StorePreferences {
  try {
    const crudo = window.localStorage.getItem(KEY)
    if (!crudo) return {}

    const parsed: unknown = JSON.parse(crudo)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    // Solo pares de cadenas: lo que haya escrito otra versión —o alguien a
    // mano— no puede colarse como id de tienda.
    const limpio: Record<string, string> = {}
    for (const [company, store] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof store === 'string' && store.length > 0) limpio[company] = store
    }
    return limpio
  } catch {
    return {}
  }
}

/** Apunta la tienda elegida para esa sociedad. Sin sociedad no se guarda nada. */
export function writeStorePreference(companyId: string | null, storeId: string): void {
  if (!companyId) return
  try {
    const siguiente = { ...readStorePreferences(), [companyId]: storeId }
    window.localStorage.setItem(KEY, JSON.stringify(siguiente))
  } catch {
    // Sin sitio donde guardar, la sesión sigue funcionando: la elección vive en
    // memoria hasta que se recargue.
  }
}
