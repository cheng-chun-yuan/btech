import { describe, it, expect } from "vitest";
import { openTestDb, seed, getDb } from "./db";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

describe("db", () => {
  it("creates all tables", () => {
    const db = openTestDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const t of [
      "users", "sessions", "signers", "chats",
      "messages", "approvals", "approval_signatures", "schema_meta",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("seeds the vault channels once (idempotent); approvals are user-created", () => {
    const db = openTestDb();
    const chats1 = db.prepare("SELECT COUNT(*) c FROM chats").get() as { c: number };
    const approvals1 = db.prepare("SELECT COUNT(*) c FROM approvals").get() as { c: number };
    expect(chats1.c).toBeGreaterThan(0);
    // No seeded approval fixtures — they are created via POST /api/approvals.
    expect(approvals1.c).toBe(0);
    // Re-seeding must not duplicate.
    seed(db);
    const chats2 = db.prepare("SELECT COUNT(*) c FROM chats").get() as { c: number };
    expect(chats2.c).toBe(chats1.c);
  });

  it("seeds messages for seeded chats", () => {
    const db = openTestDb();
    const msgs = db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number };
    expect(msgs.c).toBeGreaterThan(0);
  });

  it("approval_signatures has a precommit column", () => {
    const db = openTestDb();
    const cols = (db.prepare("PRAGMA table_info(approval_signatures)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("precommit");
  });

  it("getDb() provisions the subledger sl_* schema in the app database", () => {
    const tmp = path.join(os.tmpdir(), `btech-sl-test-${process.pid}.db`);
    // force a fresh, file-backed db (getDb caches on globalThis)
    (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined;
    const prev = process.env.BTECH_DB;
    process.env.BTECH_DB = tmp;
    try {
      const db = getDb();
      const cfg = db.prepare("SELECT classification FROM sl_config WHERE asset='BTC'").get() as
        | { classification: string }
        | undefined;
      expect(cfg?.classification).toBe("INTANGIBLE_IAS38");
      // treasury tables still present alongside sl_* tables
      const chats = db.prepare("SELECT COUNT(*) c FROM chats").get() as { c: number };
      expect(chats.c).toBeGreaterThanOrEqual(0);
      db.close();
    } finally {
      (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined;
      if (prev === undefined) delete process.env.BTECH_DB;
      else process.env.BTECH_DB = prev;
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
    }
  });
});
