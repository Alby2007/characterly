import postgres from "postgres";
import { config } from "./config.js";

// Shared postgres.js connection — one pool for the whole process.
// TEST_DATABASE_URL is only honored inside the node:test runner — a stray
// env var in production must never redirect the bot to the test database.
const underTest = Boolean(process.env.NODE_TEST_CONTEXT);
const url = (underTest ? process.env.TEST_DATABASE_URL : undefined) ?? config.databaseUrl;
if (!url) throw new Error("DATABASE_URL (or TEST_DATABASE_URL) must be set");
export const sql = postgres(url, {
  max: 10,
  onnotice: () => {}, // suppress "relation already exists" notices from idempotent DDL
});

export type Sql = typeof sql;
