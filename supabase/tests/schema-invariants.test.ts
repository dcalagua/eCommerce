// @vitest-environment node
/**
 * Invariantes que tienen que seguir siendo ciertas cuando el esquema crezca.
 *
 * Se consultan al catálogo de Postgres, no al texto del SQL: si alguien añade
 * una tabla en una migración futura sin RLS o sin tenant, esto falla aquí y no
 * en producción.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createTestDatabase, migrationFiles, readMigration } from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite

/** `tenants` es la tabla ancla del tenant: su PK ES el organization_id. */
const TENANT_ANCHOR = ['tenants']

beforeAll(async () => {
  db = await createTestDatabase()
}, 120_000)

afterAll(async () => {
  await db?.close()
})

async function rows(query: string): Promise<Row[]> {
  return (await db.query<Row>(query)).rows
}

describe('RLS', () => {
  it('todas las tablas de public tienen RLS activada y forzada', async () => {
    const result = await rows(`
      select c.relname as table_name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `)
    expect(result.length).toBeGreaterThanOrEqual(9)
    for (const row of result) {
      expect(`${row.table_name}: enabled=${row.enabled} forced=${row.forced}`).toBe(
        `${row.table_name}: enabled=true forced=true`,
      )
    }
  })

  it('ninguna tabla queda sin policy (default deny sin puerta de entrada)', async () => {
    const result = await rows(`
      select c.relname as table_name, count(p.polname)::int as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
      group by c.relname
      order by c.relname
    `)
    for (const row of result) {
      expect(`${row.table_name}:${row.policies}`).not.toMatch(/:0$/)
    }
  })

  it('ninguna policy es permisiva para PUBLIC (todos los roles a la vez)', async () => {
    const result = await rows(`
      select c.relname as table_name, p.polname as policy_name
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and p.polroles = '{0}'
    `)
    expect(result).toEqual([])
  })
})

describe('jerarquia organization -> company -> datos (contrato §3)', () => {
  it('toda tabla de negocio lleva organization_id y company_id', async () => {
    const result = await rows(`
      select c.relname as table_name,
             bool_or(a.attname = 'organization_id') as has_org,
             bool_or(a.attname = 'company_id')      as has_company
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
      group by c.relname
      order by c.relname
    `)

    for (const row of result) {
      const table = String(row.table_name)
      if (TENANT_ANCHOR.includes(table)) continue
      expect(`${table}: org=${row.has_org} company=${row.has_company}`).toBe(
        `${table}: org=true company=true`,
      )
    }
  })

  it('organization_id y company_id son NOT NULL en toda tabla de negocio', async () => {
    const result = await rows(`
      select c.relname as table_name, a.attname as column_name, a.attnotnull as not_null
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
        and a.attname in ('organization_id', 'company_id')
    `)
    for (const row of result) {
      expect(`${row.table_name}.${row.column_name}=${row.not_null}`).toMatch(/=true$/)
    }
  })

  it('no existe ninguna variante de nombre de tenant (tenant_id, org_id, ...)', async () => {
    const result = await rows(`
      select c.relname as table_name, a.attname as column_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
        and a.attname in ('tenant_id', 'org_id', 'orgid', 'organisation_id', 'companyid')
    `)
    expect(result).toEqual([])
  })

  it('el par (organization_id, company_id) esta indexado en cada tabla de negocio', async () => {
    const result = await rows(`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
        )
        and not exists (
          select 1
          from pg_index i
          join pg_attribute a on a.attrelid = c.oid and a.attnum = any (i.indkey)
          where i.indrelid = c.oid and a.attname = 'organization_id'
        )
    `)
    expect(result).toEqual([])
  })
})

describe('dinero y tipos', () => {
  it('no existe ninguna columna de importe en float/real/double/money', async () => {
    const result = await rows(`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('real', 'double precision', 'money')
    `)
    expect(result).toEqual([])
  })

  it('toda clave primaria de negocio es uuid', async () => {
    const result = await rows(`
      select c.relname as table_name, a.attname as column_name, t.typname as type_name
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum = any (i.indkey)
      join pg_type t on t.oid = a.atttypid
      where i.indisprimary and n.nspname = 'public' and c.relkind = 'r'
    `)
    expect(result.length).toBeGreaterThan(0)
    for (const row of result) {
      expect(`${row.table_name}.${row.column_name}:${row.type_name}`).toMatch(/:uuid$/)
    }
  })

  it('toda tabla de negocio tiene created_at', async () => {
    const result = await rows(`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and not exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'created_at' and not a.attisdropped
        )
    `)
    expect(result).toEqual([])
  })
})

describe('funciones SECURITY DEFINER', () => {
  it('ninguna corre con search_path mutable', async () => {
    const result = await rows(`
      select p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'ebim')
        and p.prosecdef
        and (p.proconfig is null or not exists (
          select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'
        ))
    `)
    expect(result).toEqual([])
  })

  it('las operaciones de servidor no son ejecutables por anon ni authenticated', async () => {
    const result = await rows(`
      select p.proname as name, r.rolname as role
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated')) as roles(rolname)
      join pg_roles r on r.rolname = roles.rolname
      where n.nspname = 'public'
        and p.proname in ('bootstrap_tenant', 'create_order')
        and has_function_privilege(r.oid, p.oid, 'EXECUTE')
    `)
    expect(result).toEqual([])
  })
})

describe('migraciones', () => {
  it('cada migracion que crea una tabla activa RLS en el mismo archivo', () => {
    const sinRls: string[] = []

    for (const file of migrationFiles()) {
      const sql = readMigration(file)
      const created = [...sql.matchAll(/create table (?:if not exists )?public\.(\w+)/gi)]
        .map((match) => match[1])
        .filter((table): table is string => Boolean(table))

      for (const table of created) {
        const enabled = new RegExp(
          `alter table public\\.${table}\\s+enable row level security`,
          'i',
        ).test(sql)
        const forced = new RegExp(
          `alter table public\\.${table}\\s+force\\s+row level security`,
          'i',
        ).test(sql)
        if (!enabled || !forced) sinRls.push(`${file}: ${table}`)
      }
    }

    expect(sinRls).toEqual([])
  })

  it('los nombres de migracion son unicos y ordenables', () => {
    const files = migrationFiles()
    expect(files).toEqual([...files].sort())
    expect(new Set(files).size).toBe(files.length)
    for (const file of files) {
      expect(file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/)
    }
  })

  it('ninguna migracion contiene una clave de servicio literal', () => {
    for (const file of migrationFiles()) {
      expect(readMigration(file)).not.toMatch(/sb_secret_|service_role_key|eyJhbGciOi/)
    }
  })
})
