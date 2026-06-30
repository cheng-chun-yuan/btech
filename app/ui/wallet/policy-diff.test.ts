import { describe, it, expect } from "vitest";
import { diffPolicy } from "./policy-editor";
import type { PolicyConfig } from "./types";

const base: PolicyConfig = {
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
  ],
};

describe("diffPolicy", () => {
  it("returns empty when unchanged", () => {
    expect(diffPolicy(base, structuredClone(base))).toEqual([]);
  });

  it("detects an added signer", () => {
    const draft = structuredClone(base);
    draft.tiers[0].signers.push({ participantId: 3, npub: "n3", label: "C", rank: 0 });
    const d = diffPolicy(base, draft);
    expect(d.some((x) => x.kind === "add-signer")).toBe(true);
  });

  it("detects a threshold change", () => {
    const draft = structuredClone(base);
    draft.tiers[0].required = 2;
    const d = diffPolicy(base, draft);
    expect(d.some((x) => x.kind === "threshold")).toBe(true);
  });
});
