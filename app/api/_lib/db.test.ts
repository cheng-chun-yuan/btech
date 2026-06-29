import { describe, it, expect } from "vitest";
import { openTestDb, seed } from "./db";

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

  it("seeds the mock chats and approvals once (idempotent)", () => {
    const db = openTestDb();
    const chats1 = db.prepare("SELECT COUNT(*) c FROM chats").get() as { c: number };
    const approvals1 = db.prepare("SELECT COUNT(*) c FROM approvals").get() as { c: number };
    expect(chats1.c).toBeGreaterThan(0);
    expect(approvals1.c).toBeGreaterThan(0);
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
});
