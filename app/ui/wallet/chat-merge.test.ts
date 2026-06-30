import { describe, it, expect } from "vitest";
import { mergeNewChats } from "./chat-merge";
import type { Chat } from "./types";

const chat = (id: string, extra: Partial<Chat> = {}): Chat =>
  ({ id, type: "direct", name: id, messages: [], tiers: [], ...extra }) as Chat;

describe("mergeNewChats", () => {
  it("appends only chats whose id is not already present", () => {
    const prev = [chat("treasury"), chat("dm_a")];
    const fresh = [chat("treasury"), chat("dm_a"), chat("dm_new")];
    expect(mergeNewChats(prev, fresh).map((c) => c.id)).toEqual(["treasury", "dm_a", "dm_new"]);
  });

  it("returns the SAME array reference when nothing is new (no re-render / re-subscribe churn)", () => {
    const prev = [chat("treasury"), chat("dm_a")];
    const fresh = [chat("treasury")]; // a strict subset — nothing to add
    expect(mergeNewChats(prev, fresh)).toBe(prev);
  });

  it("never replaces existing chat objects, preserving the live-vault merge + fetched balances", () => {
    const treasury = chat("treasury", { balanceBtc: "1.23" });
    const prev = [treasury];
    // The poll's /api/chats returns a generic treasury (balance 0.00, no live merge).
    const fresh = [chat("treasury", { balanceBtc: "0.00" }), chat("dm_new")];
    const out = mergeNewChats(prev, fresh);
    expect(out[0]).toBe(treasury); // identity preserved → keeps 1.23 + live-vault state
    expect(out[1].id).toBe("dm_new");
  });
});
