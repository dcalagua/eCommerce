/**
 * Fronteras de arquitectura, comprobadas sobre el código real (P01-SaaS).
 *
 * Un mapa de arquitectura en un documento envejece en semanas: nadie lo lee al
 * abrir un archivo y nada falla cuando se incumple. Estas reglas son las mismas
 * del ADR 001 escritas de forma que la suite se ponga roja el día que alguien
 * las cruce, que es la única versión que sigue siendo verdad dentro de un año.
 *
 * Cada regla dice qué protege. Ninguna es estilística: si una se relaja, se
 * pierde una propiedad concreta del producto.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOUNDARIES, DOMAIN_IDS, boundaryForPath } from '@/domain/boundaries'

const SRC = dirname(fileURLToPath(import.meta.url))

interface SourceFile {
  /** Ruta relativa a `src/`, con `/` siempre. */
  readonly path: string
  readonly text: string
  /** El mismo texto sin comentarios: un comentario que NOMBRA lo prohibido
   *  para explicar por qué no está no puede dar un falso positivo. */
  readonly code: string
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const ALL: readonly SourceFile[] = walk(SRC).map((full) => {
  const text = readFileSync(full, 'utf8')
  return { path: relative(SRC, full).replace(/\\/g, '/'), text, code: stripComments(text) }
})

const isTest = (file: SourceFile) => /\.test\.tsx?$/.test(file.path) || file.path.startsWith('test/')
const PRODUCTION = ALL.filter((file) => !isTest(file))

/** Todos los `from '...'` e `import('...')` de un archivo. */
function importsOf(file: SourceFile): string[] {
  const found: string[] = []
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(file.code)) !== null) found.push(match[1] as string)
  return found
}

// ---------------------------------------------------------------------------

describe('el dominio es puro', () => {
  // Solo produccion: el test del dominio importa `vitest`, que es exactamente
  // el tipo de dependencia que la regla persigue en un modulo de producto.
  const domain = PRODUCTION.filter((f) => f.path.startsWith('domain/'))

  it('hay dominio que comprobar', () => {
    expect(domain.length).toBeGreaterThan(5)
  })

  /**
   * Protege la reutilización. Supabase es la persistencia de HOY y el ERP del
   * tenant puede ser la de mañana para la mitad de estas preguntas. Un dominio
   * que sabe de `PostgrestError`, de `useQuery` o de un componente no se
   * reutiliza: se reescribe.
   */
  it('no importa nada de infraestructura, UI ni features', () => {
    const allowed = /^(\.\.?\/|zod$)/
    const offenders: string[] = []

    for (const file of domain) {
      for (const specifier of importsOf(file)) {
        if (!allowed.test(specifier)) offenders.push(`${file.path} -> ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  /** Un import relativo que sale de `domain/` es la misma fuga por la puerta de atrás. */
  it('ningún import relativo escapa de src/domain', () => {
    const offenders = domain.flatMap((file) =>
      importsOf(file)
        .filter((s) => s.startsWith('.'))
        .filter((s) => {
          const resolved = join(SRC, dirname(file.path), s)
          return relative(join(SRC, 'domain'), resolved).startsWith('..')
        })
        .map((s) => `${file.path} -> ${s}`),
    )
    expect(offenders).toEqual([])
  })

  /**
   * Protege el contrato multitenant. `organization_id` y `company_id` salen
   * SIEMPRE del JWT en el servidor; un puerto que los acepte como parámetro
   * invita a pasarlos desde el navegador, que es exactamente lo que el
   * contrato prohíbe. Un parámetro que se puede pasar se puede pasar mal.
   */
  it('ningún puerto recibe el tenant como parámetro', () => {
    const offenders = domain
      .filter((f) => f.path.startsWith('domain/ports/'))
      .filter((f) => /organization_?[Ii]d|company_?[Ii]d|orgId/.test(f.code))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })
})

describe('Supabase es persistencia, no vocabulario de la UI', () => {
  const components = PRODUCTION.filter((f) => f.path.endsWith('.tsx'))

  /**
   * Protege la sustituibilidad del transporte y, sobre todo, la revisión de
   * seguridad: si una consulta puede nacer en cualquier componente, verificar
   * que ninguna declara su tenant obliga a leer las 60 pantallas en vez de la
   * docena de módulos de datos.
   *
   * `SessionProvider` es la única excepción y está justificada: la sesión de
   * Supabase Auth ES un estado de React (`onAuthStateChange` es una
   * suscripción), y envolverla en un módulo de datos solo movería el import.
   */
  const AUTH_STATE = 'features/auth/SessionProvider.tsx'

  it('ningún componente consulta la base directamente', () => {
    const offenders = components
      .filter((f) => /\.from\(\s*['"`]|\.rpc\(|functions\.invoke\(/.test(f.code))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('ningún componente crea un cliente de Supabase salvo el de la sesión', () => {
    const offenders = components
      .filter((f) => f.path !== AUTH_STATE)
      .filter((f) => importsOf(f).some((s) => /supabase/i.test(s)))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })
})

describe('el error del servidor no llega crudo a la pantalla', () => {
  /**
   * Protege dos cosas a la vez. Fuga: un `message` de PostgREST lleva dentro
   * nombres de tabla, de columna y de policy, y la vitrina la ve un comprador
   * anónimo. Y lógica: ramificar por texto se rompe en cuanto el servidor
   * cambia una palabra o responde en otro idioma. La regla del proyecto existe
   * desde P02; hasta P01 no se comprobaba, y había siete puntos que la
   * incumplían —cinco de ellos en la vitrina pública—.
   *
   * La única interpretación de texto admitida vive en `shared/lib/appError.ts`
   * y `shared/lib/edgeError.ts`, y de ahí sale un CÓDIGO.
   */
  const TEXT_READERS = [
    'shared/lib/appError.ts',
    'shared/lib/edgeError.ts',
    // Excepción documentada: el SDK de Supabase Auth no da código estable para
    // credenciales inválidas ni correo sin confirmar. La lectura muere en
    // `mapAuthError`, que devuelve una clave de i18n. Se retira en P16.
    'features/auth/authApi.ts',
  ]

  it('nadie construye un Error con el mensaje del servidor', () => {
    const offenders = PRODUCTION.filter((f) => /new Error\([^)]*\.message/.test(f.code)).map(
      (f) => f.path,
    )
    expect(offenders).toEqual([])
  })

  /**
   * Solo sobre módulos que NO son de presentación. En un `.tsx`,
   * `errors.name?.message` es un error de validación de React Hook Form —cuyo
   * `message` es, por convención de este repositorio, una clave de i18n— y no
   * tiene nada que ver con esto. La regla de arriba ya garantiza que ningún
   * `Error` lleva dentro el texto del servidor, así que pintarlo es seguro.
   */
  it('solo tres módulos de datos leen el texto de un error', () => {
    const offenders = PRODUCTION.filter((f) => !f.path.endsWith('.tsx'))
      .filter((f) => !TEXT_READERS.includes(f.path))
      .filter((f) => /error\??\.message|\.message\s*\.\s*(includes|match|startsWith)/.test(f.code))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })
})

describe('el core no conoce a ningún cliente ni proveedor por su nombre', () => {
  /**
   * Protege la respuesta a AA0004 del pliego —«personalización por
   * configuración, no por modificación de código»— y el principio 2 del
   * contrato EBIM. El día que un nombre propio entra en `src/`, deja de ser
   * cierto que el mismo binario sirve a dos clientes.
   *
   * Los proveedores concretos son DATOS: filas de `integration_providers`. Los
   * nombres de cliente solo pueden aparecer en fixtures de test, donde son
   * tienda de mentira y no configuración.
   */
  const FORBIDDEN = [
    /\bsap\b/i,
    /\bbapi/i,
    /s\/?4hana/i,
    /\bodoo\b/i,
    /alicorp/i,
    /casa[-\s]nordica/i,
    /lib[eé]lula/i,
    /gurusoft/i,
    /drivein/i,
    /\bcognos\b/i,
  ]

  it('ni en código ni en comentarios de producto', () => {
    const offenders: string[] = []
    for (const file of PRODUCTION) {
      if (file.path === 'architecture.test.ts') continue
      for (const pattern of FORBIDDEN) {
        if (pattern.test(file.text)) offenders.push(`${file.path} ~ ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('el mapa de fronteras describe el código que hay', () => {
  /**
   * Protege el mapa de la obsolescencia. Una carpeta nueva bajo `features/`
   * sin dominio declarado rompe la suite, así que quien la crea tiene que
   * decidir a qué frontera pertenece — que es justo la decisión que, tomada
   * tarde, produce el módulo que no se sabe dónde va.
   */
  it('todo archivo de features pertenece a una frontera declarada', () => {
    const orphans = ALL.filter((f) => f.path.startsWith('features/'))
      .filter((f) => boundaryForPath(f.path) === null)
      .map((f) => f.path)
    expect(orphans).toEqual([])
  })

  it('las rutas declaradas existen', () => {
    const missing = BOUNDARIES.flatMap((b) => b.paths)
      .filter((p) => !existsSync(join(SRC, p)))
      .map((p) => `src/${p}`)
    expect(missing).toEqual([])
  })

  it('los doce dominios de negocio están todos declarados', () => {
    const declared = BOUNDARIES.filter((b) => b.kind === 'domain').map((b) => b.id)
    expect([...declared].sort()).toEqual([...DOMAIN_IDS].sort())
  })

  /**
   * Una frontera `implemented` sin una sola ruta en `src/` es una casilla
   * marcada por optimismo. Las `declared` y `partial` sí pueden no tener
   * código: eso es exactamente lo que declaran.
   */
  it('lo declarado como implementado tiene código', () => {
    const empty = BOUNDARIES.filter((b) => b.state === 'implemented' && b.paths.length === 0).map(
      (b) => b.id,
    )
    expect(empty).toEqual([])
  })
})

describe('la frontera de tipos generados no vuelve a quedar en cero (R11)', () => {
  /**
   * `npm run db:types` escribía con `> archivo`, y esa redirección TRUNCA antes
   * de ejecutar el comando: un fallo del CLI dejaba el archivo en 0 bytes y un
   * exit code que nadie miraba. Pasó, y nadie lo notó porque ningún módulo lo
   * importaba. El generador se arregló en `scripts/gen-db-types.mjs`; esto es
   * la segunda red, por si alguien vuelve a la redirección.
   */
  const GENERATED = join(SRC, 'shared/lib/database.types.ts')

  it('si el archivo existe, tiene contenido y declara Database', () => {
    if (!existsSync(GENERATED)) return
    const text = readFileSync(GENERATED, 'utf8')
    expect(text.trim().length).toBeGreaterThan(0)
    expect(text).toMatch(/export type Database\b/)
  })
})
