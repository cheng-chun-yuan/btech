import { nip19, SimplePool } from "nostr-tools";
import type { Event, EventTemplate, Filter } from "nostr-tools";
import type { NostrSigner } from "./nostr-signer";

// Regular (relay-stored) kind in NIP-01's 1000–9999 range, so the relay persists
// every message and backfills it on reconnect. The previous value (23333) sat in
// the ephemeral range (20000–29999), which NIP-compliant relays drop instead of
// storing — that is why chat history vanished on reload / user switch.
export const CHAT_KIND = 9233;
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

/** kind-9233 template matching relaychat.rs: tags t(chatId)/p(recipient)/chat(scope). */
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

export function parseChatEvent(ev: Event): { chatId: string; scope: ChatScope; authorNpub: string } | null {
  const chatId = ev.tags.find((t) => t[0] === "t")?.[1];
  const rawScope = ev.tags.find((t) => t[0] === "chat")?.[1];
  if (!chatId || !rawScope) return null;
  if (rawScope !== "dm" && rawScope !== "group") return null;
  const scope: ChatScope = rawScope;
  return { chatId, scope, authorNpub: npubFromHex(ev.pubkey) };
}

export type DecryptedMessage = {
  id: string;
  chatId: string;
  authorNpub: string;
  text: string;
  createdAt: number;
};

/** Reusable relay chat client for BOTH dm and group scopes. */
export class NostrChatClient {
  private readonly pool = new SimplePool();
  private readonly relays: string[];
  private readonly meHex: string;
  private readonly seen = new Set<string>(); // dedup by event id

  constructor(
    private readonly signer: NostrSigner,
    private readonly meNpub: string,
    relayUrl: string,
  ) {
    this.relays = [relayUrl];
    this.meHex = pubHexFromNpub(meNpub);
  }

  /** Fan-out: encrypt + sign + publish one kind-9233 event per recipient (incl self).
   * Skips unreachable recipients with a console.warn; throws only if every recipient fails. */
  async publish(chatId: string, scope: ChatScope, memberNpubs: string[], text: string): Promise<void> {
    const createdAt = Math.floor(Date.now() / 1000);
    let attempted = 0;
    let succeeded = 0;
    for (const recipient of fanoutRecipients(memberNpubs, this.meNpub)) {
      attempted++;
      try {
        const ciphertext = await this.signer.encrypt(recipient, text);
        const ev = await this.signer.signEvent(
          buildChatEventTemplate(chatId, scope, recipient, ciphertext, createdAt),
        );
        // publish() returns one promise per relay; succeed if any relay accepts.
        await Promise.any(this.pool.publish(this.relays, ev));
        succeeded++;
      } catch (err) {
        console.warn(`[nostr-chat] publish: skipping recipient ${recipient}`, err);
      }
    }
    if (attempted > 0 && succeeded === 0) {
      throw new Error("relay rejected the message");
    }
  }

  /** Subscribe to my chats: backfill + live. Calls onMessage for each decryptable
   * event addressed to me from a known chat member, deduped by event id. Returns a closer. */
  subscribe(chatIds: string[], knownAuthors: Set<string>, onMessage: (m: DecryptedMessage) => void): { close: () => void } {
    const filter: Filter = { kinds: [CHAT_KIND], "#t": chatIds, limit: 500 };
    const sub = this.pool.subscribeMany(this.relays, filter, {
      onevent: (ev) => {
        if (this.seen.has(ev.id)) return;
        this.seen.add(ev.id);
        if (!isAddressedToMe(ev, this.meHex)) return;
        const parsed = parseChatEvent(ev);
        if (!parsed) return;
        if (!knownAuthors.has(parsed.authorNpub)) return; // only accept known chat members
        void this.signer
          .decrypt(parsed.authorNpub, ev.content)
          .then((text) =>
            onMessage({ id: ev.id, chatId: parsed.chatId, authorNpub: parsed.authorNpub, text, createdAt: ev.created_at }),
          )
          .catch(() => {
            /* not decryptable by me — ignore */
          });
      },
    });
    return { close: () => sub.close() };
  }

  /** Best-effort relay connectivity check for a UI status indicator. */
  async ensureConnected(): Promise<boolean> {
    try {
      await this.pool.ensureRelay(this.relays[0]);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.pool.close(this.relays);
  }
}

/** Browser relay URL (NEXT_PUBLIC_ is inlined at build time). */
export function relayUrl(): string {
  return process.env.NEXT_PUBLIC_NOSTR_RELAY ?? "ws://127.0.0.1:7777";
}
