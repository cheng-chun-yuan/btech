import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import {
  isValidNpub, normalizeNpub, deterministicNpub, syncSigners, listSigners,
} from "./identity";

describe("identity", () => {
  it("deterministicNpub is stable and valid", () => {
    const a = deterministicNpub(1);
    const b = deterministicNpub(1);
    expect(a).toBe(b);
    expect(isValidNpub(a)).toBe(true);
    expect(deterministicNpub(2)).not.toBe(a);
  });

  it("validates and normalizes npub + hex", () => {
    const npub = deterministicNpub(3);
    expect(isValidNpub(npub)).toBe(true);
    expect(isValidNpub("npub1notreal")).toBe(false);
    expect(normalizeNpub(npub)).toBe(npub);
    expect(normalizeNpub("z".repeat(64))).toBe(null);
    expect(normalizeNpub("ab")).toBe(null);
  });

  it("syncSigners upserts users and signers idempotently", () => {
    const db = openTestDb();
    const invites = [
      { participant_id: 1, label: "Alice", role: "Founder" },
      { participant_id: 2, label: "Bob", role: "Security" },
    ];
    syncSigners(db, invites);
    syncSigners(db, invites);
    const signers = listSigners(db);
    expect(signers.length).toBe(2);
    expect(signers[0].npub).toBe(deterministicNpub(1));
    const users = db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number };
    expect(users.c).toBe(2);
  });
});
