import type { Session } from '@supabase/supabase-js'

/**
 * Cliente Supabase falso para los tests del frontend.
 *
 * No imita PostgREST entero: imita lo justo para que los componentes reales
 * corran contra él (encadenado `select().eq().order()`, `rpc`, `functions.invoke`
 * y el ciclo de vida de la sesión). Lo que NO simula, a propósito, es la RLS:
 * el aislamiento se prueba contra Postgres de verdad en `supabase/tests`, y
 * fingirlo aquí daría una falsa sensación de cobertura.
 */

export const ORG = '11111111-1111-4111-8111-111111111111'
export const COMPANY_A = '22222222-2222-4222-8222-222222222222'
export const COMPANY_B = '33333333-3333-4333-8333-333333333333'
export const USER = '44444444-4444-4444-8444-444444444444'
export const STORE_A = '55555555-5555-4555-8555-555555555555'

/** Construye un JWT real (sin firma válida) para probar la lectura de claims. */
export function makeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.firma-no-verificada`
}

export interface FakeSessionOptions {
  email?: string
  userId?: string
  claims?: Record<string, unknown>
  /** Cuando es false, la sesión no trae la jerarquía del hub. */
  withTenantClaims?: boolean
}

export function makeSession(options: FakeSessionOptions = {}): Session {
  const {
    email = 'duenio@negocio.com',
    userId = USER,
    withTenantClaims = true,
    claims = {},
  } = options

  const tenantClaims = withTenantClaims
    ? {
        org_id: ORG,
        active_company: COMPANY_A,
        companies: [{ id: COMPANY_A, role: 'admin' }],
        apps: ['ecommerce'],
      }
    : {}

  const payload = { sub: userId, email, ...tenantClaims, ...claims }

  return {
    access_token: makeJwt(payload),
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: 'refresh',
    user: {
      id: userId,
      email,
      aud: 'authenticated',
      app_metadata: { ...tenantClaims, ...claims },
      user_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    },
  } as unknown as Session
}

type Row = Record<string, unknown>

export interface FakeState {
  session: Session | null
  tables: Record<string, Row[]>
  rpc: Record<string, (args: Record<string, unknown>) => unknown>
  functions: Record<string, (body: Record<string, unknown>) => unknown>
  /** Todo lo que se envió a `functions.invoke`, para poder afirmar sobre ello. */
  invocations: Array<{ name: string; body: Record<string, unknown> }>
  /** Objetos "subidos" por bucket, para afirmar sobre rutas de Storage. */
  storage: Record<string, Record<string, { size: number; contentType: string }>>
}

type QueryResult = { data: Row[] | null; error: { message: string } | null }

type Mutation =
  | { kind: 'select' }
  | { kind: 'insert'; payload: Row }
  | { kind: 'update'; patch: Row }
  | { kind: 'delete' }

function compareCells(a: unknown, b: unknown): number {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Number(Boolean(a)) - Number(Boolean(b))
  }
  const numA = typeof a === 'number' ? a : Number(a)
  const numB = typeof b === 'number' ? b : Number(b)
  if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB
  return String(a ?? '').localeCompare(String(b ?? ''))
}

let idCounter = 0
function fakeId(): string {
  idCounter += 1
  return `99999999-9999-4999-8999-${String(idCounter).padStart(12, '0')}`
}

/**
 * Constructor encadenable mínimo: filtra en memoria y se resuelve como promesa.
 * Soporta también insert/update/delete porque el catálogo (P04) escribe en
 * tablas bajo RLS, no solo por Edge Function. Lo que NO simula, a propósito,
 * es la RLS: eso se prueba contra Postgres real en `supabase/tests`.
 */
class FakeQuery implements PromiseLike<QueryResult> {
  private rows: Row[]
  private mutation: Mutation = { kind: 'select' }

  constructor(
    private readonly state: FakeState,
    private readonly table: string,
  ) {
    this.rows = [...(state.tables[table] ?? [])]
  }

  select(): this {
    return this
  }

  insert(payload: Row): this {
    this.mutation = { kind: 'insert', payload }
    return this
  }

  update(patch: Row): this {
    this.mutation = { kind: 'update', patch }
    return this
  }

  delete(): this {
    this.mutation = { kind: 'delete' }
    return this
  }

  eq(column: string, value: unknown): this {
    this.rows = this.rows.filter((row) => row[column] === value)
    return this
  }

  /**
   * `or=` de PostgREST, en la forma que usa la app: `col.ilike.%texto%`
   * separado por comas. Se implementa de verdad (y no como un no-op) porque el
   * buscador de la vitrina es una de las cosas que estos tests comprueban; un
   * filtro que no filtra daría por bueno cualquier consulta.
   */
  or(filters: string): this {
    const clauses = filters.split(',').map((clause) => clause.trim()).filter(Boolean)
    if (clauses.length === 0) return this

    this.rows = this.rows.filter((row) =>
      clauses.some((clause) => {
        const [column, operator, ...rest] = clause.split('.')
        if (!column || !operator) return false
        const value = rest.join('.')
        const cell = row[column]
        if (cell === null || cell === undefined) return false
        if (operator === 'ilike') {
          const needle = value.replace(/^%|%$/g, '').toLowerCase()
          return String(cell).toLowerCase().includes(needle)
        }
        return String(cell) === value
      }),
    )
    return this
  }

  limit(count: number): this {
    this.rows = this.rows.slice(0, count)
    return this
  }

  /** Ordena por tipo: los booleanos y los números no se comparan como texto. */
  order(column: string, options?: { ascending?: boolean }): this {
    const ascending = options?.ascending ?? true
    this.rows.sort((a, b) => compareCells(a[column], b[column]))
    if (!ascending) this.rows.reverse()
    return this
  }

  /** Aplica la mutación una sola vez y devuelve las filas afectadas. */
  private apply(): Row[] {
    const table = this.state.tables[this.table] ?? (this.state.tables[this.table] = [])

    if (this.mutation.kind === 'insert') {
      const row = { id: fakeId(), ...this.mutation.payload }
      table.push(row)
      this.rows = [row]
    } else if (this.mutation.kind === 'update') {
      const patch = this.mutation.patch
      this.rows = this.rows.map((row) => Object.assign(row, patch))
    } else if (this.mutation.kind === 'delete') {
      const doomed = new Set(this.rows)
      this.state.tables[this.table] = table.filter((row) => !doomed.has(row))
    }
    this.mutation = { kind: 'select' }
    return this.rows
  }

  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return Promise.resolve({ data: this.apply()[0] ?? null, error: null })
  }

  single(): Promise<{ data: Row | null; error: { message: string; code: string } | null }> {
    const rows = this.apply()
    if (!rows[0]) {
      return Promise.resolve({
        data: null,
        error: { message: 'No rows found', code: 'PGRST116' },
      })
    }
    return Promise.resolve({ data: rows[0], error: null })
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.apply(), error: null }).then(onfulfilled, onrejected)
  }
}

export class FunctionsHttpErrorLike extends Error {
  readonly context: Response

  constructor(status: number, code: string) {
    super('Edge Function returned a non-2xx status code')
    this.name = 'FunctionsHttpError'
    this.context = new Response(JSON.stringify({ error: { code, message: code } }), { status })
  }
}

export function createFakeSupabase(initial: Partial<FakeState> = {}) {
  const state: FakeState = {
    session: initial.session ?? null,
    tables: initial.tables ?? {},
    rpc: initial.rpc ?? {},
    functions: initial.functions ?? {},
    invocations: [],
    storage: initial.storage ?? {},
  }

  type Listener = (event: string, session: Session | null) => void
  const listeners = new Set<Listener>()
  const emit = (event: string) => {
    for (const listener of listeners) listener(event, state.session)
  }

  const client = {
    state,
    emit,
    auth: {
      getSession: () => Promise.resolve({ data: { session: state.session }, error: null }),
      onAuthStateChange: (listener: Listener) => {
        listeners.add(listener)
        return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }
      },
      signInWithPassword: ({ email, password }: { email: string; password: string }) => {
        if (password === 'mal') {
          return Promise.resolve({
            data: { session: null, user: null },
            error: { message: 'Invalid login credentials', status: 400 },
          })
        }
        state.session = makeSession({ email })
        emit('SIGNED_IN')
        return Promise.resolve({ data: { session: state.session }, error: null })
      },
      signOut: () => {
        state.session = null
        emit('SIGNED_OUT')
        return Promise.resolve({ error: null })
      },
      resetPasswordForEmail: () => Promise.resolve({ data: {}, error: null }),
      updateUser: () => Promise.resolve({ data: { user: state.session?.user ?? null }, error: null }),
    },
    from: (table: string) => new FakeQuery(state, table),
    rpc: (name: string, args: Record<string, unknown>) => {
      const handler = state.rpc[name]
      if (!handler) {
        return Promise.resolve({ data: null, error: { message: `rpc ${name} no simulada` } })
      }
      return Promise.resolve({ data: handler(args), error: null })
    },
    storage: {
      from: (bucket: string) => {
        const objects = state.storage[bucket] ?? (state.storage[bucket] = {})
        return {
          upload: (path: string, file: File, options?: { contentType?: string }) => {
            objects[path] = { size: file.size, contentType: options?.contentType ?? file.type }
            return Promise.resolve({ data: { path }, error: null })
          },
          remove: (paths: string[]) => {
            for (const path of paths) delete objects[path]
            return Promise.resolve({ data: [], error: null })
          },
          createSignedUrls: (paths: string[]) =>
            Promise.resolve({
              data: paths.map((path) => ({
                path,
                signedUrl: `https://firmado.test/${path}`,
                error: null,
              })),
              error: null,
            }),
        }
      },
    },
    functions: {
      /**
       * `async` a propósito: un handler que devuelve una promesa se espera
       * aquí, y así un test puede dejar una llamada EN VUELO para comprobar,
       * por ejemplo, que un segundo envío no crea un segundo pedido.
       */
      invoke: async (name: string, options: { body: Record<string, unknown> }) => {
        state.invocations.push({ name, body: options.body })
        const handler = state.functions[name]
        if (!handler) {
          return { data: null, error: new FunctionsHttpErrorLike(500, 'ERROR_INTERNO') }
        }
        try {
          return { data: { data: await handler(options.body) }, error: null }
        } catch (error) {
          return { data: null, error }
        }
      },
    },
  }

  return client
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>
