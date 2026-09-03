import { z } from 'zod'

export {
  SALES_REPS_TABLE,
  SALES_REP_CUSTOMERS_TABLE,
  SALES_TERRITORIES_TABLE,
  SALES_ROUTES_TABLE,
  SALES_ROUTE_STOPS_TABLE,
} from '@/shared/lib/db-schema'

/**
 * Vocabulario de la fuerza de ventas en el CLIENTE.
 *
 * Es la mitad de pantalla de los CHECK de `20260902100100_sales_force.sql` y
 * `20260902110000_sales_territories.sql`. Existe para que el formulario diga
 * «ese código no vale» con el foco en el campo, **no para decidir**: si esto y
 * la base discrepan, manda la base.
 *
 * Cada regla de aquí tiene su gemela en una restricción de Postgres, y esa es
 * la que de verdad protege. Duplicarlas es deliberado —el mismo patrón que
 * `features/customers`— porque un 400 genérico no le dice a nadie qué arreglar.
 */

/** Mismo formato que `sales_reps_code_fmt`. */
const employeeCode = z
  .string()
  .trim()
  .min(1, 'sales.error.code')
  .max(40, 'sales.error.code')
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/, 'sales.error.code')

const optionalEmail = z
  .string()
  .trim()
  .max(320, 'sales.error.email')
  .refine((value) => value === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), 'sales.error.email')
  // Contrato §13: `@ebim.pe` no es actor de negocio de un tenant. La base lo
  // rechaza igual (`sales_reps_not_suite`); aquí se dice antes de enviar.
  .refine((value) => !value.toLowerCase().includes('@ebim.pe'), 'sales.error.suiteEmail')

export const MEMBER_STATUSES = ['invited', 'active', 'disabled'] as const
export type MemberStatus = (typeof MEMBER_STATUSES)[number]

export const salesRepSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  user_id: z.string().uuid().nullable().default(null),
  employee_code: z.string(),
  full_name: z.string(),
  email: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  manager_id: z.string().uuid().nullable().default(null),
  status: z.enum(MEMBER_STATUSES).catch('active'),
  hired_at: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
})
export type SalesRep = z.infer<typeof salesRepSchema>

export const salesRepFormSchema = z.object({
  employee_code: employeeCode,
  full_name: z.string().trim().min(1, 'sales.error.name').max(160, 'sales.error.name'),
  email: optionalEmail,
  phone: z.string().trim().max(40, 'sales.error.phone'),
  /** Cadena vacía = sin jefe. El `select` no puede emitir `null`. */
  manager_id: z.string(),
  status: z.enum(MEMBER_STATUSES),
  hired_at: z.string(),
  notes: z.string().trim().max(500, 'sales.error.notes'),
})
export type SalesRepFormValues = z.infer<typeof salesRepFormSchema>

export function emptyRepForm(): SalesRepFormValues {
  return {
    employee_code: '',
    full_name: '',
    email: '',
    phone: '',
    manager_id: '',
    status: 'active',
    hired_at: '',
    notes: '',
  }
}

export function repToForm(rep: SalesRep): SalesRepFormValues {
  return {
    employee_code: rep.employee_code,
    full_name: rep.full_name,
    email: rep.email ?? '',
    phone: rep.phone ?? '',
    manager_id: rep.manager_id ?? '',
    status: rep.status,
    hired_at: rep.hired_at ?? '',
    notes: rep.notes ?? '',
  }
}

/**
 * Los jefes que se le pueden ofrecer a un vendedor.
 *
 * Se excluye él mismo Y toda su descendencia. La base rechaza el ciclo con
 * `VENDEDOR_CICLO`, y un desplegable que ofrece lo que va a fallar es un
 * desplegable que miente — es la misma decisión que se tomó con el árbol de
 * categorías.
 */
export function managerOptions(reps: readonly SalesRep[], repId: string | null): SalesRep[] {
  if (!repId) return [...reps]

  const bloqueados = new Set<string>([repId])
  let crecio = true
  // Punto fijo en vez de recursión: la lista viene de la red y un ciclo que la
  // base no haya podido impedir colgaría el navegador.
  while (crecio) {
    crecio = false
    for (const rep of reps) {
      if (rep.manager_id && bloqueados.has(rep.manager_id) && !bloqueados.has(rep.id)) {
        bloqueados.add(rep.id)
        crecio = true
      }
    }
  }

  return reps.filter((rep) => !bloqueados.has(rep.id))
}

/** Una fila de la cartera, con el nombre del cliente ya resuelto. */
export const portfolioRowSchema = z.object({
  id: z.string().uuid(),
  sales_rep_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  is_primary: z.boolean(),
  assigned_at: z.string(),
  customer_code: z.string().nullable().default(null),
  customer_name: z.string().nullable().default(null),
})
export type PortfolioRow = z.infer<typeof portfolioRowSchema>
