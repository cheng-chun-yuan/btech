import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, nip19, finalizeEvent } from "nostr-tools";
import {
  CHAT_KIND, scopeFor, fanoutRecipients, buildChatEventTemplate, isAddressedToMe, parseChatEvent,
} from "./nostr-chat";

const npubOf = (sk: Uint8Array) => nip19.npubEncode(getPublicKey(sk));

describe("nostr-chat helpers", () => {
  it("scopeFor maps chat types to relaychat scopes", () => {
    expect(scopeFor("direct")).toBe("dm");
    expect(scopeFor("channel")).toBe("group");
  });

  it("CHAT_KIND is a relay-stored (regular) kind, not ephemeral", () => {
    // NIP-01 kind ranges: 1000–9999 = regular (relays store every event and
    // backfill it on a new REQ). 10000–19999 = replaceable, 20000–29999 =
    // EPHEMERAL (relays do NOT persist these), 30000–39999 = addressable.
    // Chat history relies on the relay storing + backfilling every message, so
    // CHAT_KIND MUST stay in the regular range. Kind 23333 was ephemeral, which
    // is exactly why messages vanished on reload / user switch — the relay never
    // stored them and the limit:500 backfill came back empty.
    expect(CHAT_KIND).toBeGreaterThanOrEqual(1000);
    expect(CHAT_KIND).toBeLessThan(10000);
  });

  it("fanoutRecipients includes self and dedups", () => {
    const r = fanoutRecipients(["npub_a", "npub_b", "npub_me"], "npub_me");
    expect(new Set(r)).toEqual(new Set(["npub_a", "npub_b", "npub_me"]));
    expect(r.filter((x) => x === "npub_me").length).toBe(1);
  });

  it("buildChatEventTemplate matches the relaychat.rs wire format", () => {
    const sk = generateSecretKey();
    const npub = npubOf(sk);
    const t = buildChatEventTemplate("chatX", "group", npub, "CIPHER", 1700000000);
    expect(t.kind).toBe(CHAT_KIND);
    expect(t.content).toBe("CIPHER");
    expect(t.created_at).toBe(1700000000);
    expect(t.tags).toContainEqual(["t", "chatX"]);
    expect(t.tags).toContainEqual(["p", getPublicKey(sk)]);
    expect(t.tags).toContainEqual(["chat", "group"]);
  });

  it("isAddressedToMe + parseChatEvent read back a signed event", () => {
    const sender = generateSecretKey();
    const me = generateSecretKey();
    const meHex = getPublicKey(me);
    const ev = finalizeEvent(buildChatEventTemplate("chatX", "dm", npubOf(me), "CIPHER", 1700000000), sender);
    expect(isAddressedToMe(ev, meHex)).toBe(true);
    expect(isAddressedToMe(ev, getPublicKey(generateSecretKey()))).toBe(false);
    const parsed = parseChatEvent(ev);
    expect(parsed).toEqual({ chatId: "chatX", scope: "dm", authorNpub: npubOf(sender) });
  });

  it("parseChatEvent returns null for an unknown chat scope", () => {
    const sender = generateSecretKey();
    const me = generateSecretKey();
    // Manually build a template with an unknown scope tag value
    const tmpl = {
      kind: CHAT_KIND,
      created_at: 1700000000,
      tags: [["t", "chatX"], ["p", getPublicKey(me)], ["chat", "bogus"]],
      content: "CIPHER",
    };
    const ev = finalizeEvent(tmpl, sender);
    expect(parseChatEvent(ev)).toBeNull();
  });
});
