import { describe, it, expect } from "vitest";
import { initialsFor, colorForNpub } from "./avatar";

describe("initialsFor", () => {
  it("takes the first letter of the first two words, uppercased", () => {
    expect(initialsFor("Maya Ksiazek")).toBe("MK");
    expect(initialsFor("alice")).toBe("A");
    expect(initialsFor("")).toBe("");
  });
});

describe("colorForNpub", () => {
  it("is deterministic and returns a palette hex", () => {
    const a = colorForNpub("npub1abcdefg");
    expect(a).toBe(colorForNpub("npub1abcdefg"));
    expect(a).toMatch(/^#[0-9A-F]{6}$/i);
    // Different npubs may collide, but the function must not throw on any input.
    expect(() => colorForNpub("")).not.toThrow();
  });
});
