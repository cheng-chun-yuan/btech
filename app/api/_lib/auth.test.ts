import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import { createSession, getSessionUser, deleteSession } from "./auth";

function addUser(db: ReturnType<typeof openTestDb>, npub: string) {
  db.prepare("INSERT INTO users (npub, label, role, created_at) VALUES (?, 'Tester', 'Founder', ?)")
    .run(npub, Date.now());
}

describe("auth", () => {
  it("creates and resolves a session", () => {
    const db = openTestDb();
    addUser(db, "npub_x");
    const token = createSession(db, "npub_x");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const user = getSessionUser(db, token);
    expect(user?.npub).toBe("npub_x");
    expect(user?.label).toBe("Tester");
  });

  it("returns null for unknown or deleted token", () => {
    const db = openTestDb();
    addUser(db, "npub_y");
    const token = createSession(db, "npub_y");
    deleteSession(db, token);
    expect(getSessionUser(db, token)).toBe(null);
    expect(getSessionUser(db, "nope")).toBe(null);
  });

  it("returns null for expired session", () => {
    const db = openTestDb();
    addUser(db, "npub_z");
    const token = "deadbeef".repeat(8);
    db.prepare("INSERT INTO sessions (token, npub, created_at, expires_at) VALUES (?, 'npub_z', ?, ?)")
      .run(token, Date.now() - 1000, Date.now() - 500);
    expect(getSessionUser(db, token)).toBe(null);
  });
});
