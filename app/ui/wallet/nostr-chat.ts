import { nip19 } from "nostr-tools";
import type { Event, EventTemplate } from "nostr-tools";

export const CHAT_KIND = 23333;
export type ChatScope = "dm" | "group";

export function scopeFor(type: "channel" | "direct"): ChatScope {
  return type === "direct" ? "dm" : "group";
}

export function pubHexFromNpub(npub: string): string {
  const d = nip19.decode(npub);
  if (d.type !== "npub" || typeof d.data !== "string") throw new Error("not an npub");
  return d.data;
}
export function npubFromHex(hex: string): string {
  return nip19.npubEncode(hex);
}

/** Recipients of a fan-out: every member plus the sender (dedup), so the sender
 * backfills its own messages via the addressed-to-me path. */
export function fanoutRecipients(memberNpubs: string[], meNpub: string): string[] {
  return Array.from(new Set([...memberNpubs, meNpub]));
}

/** kind-23333 template matching relaychat.rs: tags t(chatId)/p(recipient)/chat(scope). */
export function buildChatEventTemplate(
  chatId: string,
  scope: ChatScope,
  recipientNpub: string,
  ciphertext: string,
  createdAt: number,
): EventTemplate {
  return {
    kind: CHAT_KIND,
    created_at: createdAt,
    tags: [["t", chatId], ["p", pubHexFromNpub(recipientNpub)], ["chat", scope]],
    content: ciphertext,
  };
}

export function isAddressedToMe(ev: Event, meHex: string): boolean {
  return ev.tags.some((t) => t[0] === "p" && t[1] === meHex);
}

export function parseChatEvent(ev: Event): { chatId: string; scope: string; authorNpub: string } | null {
  const chatId = ev.tags.find((t) => t[0] === "t")?.[1];
  const scope = ev.tags.find((t) => t[0] === "chat")?.[1];
  if (!chatId || !scope) return null;
  return { chatId, scope, authorNpub: npubFromHex(ev.pubkey) };
}
