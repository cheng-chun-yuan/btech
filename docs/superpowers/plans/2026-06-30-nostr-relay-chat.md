# Nostr Relay Chat (Phase 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver all chat (DMs + channels) as real, E2E-encrypted, relay-delivered Nostr messages via one reusable client module, interoperable with `src/bin/relaychat.rs`.

**Architecture:** A browser `NostrChatClient` (over `nostr-tools` `SimplePool`) publishes kind-`23333` NIP-44 events (fan-out: one encrypted copy per member incl. self) tagged `["t",chatId]`/`["p",recipientHex]`/`["chat",scope]`, and subscribes by `#t` for backfill+live. The Phase-1 `NostrSigner` gains `signEvent`. `wallet.tsx` sends via the client and renders messages from the relay stream; the relay is the message transport (SQLite stays for identity/membership/vault/audit only).

**Tech Stack:** Next.js 16 / React 19, `nostr-tools@2.23.8` (`SimplePool`, `finalizeEvent`, `nip44`, `nip19`), Vitest (node), bun. Relay: `NEXT_PUBLIC_NOSTR_RELAY` (default `ws://127.0.0.1:7777`).

## Global Constraints

- Package manager **bun**. Single test: `bunx vitest run <path>`; all: `bun run test`; types: `bun run typecheck`.
- Tests co-located `*.test.ts`, node env, `import { describe, it, expect } from "vitest"`, no mocking lib.
- **Event format = `relaychat.rs` verbatim:** kind `23333`; content = NIP-44 **v2** ciphertext; tags `["t",<chatId>]`, `["p",<recipientPubkeyHex>]`, `["chat","dm"|"group"]`. Scope = `"dm"` for `chat.type==="direct"`, else `"group"`.
- **Fan-out includes self:** publish one encrypted copy per member **plus** one addressed to the sender, so the sender backfills its own history via the addressed-to-me path.
- All crypto/signing goes through `NostrSigner` (`encrypt`/`decrypt`/`signEvent`) — never raw keys — so the NIP-07 path (no exposed secret) works uniformly.
- `nostr-tools` API specifics (v2.23.8): `SimplePool.subscribeMany(relays: string[], filter: Filter, params)` takes a **single** `Filter` and returns a `SubCloser` (`{close()}`); `params.onevent(evt)`/`oneose()`. `pool.publish(relays, event)` returns **`Promise<string>[]`** (per-relay) — use `Promise.any`. `finalizeEvent(template, sk): VerifiedEvent`. `EventTemplate = { kind; tags; content; created_at }`. Tag filter = `{ kinds:[23333], "#t": chatIds }`.
- Browser uses the **native global `WebSocket`** (no polyfill). Do NOT unit-test the live pool in vitest (node lacks `WebSocket`); test pure helpers, and verify the pool via the bun integration harness in Task 8.
- Relay-native: new chat messages are NOT written to SQLite; `POST /api/messages` is no longer called for chat sends. Old SQLite/seed messages are disposable (may not appear) per the spec.
- Work on branch `feat/nostr-dm`. End every commit message with:
  ```
  Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb
  ```

Spec: `docs/superpowers/specs/2026-06-30-nostr-relay-chat-design.md`

---

## File Structure

**Create:**
- `app/ui/wallet/nostr-chat.ts` — pure helpers (`CHAT_KIND`, `scopeFor`, `fanoutRecipients`, `buildChatEventTemplate`, `isAddressedToMe`, `parseChatEvent`) + the `NostrChatClient` class.
- `app/ui/wallet/nostr-chat.test.ts` — unit tests for the pure helpers.
- `.superpowers/sdd/verify-relay-chat.ts` — bun integration harness (relaychat.rs-style).

**Modify:**
- `app/ui/wallet/nostr-signer.ts` — add `signEvent` to `NostrSigner` + both impls.
- `app/ui/wallet/nostr-signer.test.ts` — test `signEvent`.
- `app/api/chats/[id]/audit/route.ts` — add a `POST` audit-ping handler.
- `.env.example`, `.env.local` — add `NEXT_PUBLIC_NOSTR_RELAY`.
- `app/ui/wallet/wallet.tsx` — relay client lifecycle + subscribe + render-from-relay; publish-on-send + audit ping; remove the Phase-1 SQLite decrypt path.

---

## Task 1: `NostrSigner.signEvent`

**Files:**
- Modify: `app/ui/wallet/nostr-signer.ts`
- Test: `app/ui/wallet/nostr-signer.test.ts`

**Interfaces:**
- Produces: `NostrSigner.signEvent(template: EventTemplate): Promise<Event>` on the interface; `LocalKeySigner` (via `finalizeEvent`) and `Nip07Signer` (via `window.nostr.signEvent`) implement it.

- [ ] **Step 1: Write the failing test**

Append to `app/ui/wallet/nostr-signer.test.ts`:
```ts
import { verifyEvent, getPublicKey } from "nostr-tools";

describe("LocalKeySigner.signEvent", () => {
  it("produces a verifiable event whose pubkey matches the key", async () => {
    const sk = generateSecretKey();
    const signer = new LocalKeySigner(sk);
    const ev = await signer.signEvent({
      kind: 23333,
      created_at: 1700000000,
      tags: [["t", "chat1"], ["chat", "dm"]],
      content: "hello",
    });
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(ev.kind).toBe(23333);
  });
});
```
(`generateSecretKey`/`LocalKeySigner` are already imported at the top of this test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run app/ui/wallet/nostr-signer.test.ts`
Expected: FAIL — `signer.signEvent is not a function`.

- [ ] **Step 3: Implement**

In `app/ui/wallet/nostr-signer.ts`:

Add `finalizeEvent` to the top imports:
```ts
import { nip19, finalizeEvent } from "nostr-tools";
```
Add to the `NostrSigner` interface:
```ts
export interface NostrSigner {
  encrypt(counterpartyNpub: string, plaintext: string): Promise<string>;
  decrypt(counterpartyNpub: string, ciphertext: string): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
}
```
Add to `LocalKeySigner` (it already holds `secretKey`):
```ts
  async signEvent(template: EventTemplate): Promise<Event> {
    return finalizeEvent(template, this.secretKey);
  }
```
Add to `Nip07Signer`:
```ts
  async signEvent(template: EventTemplate): Promise<Event> {
    if (!window.nostr) throw new Error("No NIP-07 extension");
    return window.nostr.signEvent(template);
  }
```
(`Event`/`EventTemplate` are already imported; `Window.nostr.signEvent` is already declared.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run app/ui/wallet/nostr-signer.test.ts`
Expected: PASS (all prior tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add app/ui/wallet/nostr-signer.ts app/ui/wallet/nostr-signer.test.ts
git commit -m "feat(dm): NostrSigner.signEvent (finalizeEvent / NIP-07)

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 2: `nostr-chat.ts` pure helpers

**Files:**
- Create: `app/ui/wallet/nostr-chat.ts`
- Test: `app/ui/wallet/nostr-chat.test.ts`

**Interfaces:**
- Produces:
  - `CHAT_KIND = 23333`
  - `type ChatScope = "dm" | "group"`
  - `scopeFor(type: "channel" | "direct"): ChatScope`
  - `fanoutRecipients(memberNpubs: string[], meNpub: string): string[]`
  - `pubHexFromNpub(npub): string`, `npubFromHex(hex): string`
  - `buildChatEventTemplate(chatId, scope, recipientNpub, ciphertext, createdAt): EventTemplate`
  - `isAddressedToMe(ev: Event, meHex: string): boolean`
  - `parseChatEvent(ev: Event): { chatId: string; scope: string; authorNpub: string } | null`

- [ ] **Step 1: Write the failing test**

`app/ui/wallet/nostr-chat.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run app/ui/wallet/nostr-chat.test.ts`
Expected: FAIL — "Failed to resolve import './nostr-chat'".

- [ ] **Step 3: Implement the helpers**

`app/ui/wallet/nostr-chat.ts` (helpers section — the class is added in Task 3):
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run app/ui/wallet/nostr-chat.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add app/ui/wallet/nostr-chat.ts app/ui/wallet/nostr-chat.test.ts
git commit -m "feat(dm): nostr-chat pure helpers (relaychat.rs wire format)

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 3: `NostrChatClient` (SimplePool wrapper)

**Files:**
- Modify: `app/ui/wallet/nostr-chat.ts` (append the class)

**Interfaces:**
- Consumes: the Task-2 helpers; `NostrSigner` (Task 1, with `signEvent`).
- Produces:
  - `type DecryptedMessage = { id: string; chatId: string; authorNpub: string; text: string; createdAt: number }`
  - `class NostrChatClient` with:
    - `constructor(signer: NostrSigner, meNpub: string, relayUrl: string)`
    - `publish(chatId: string, scope: ChatScope, memberNpubs: string[], text: string): Promise<void>`
    - `subscribe(chatIds: string[], onMessage: (m: DecryptedMessage) => void): { close: () => void }`
    - `close(): void`

No vitest for the live pool (node lacks `WebSocket`); verified by typecheck + the Task-8 harness.

- [ ] **Step 1: Append the class to `app/ui/wallet/nostr-chat.ts`**

Add to the imports at the top:
```ts
import { SimplePool } from "nostr-tools";
import type { Filter } from "nostr-tools";
import type { NostrSigner } from "./nostr-signer";
```
Append:
```ts
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

  /** Fan-out: encrypt + sign + publish one kind-23333 event per recipient (incl self). */
  async publish(chatId: string, scope: ChatScope, memberNpubs: string[], text: string): Promise<void> {
    const createdAt = Math.floor(Date.now() / 1000);
    for (const recipient of fanoutRecipients(memberNpubs, this.meNpub)) {
      const ciphertext = await this.signer.encrypt(recipient, text);
      const ev = await this.signer.signEvent(
        buildChatEventTemplate(chatId, scope, recipient, ciphertext, createdAt),
      );
      // publish() returns one promise per relay; succeed if any relay accepts.
      await Promise.any(this.pool.publish(this.relays, ev)).catch(() => {
        throw new Error("relay rejected the message");
      });
    }
  }

  /** Subscribe to my chats: backfill + live. Calls onMessage for each decryptable
   * event addressed to me, deduped by event id. Returns a closer. */
  subscribe(chatIds: string[], onMessage: (m: DecryptedMessage) => void): { close: () => void } {
    const filter: Filter = { kinds: [CHAT_KIND], "#t": chatIds, limit: 500 };
    const sub = this.pool.subscribeMany(this.relays, filter, {
      onevent: (ev) => {
        if (this.seen.has(ev.id)) return;
        this.seen.add(ev.id);
        if (!isAddressedToMe(ev, this.meHex)) return;
        const parsed = parseChatEvent(ev);
        if (!parsed) return;
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

  close(): void {
    this.pool.close(this.relays);
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: clean. (The class uses the verified v2.23.8 signatures: `subscribeMany(relays, filter, params)` single filter; `publish` → `Promise<string>[]`.)

- [ ] **Step 3: Commit**

```bash
git add app/ui/wallet/nostr-chat.ts
git commit -m "feat(dm): NostrChatClient — relay publish/subscribe for dm + group

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 4: `NEXT_PUBLIC_NOSTR_RELAY` config

**Files:**
- Modify: `.env.example`, `.env.local`
- Modify: `app/ui/wallet/nostr-chat.ts` (add a `relayUrl()` reader)

**Interfaces:**
- Produces: `relayUrl(): string` in `nostr-chat.ts` — reads `process.env.NEXT_PUBLIC_NOSTR_RELAY`, default `ws://127.0.0.1:7777`.

- [ ] **Step 1: Add the env var to both files**

Append to `.env.example`:
```
# Nostr relay for E2E chat (browser connects directly). Same relay relaychat.rs uses.
NEXT_PUBLIC_NOSTR_RELAY=ws://127.0.0.1:7777
```
Append the same line to `.env.local`.

- [ ] **Step 2: Add the reader to `app/ui/wallet/nostr-chat.ts`**

Append:
```ts
/** Browser relay URL (NEXT_PUBLIC_ is inlined at build time). */
export function relayUrl(): string {
  return process.env.NEXT_PUBLIC_NOSTR_RELAY ?? "ws://127.0.0.1:7777";
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add .env.example .env.local app/ui/wallet/nostr-chat.ts
git commit -m "feat(dm): NEXT_PUBLIC_NOSTR_RELAY config + relayUrl() reader

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 5: Audit-ping endpoint (`POST /api/chats/[id]/audit`)

**Files:**
- Modify: `app/api/chats/[id]/audit/route.ts` (add a `POST` handler beside the existing `GET`)

**Interfaces:**
- Produces: `POST /api/chats/:id/audit` → records a metadata-only `"message"` audit entry (no content) for the authed member; `200 { ok: true }`, `401`, `403`.

- [ ] **Step 1: Add the POST handler**

In `app/api/chats/[id]/audit/route.ts`, add `recordAudit` to the audit import and append a `POST` export:
```ts
import { isMember, listAudit, recordAudit } from "../../../_lib/audit";
```
```ts
/** Metadata-only "sent a message" ping — the message body lives E2E on the relay,
 * so the server records only that activity occurred, never content. */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isMember(db, id, user.npub)) {
    return NextResponse.json({ error: "Restricted to members" }, { status: 403 });
  }
  recordAudit(db, {
    chatId: id,
    actorNpub: user.npub,
    actorLabel: user.label,
    action: "message",
    detail: "sent an encrypted message",
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "app/api/chats/[id]/audit/route.ts"
git commit -m "feat(dm): POST /api/chats/[id]/audit metadata-only message ping

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 6: `wallet.tsx` — relay client lifecycle + render from relay

**Files:**
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Consumes: `NostrChatClient`, `relayUrl`, `DecryptedMessage`, `scopeFor` (Tasks 2-4); existing `signer`, `me`, `chats`, `members` state.
- Produces: relay message state `relayMsgs: Record<string, DecryptedMessage[]>`, a connected `NostrChatClient` ref, and a render that shows relay messages for the active chat.

Locate by code landmark (line numbers drift): `const [members, setMembers]` (~163), the signer-resolve effect (~430), the message render `{chat.messages.map(` (~1420), the `<ChatDetail` call (~844), `function ChatDetail({` (~1331).

- [ ] **Step 1: Imports + state**

Add to the wallet imports:
```ts
import { NostrChatClient, relayUrl, scopeFor, type DecryptedMessage } from "./nostr-chat";
```
After the `const [members, setMembers] = ...` declaration, add:
```ts
  const [relayMsgs, setRelayMsgs] = useState<Record<string, DecryptedMessage[]>>({});
  const chatClientRef = useRef<NostrChatClient | null>(null);
```
(`useRef` is already imported.)

- [ ] **Step 2: Client lifecycle + subscription effect**

Add this effect after the signer-resolve effect. It (re)builds the client when the signer/me change and subscribes to all of the user's chats:
```ts
  useEffect(() => {
    if (!signer || !me || chats.length === 0) return;
    const client = new NostrChatClient(signer, me.npub, relayUrl());
    chatClientRef.current = client;
    const chatIds = chats.map((c) => c.id);
    const sub = client.subscribe(chatIds, (m) => {
      setRelayMsgs((prev) => {
        const list = prev[m.chatId] ?? [];
        if (list.some((x) => x.id === m.id)) return prev; // dedup
        return { ...prev, [m.chatId]: [...list, m].sort((a, b) => a.createdAt - b.createdAt) };
      });
    });
    return () => {
      sub.close();
      client.close();
      chatClientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer, me?.npub, chats.map((c) => c.id).join(",")]);
```

- [ ] **Step 3: Map relay messages to display rows and render them**

In `ChatDetail`, replace the `{chat.messages.map((m) => ( ... ))}` block so it renders **relay** messages for this chat (decrypted text is already in `m.text`; author identity comes from `members`/self). First add two props to `ChatDetail` — `relayMessages: DecryptedMessage[]` and `meNpub: string` — to its destructure and its prop type (alongside `members`, `plain`):
```ts
  relayMessages: DecryptedMessage[];
  meNpub: string;
```
Replace the message-map block with:
```tsx
            {relayMessages.map((m) => {
              const mem = members.find((x) => x.npub === m.authorNpub);
              const who = m.authorNpub === meNpub ? "You" : mem?.label ?? `${m.authorNpub.slice(0, 12)}…`;
              const initials = mem?.initials ?? (who === "You" ? "ME" : "??");
              const color = mem?.color ?? "#6FB1FF";
              return (
                <div key={m.id} style={{ display: "flex", gap: 12 }}>
                  <button
                    type="button"
                    onClick={() => onAuthorClick({ id: m.id, who, handle: "", initials, color, time: "", text: m.text, signed: false, zaps: "", authorNpub: m.authorNpub } as ChatMessage)}
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
                  >
                    <span style={{ width: 34, height: 34, borderRadius: 10, background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: C.bg, flex: "0 0 34px" }}>{initials}</span>
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{who}</span>
                    </div>
                    <div style={{ fontSize: 13, color: "#C5C9CE", lineHeight: 1.55, marginTop: 4 }}>{m.text}</div>
                  </div>
                </div>
              );
            })}
```

- [ ] **Step 4: Pass the new props at the `<ChatDetail .../>` call site**

Add to the `<ChatDetail ... />` invocation:
```tsx
              relayMessages={relayMsgs[active.id] ?? []}
              meNpub={me?.npub ?? ""}
```

- [ ] **Step 5: Verify types + suite**

Run: `bun run typecheck && bun run test`
Expected: tsc clean; suite still green (no test regressions — existing tests don't touch wallet.tsx).

- [ ] **Step 6: Commit**

```bash
git add app/ui/wallet/wallet.tsx
git commit -m "feat(dm): wallet relay client lifecycle + render messages from the relay

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 7: `wallet.tsx` — publish on send + audit ping; drop SQLite chat path

**Files:**
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Consumes: `chatClientRef` (Task 6), `members`, `scopeFor`, the audit ping endpoint (Task 5).
- Produces: `sendMsg` publishes via the relay client (no `POST /api/messages`); the Phase-1 decrypt effect and DM ciphertext-in-SQLite path are removed.

Locate by landmark: `const sendMsg = () => {` (~595) and the direct-chat decrypt effect (the `setPlain` effect, ~445).

- [ ] **Step 1: Replace `sendMsg` to publish over the relay**

Replace the whole `sendMsg` function with:
```tsx
  const sendMsg = () => {
    const text = draft.trim();
    if (!text || !activeChat) return;
    if (text.toLowerCase() === "/send") {
      setDraft("");
      setSendForm({ open: true, module: "Bitcoin regtest", dest: "", amount: "" });
      return;
    }
    const cid = activeChat;
    const chat = active;
    setDraft("");
    void (async () => {
      const client = chatClientRef.current;
      if (!client || !chat) {
        setStateError("Chat unavailable — the relay isn't connected yet");
        return;
      }
      const memberNpubs = members.map((m) => m.npub);
      try {
        await client.publish(cid, scopeFor(chat.type), memberNpubs, text);
      } catch (e) {
        setStateError(e instanceof Error ? e.message : "Message failed to send");
        return;
      }
      // Metadata-only audit ping (no content); best-effort.
      void fetch(`/api/chats/${cid}/audit`, { method: "POST" }).then(() => refreshAudit(cid));
      // The sender's own fan-out copy comes back via the relay subscription, so
      // no optimistic insert is needed — it appears when the relay echoes it.
    })();
  };
```

- [ ] **Step 2: Remove the Phase-1 SQLite decrypt effect**

Delete the entire direct-chat decrypt effect (the `useEffect` that builds the `plain` map by decrypting `active.messages`, ~lines 445-465). Messages now come from the relay subscription (Task 6), not SQLite. Also remove the now-unused `plain` state declaration and the `plain={plain}` prop + `plain` param/type in `ChatDetail` if nothing else references them (grep `plain` first; if the render block from Task 6 replaced its only use, remove it).

- [ ] **Step 3: Verify types + suite**

Run: `bun run typecheck && bun run test`
Expected: tsc clean (no dangling `plain` references); suite green.

- [ ] **Step 4: Commit**

```bash
git add app/ui/wallet/wallet.tsx
git commit -m "feat(dm): send over the relay + audit ping; drop SQLite chat path

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 8: Integration harness (relaychat.rs-style verification)

**Files:**
- Create: `.superpowers/sdd/verify-relay-chat.ts`

**Interfaces:**
- Consumes: `nostr-tools` directly (bun runtime has a global `WebSocket`); the same wire format as `nostr-chat.ts`.
- Produces: a runnable check that a group message reaches all members and a DM stays private over a real relay.

This is the end-to-end verification (no vitest — needs a live relay; bun supplies `WebSocket`).

- [ ] **Step 1: Write the harness**

`.superpowers/sdd/verify-relay-chat.ts`:
```ts
// Relay chat verification (run with: NEXT_PUBLIC_NOSTR_RELAY=ws://127.0.0.1:7777 bun .superpowers/sdd/verify-relay-chat.ts)
// Requires a running Nostr relay. Mirrors relaychat.rs: group reaches all, dm stays private.
import { SimplePool, generateSecretKey, getPublicKey, nip19, finalizeEvent, type Event } from "nostr-tools";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";

const RELAY = process.env.NEXT_PUBLIC_NOSTR_RELAY ?? "ws://127.0.0.1:7777";
const KIND = 23333;
const CHAT = `verify-${Math.floor(Date.now())}`; // unique topic per run

type P = { sk: Uint8Array; hex: string; npub: string };
const mk = (): P => { const sk = generateSecretKey(); const hex = getPublicKey(sk); return { sk, hex, npub: nip19.npubEncode(hex) }; };

function publish(pool: SimplePool, sender: P, recipient: P, scope: string, text: string) {
  const ck = getConversationKey(sender.sk, recipient.hex);
  const ev = finalizeEvent(
    { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["t", CHAT], ["p", recipient.hex], ["chat", scope]], content: encrypt(text, ck) },
    sender.sk,
  );
  return Promise.any(pool.publish([RELAY], ev));
}

async function main() {
  const pool = new SimplePool();
  const [alice, bob, carol] = [mk(), mk(), mk()];
  const inbox: Record<string, { from: string; scope: string; text: string }[]> = { alice: [], bob: [], carol: [] };
  const byHex: Record<string, P & { name: string }> = {
    [alice.hex]: { ...alice, name: "alice" }, [bob.hex]: { ...bob, name: "bob" }, [carol.hex]: { ...carol, name: "carol" },
  };

  const sub = pool.subscribeMany([RELAY], { kinds: [KIND], "#t": [CHAT] }, {
    onevent: (ev: Event) => {
      const me = [alice, bob, carol].find((p) => ev.tags.some((t) => t[0] === "p" && t[1] === p.hex));
      if (!me) return;
      const author = byHex[ev.pubkey];
      try {
        const text = decrypt(ev.content, getConversationKey(me.sk, ev.pubkey));
        const scope = ev.tags.find((t) => t[0] === "chat")?.[1] ?? "?";
        inbox[byHex[me.hex].name].push({ from: author?.name ?? "?", scope, text });
      } catch { /* not for me */ }
    },
  });

  await new Promise((r) => setTimeout(r, 500));
  // GROUP from alice → bob + carol (fan-out)
  await Promise.all([publish(pool, alice, bob, "group", "gm team"), publish(pool, alice, carol, "group", "gm team")]);
  // DM alice → bob only
  await publish(pool, alice, bob, "dm", "psst bob");
  await new Promise((r) => setTimeout(r, 2000));
  sub.close(); pool.close([RELAY]);

  const groupAll = inbox.bob.some((m) => m.scope === "group" && m.from === "alice") && inbox.carol.some((m) => m.scope === "group" && m.from === "alice");
  const dmPrivate = inbox.bob.some((m) => m.scope === "dm") && !inbox.carol.some((m) => m.scope === "dm");
  console.log("group reached all members:", groupAll);
  console.log("dm stayed private (carol excluded):", dmPrivate);
  console.log(groupAll && dmPrivate ? "✅ RELAY CHAT VERIFIED" : "❌ FAILED");
  process.exit(groupAll && dmPrivate ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
```

- [ ] **Step 2: Run it (requires a relay)**

Start the relay (`docker compose -f ../dkgkit/examples/self-hosted-relay/docker-compose.yml up -d`), then:
Run: `NEXT_PUBLIC_NOSTR_RELAY=ws://127.0.0.1:7777 bun .superpowers/sdd/verify-relay-chat.ts`
Expected: `group reached all members: true`, `dm stayed private (carol excluded): true`, `✅ RELAY CHAT VERIFIED`.
If no relay is available in this environment, record that the harness is written and runnable but unrun (the unit tests + typecheck are the automated gate).

- [ ] **Step 3: Commit**

```bash
git add .superpowers/sdd/verify-relay-chat.ts
git commit -m "test(dm): relay-chat integration harness (group reaches all, dm private)

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- §1 reusable module → Task 2 (helpers) + Task 3 (`NostrChatClient`, both scopes).
- §2 publish/subscribe (fan-out incl self, dedup, addressed-to-me, known decrypt) → Task 3.
- §3 signer `signEvent` → Task 1.
- §4 event format verbatim relaychat.rs → Task 2 `buildChatEventTemplate` (test asserts tags/kind/content) + Task 8 harness uses identical format.
- §5 membership/keys → Task 6 uses `members` for fan-out + display.
- §6 wallet wiring (send→publish, history→subscribe, render) → Tasks 6 & 7.
- §7 relay config `NEXT_PUBLIC_NOSTR_RELAY` → Task 4.
- Consequence 1 (metadata-only audit) → Task 5 endpoint + Task 7 ping.
- Consequence 2 (drop Phase-1 SQLite chat path) → Task 7 removes decrypt effect + `/api/messages` send.
- Consequence 3 (relay dependency, no fallback) → Task 6/7 surface `setStateError` when the client/relay isn't ready.
- §Testing → Task 2 unit (wire format, addressed-to, parse, fanout), Task 8 integration harness (group-all + dm-private).

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `DecryptedMessage` defined in Task 3, consumed in Task 6 (`relayMsgs`, `relayMessages` prop). `NostrChatClient`/`relayUrl`/`scopeFor` defined Tasks 2-4, used Tasks 6-7. `signEvent` defined Task 1, used by `NostrChatClient.publish` Task 3.

**Known limitations (documented):**
- Inbound relay messages are accepted on `addressed-to-me + my-chatId + decryptable`, without a strict per-chat membership directory gate (relaychat.rs checks a directory). Acceptable for Phase-2 MVP; tighten later by gating authors against each chat's roster.
- Old SQLite/seed channel + Phase-1 DM messages won't render (relay is the source of truth); disposable per the spec.
- Task 8's harness needs a running relay; if unavailable in the execution environment, it's written-but-unrun and the unit tests + typecheck are the automated gate.
