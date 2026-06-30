import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import { policyConfigToWire } from "./btech";
import { isBrickedPolicy } from "../approvals/policy-validate";
import { policyToDisplayTiers } from "../approvals/policy-mirror";

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

describe("isBrickedPolicy", () => {
  it("flags a tier requiring more signers than it has", () => {
    expect(
      isBrickedPolicy({
        tiers: [
          {
            id: "t",
            name: "Ops",
            rank: 2,
            required: 3,
            signers: [{ participantId: 6, npub: "n", label: "O", rank: 2 }],
          },
        ],
      }),
    ).toBe(true);
  });
  it("accepts a satisfiable policy (1-of-1 is allowed)", () => {
    expect(
      isBrickedPolicy({
        tiers: [
          {
            id: "t",
            name: "Solo",
            rank: 0,
            required: 1,
            signers: [{ participantId: 1, npub: "n", label: "A", rank: 0 }],
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("policyToDisplayTiers", () => {
  it("mirrors a 2-tier PolicyConfig into display tiers (minNeed + keys shape)", () => {
    const tiers = policyToDisplayTiers({
      tiers: [
        {
          id: "t0",
          name: "C-level",
          rank: 0,
          required: 1,
          signers: [
            { participantId: 1, npub: "n1", label: "Alice", rank: 0 },
            { participantId: 2, npub: "n2", label: "Bob", rank: 0 },
          ],
        },
        {
          id: "t1",
          name: "Operators",
          rank: 2,
          required: 3,
          signers: [{ participantId: 6, npub: "n6", label: "Omar", rank: 2 }],
        },
      ],
    });

    expect(tiers).toEqual([
      {
        id: "t0",
        name: "C-level",
        short: "C-L",
        minNeed: 1,
        keys: [
          { id: "k1", initials: "AL", name: "Alice", device: "Active", status: "online" },
          { id: "k2", initials: "BO", name: "Bob", device: "Active", status: "online" },
        ],
      },
      {
        id: "t1",
        name: "Operators",
        short: "OPE",
        minNeed: 3,
        keys: [{ id: "k6", initials: "OM", name: "Omar", device: "Active", status: "online" }],
      },
    ]);
  });
});
