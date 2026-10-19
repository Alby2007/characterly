/**
 * Shared helpers for test files.
 * Requires TEST_DATABASE_URL to point at a Postgres DB used exclusively for tests.
 */
import "dotenv/config";
import postgres from "postgres";
import { MemoryStore } from "./database.js";
import { EventStore } from "./events.js";

export function makeTestSql() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required to run tests");
  // Suppress NOTICE messages (e.g. "relation already exists, skipping") from migration DDL.
  return postgres(url, { max: 3, onnotice: () => {} });
}

/** Truncate all data tables while preserving schema and migration tracking. */
export async function clearData(sql: ReturnType<typeof postgres>) {
  // Every public-schema table except schema_migrations is test data —
  // including the conditional web_profiles/credit_ledger accounts tables,
  // which appear only where the Supabase schema was applied. Reading
  // pg_tables keeps the wipe self-maintaining: a new migration's tables are
  // covered without anyone remembering to extend a literal list.
  const tables = await sql<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`;
  if (!tables.length) return;
  const list = tables.map(t => `"${t.tablename.replace(/"/g, '""')}"`).join(", ");
  await sql.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Create a MemoryStore + EventStore pair backed by the given sql connection and wipe all data. */
export async function makeStore(sql: ReturnType<typeof postgres>) {
  // MemoryStore.create() runs migrations (idempotent) and returns an instance.
  const store = await MemoryStore.create(sql as any);
  await clearData(sql);
  const eventStore = new EventStore(sql as any);
  return { store, eventStore };
}
