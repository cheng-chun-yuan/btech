import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import { syncSigners } from "./identity";
import {
  DEFAULT_VALID_PARTICIPANT_IDS,
  resolveSignerSet,
  defaultSignerSet,
  isSelectedSigner,
  signedNpubs,
  allSelectedSigned,
} from "./governance";

function seedRoster(db: ReturnType<typeof openTestDb>) {
  syncSigners(
    db,
    Array.from({ length: 10 }, (_, i) => ({ participant_id: i + 1, label: `S${i + 1}`, role: "r" })),
  );
  const rows = db.prepare("SELECT npub, participant_id FROM signers ORDER BY participant_id").all() as
    { npub: string; participant_id: number }[];
  return rows;
}

describe("governance", () => {
  it("defaultSignerSet returns the canonical policy-valid set", () => {
    const db = openTestDb();
    seedRoster(db);
    const set = defaultSignerSet(db);
    expect(set.map((s) => s.participantId)).toEqual(DEFAULT_VALID_PARTICIPANT_IDS);
  });

  it("resolveSignerSet maps npubs to participant ids and rejects non-signers", () => {
    const db = openTestDb();
    const rows = seedRoster(db);
    const picked = [rows[0].npub, rows[2].npub];
    const resolved = resolveSignerSet(db, picked);
    expect(resolved.map((s) => s.participantId)).toEqual([1, 3]);
    expect(() => resolveSignerSet(db, ["npub-not-a-signer"])).toThrow();
  });

  it("isSelectedSigner / allSelectedSigned track the chosen quorum", () => {
    const db = openTestDb();
    const rows = seedRoster(db);
    const set = resolveSignerSet(db, [rows[0].npub, rows[2].npub]);
    expect(isSelectedSigner(set, rows[0].npub)).toBe(true);
    expect(isSelectedSigner(set, rows[5].npub)).toBe(false);
    expect(isSelectedSigner(undefined, rows[0].npub)).toBe(false);

    db.prepare("INSERT INTO approvals (id, vault, kind, data_json, status, is_live, created_at) VALUES ('tx1','#x','send','{}','pending',1,0)").run();
    db.prepare("INSERT INTO approval_signatures (approval_id, npub, signed_at) VALUES ('tx1',?,0)").run(rows[0].npub);
    const signed1 = signedNpubs(db, "tx1");
    expect(allSelectedSigned(set, signed1)).toBe(false);
    db.prepare("INSERT INTO approval_signatures (approval_id, npub, signed_at) VALUES ('tx1',?,0)").run(rows[2].npub);
    expect(allSelectedSigned(set, signedNpubs(db, "tx1"))).toBe(true);
  });
});
