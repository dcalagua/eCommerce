// @vitest-environment node
/**
 * Ejecuta `database/platform_usage_outbox.test.sql` TAL CUAL sobre PGlite (con
 * TODAS las migraciones) con un shim mínimo de pgTAP.
 *
 * No sustituye a `supabase test db` (roles y privilegios reales de Supabase),
 * pero garantiza que el archivo pgTAP es SQL válido contra el esquema real y
 * que sus 39 aserciones pasan. El shim implementa solo lo que el archivo usa.
 */
import type { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase } from './harness.ts'

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'database', 'platform_usage_outbox.test.sql')

const SHIM = `
  create schema if not exists extensions;
  create table if not exists public.__tap (n serial primary key, ok boolean not null, description text);
  grant all on public.__tap to public;
  grant all on sequence public.__tap_n_seq to public;
  create or replace function extensions.__tap_record(p_ok boolean, p_desc text) returns text
  language plpgsql security definer as $$
  begin
    insert into public.__tap (ok, description) values (coalesce(p_ok, false), p_desc);
    return case when coalesce(p_ok, false) then 'ok' else 'not ok' end || ' - ' || coalesce(p_desc, '');
  end $$;
  grant execute on function extensions.__tap_record(boolean, text) to public;
  grant usage on schema extensions to public;
  create or replace function extensions.plan(integer) returns text language sql as $$ select '1..' || $1 $$;
  create or replace function extensions.ok(boolean, text default null) returns text language sql as $$ select extensions.__tap_record($1, $2) $$;
  create or replace function extensions."is"(anyelement, anyelement, text default null) returns text
    language sql as $$ select extensions.__tap_record($1 is not distinct from $2, $3) $$;
  create or replace function extensions.matches(text, text, text default null) returns text
    language sql as $$ select extensions.__tap_record($1 ~ $2, $3) $$;
  create or replace function extensions.has_schema(name) returns text
    language sql as $$ select extensions.__tap_record(exists(select 1 from pg_namespace where nspname = $1), 'has_schema ' || $1) $$;
  create or replace function extensions.has_table(name, name, text) returns text
    language sql as $$ select extensions.__tap_record(to_regclass($1 || '.' || $2) is not null, $3) $$;
  create or replace function extensions.throws_ok(text, text, text, text) returns text
  language plpgsql as $$
  begin
    execute $1;
    return extensions.__tap_record(false, $4 || ' (no lanzó)');
  exception when others then
    return extensions.__tap_record(sqlstate = $2, $4 || ' [' || sqlstate || ']');
  end $$;
  create or replace function extensions.results_eq(text, text, text) returns text
  language plpgsql as $$
  declare a jsonb; b jsonb;
  begin
    -- Por POSICIÓN de columna (json conserva el orden; jsonb ordena las claves).
    execute 'select coalesce(jsonb_agg((select jsonb_agg(e.value::jsonb order by e.n) from json_each(row_to_json(x)) with ordinality e(k, value, n))), ''[]'') from (' || $1 || ') x' into a;
    execute 'select coalesce(jsonb_agg((select jsonb_agg(e.value::jsonb order by e.n) from json_each(row_to_json(x)) with ordinality e(k, value, n))), ''[]'') from (' || $2 || ') x' into b;
    return extensions.__tap_record(a = b, $3 || case when a = b then '' else ' got ' || a::text || ' want ' || b::text end);
  end $$;
  create or replace function extensions.finish() returns setof text language sql as $$ select 'done'::text $$;
`

let db: PGlite

beforeAll(async () => {
  db = await createTestDatabase()
  await db.exec(SHIM)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('pgTAP platform_usage_outbox.test.sql sobre PGlite', () => {
  it('las 39 aserciones pasan', async () => {
    const sql = readFileSync(FILE, 'utf8')
      .replace(/^create extension if not exists pgtap.*$/m, '')
      // El resultado se lee ANTES del rollback final del archivo.
      .replace(/^rollback;\s*$/m, '')
    await db.exec(sql)
    const rows = (await db.query<{ ok: boolean; description: string }>('select ok, description from public.__tap order by n')).rows
    await db.exec('rollback')
    const failed = rows.filter((r) => !r.ok).map((r) => r.description)
    expect(failed).toEqual([])
    const plan = /select plan\((\d+)\)/.exec(sql)
    expect(rows).toHaveLength(Number(plan?.[1]))
  })
})
