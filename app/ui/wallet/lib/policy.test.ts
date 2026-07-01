import { describe, it, expect } from "vitest";
import { clampNeed, quorumOf, spendOf } from "./policy";
import type { Tier } from "../types";

const tier = (short: string, minNeed: number, keyCount: number): Tier => ({
  id: short, name: short, short, minNeed,
  keys: Array.from({ length: keyCount }, (_, i) => ({ id: `${short}${i}`, name: `k${i}` })) as Tier["keys"],
});

describe("policy", () => {
  it("clampNeed clamps to [1, keys.length]", () => {
    expect(clampNeed(tier("C", 5, 3))).toBe(3);
    expect(clampNeed(tier("C", 0, 3))).toBe(1);
    expect(clampNeed(tier("C", 2, 3))).toBe(2);
  });
  it("quorumOf joins per-tier need/total", () => {
    expect(quorumOf([tier("C", 1, 2), tier("M", 2, 3)])).toBe("1/2 + 2/3");
  });
  it("spendOf renders the AND policy string", () => {
    expect(spendOf([tier("C", 1, 2)])).toBe("spend = (1 of 2 C)");
  });
});
