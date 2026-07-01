import { describe, it, expect } from "vitest";
import { fmtBtc, initialsOf, shortHex } from "./format";

describe("format", () => {
  it("fmtBtc renders sats as BTC", () => {
    // toLocaleString with minimumFractionDigits: 2 does not pad past 2 decimals
    // when the value has no more significant digits — actual output is "1.00",
    // not "1.00000000" (maximumFractionDigits only caps, it doesn't force padding).
    expect(fmtBtc(100_000_000)).toBe("1.00");
    expect(fmtBtc(0)).toBe("0.00");
  });
  it("initialsOf takes up to two word-initials, uppercased", () => {
    expect(initialsOf("Alice Founder")).toBe("AF");
    // Single-word labels use the first two letters of that word, not one letter
    // (actual `initialsOf` behavior: parts.length === 1 → slice(0, 2)).
    expect(initialsOf("bob")).toBe("BO");
  });
  it("shortHex abbreviates a long hex", () => {
    const h = "ab".repeat(20);
    expect(shortHex(h).length).toBeLessThan(h.length);
    expect(shortHex(h).startsWith("ab")).toBe(true);
  });
});
