// _test-helpers.ts — installs an in-memory app+subledger db (with a session)
// onto globalThis so route handlers' getDb() returns it. Not a vitest file.

import Database from "better-sqlite3";

import { migrate, seed } from "../_lib/db";
import { migrateSubledger, seedConfig } from "../_lib/subledger";

export const TEST_TOKEN = "test-token";

export function installTestDb(token: string = TEST_TOKEN): void {
  const db = new Database(":memory:");
  migrate(db);
  seed(db);
  migrateSubledger(db);
  seedConfig(db);
  db.prepare("INSERT INTO users (npub, label, role, created_at) VALUES (?, ?, ?, ?)").run(
    "npub-test",
    "Tester",
    "operator",
    0,
  );
  db.prepare("INSERT INTO sessions (token, npub, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token,
    "npub-test",
    0,
    4102444800000, // year 2100
  );
  (globalThis as unknown as { __btechDb?: unknown }).__btechDb = db;
}

export function clearTestDb(): void {
  (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined;
}
