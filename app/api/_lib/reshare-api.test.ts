import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import { policyConfigToWire } from "./btech";

describe("reshare schema", () => {
  it("schema version is at least 9", () => {
    const db = openTestDb();
    const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(9);
  });
});

describe("policyConfigToWire", () => {
  it("flattens tiers into grouped participants + requirements", () => {
    const wire = policyConfigToWire({
      tiers: [
        {
          id: "t0",
          name: "C-level",
          rank: 0,
          required: 1,
          signers: [
            { participantId: 1, npub: "n1", label: "A", rank: 0 },
            { participantId: 2, npub: "n2", label: "B", rank: 0 },
          ],
        },
        {
          id: "t1",
          name: "Ops",
          rank: 2,
          required: 3,
          signers: [{ participantId: 6, npub: "n6", label: "O", rank: 2 }],
        },
      ],
    });
    expect(wire.participants.length).toBe(3);
    expect(wire.participants).toEqual([
      { id: 1, rank: 0, label: "A" },
      { id: 2, rank: 0, label: "B" },
      { id: 6, rank: 2, label: "O" },
    ]);
    expect(wire.requirements).toEqual([
      { rank: 0, required: 1, total: 2 },
      { rank: 2, required: 3, total: 1 },
    ]);
  });
});
