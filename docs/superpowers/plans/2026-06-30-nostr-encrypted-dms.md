# Click-to-DM: NIP-44 Encrypted Direct Messages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click a message author or channel-roster row → profile popover → "Direct message" → a 1:1 chat whose content is NIP-44 encrypted client-side; the server only ever stores/sees ciphertext.

**Architecture:** Thin Next.js route handlers over a fully unit-tested `app/api/_lib/dm.ts`. DMs reuse the existing `chats`/`messages`/`chat_members` tables with **no schema change** — a NIP-44 v2 payload is one base64 string stored in `messages.text`, and "is this encrypted?" is derived from `chat.type === "direct"`. All crypto is client-side via `nostr-tools/nip44` (the server can't hold NIP-07 keys). Phase 2 (live Nostr relay delivery) is a separate future plan.

**Tech Stack:** Next.js 16 (app router), `better-sqlite3`, `nostr-tools@2.23.8` (NIP-44 at subpath `nostr-tools/nip44`), Vitest (node env), bun.

Spec: `docs/superpowers/specs/2026-06-30-click-to-dm-nostr-encrypted-design.md`

## Global Constraints

- Package manager is **bun** (`bun@1.3.11`). Run a single test file with `bunx vitest run <path>`; all tests with `bun run test`; types with `bun run typecheck`.
- Tests are **co-located** as `<module>.test.ts`, node environment, no mocking lib. Use `import { describe, it, expect } from "vitest"` and drive logic via `openTestDb()` from `./db` (in-memory; do NOT use `getDb()` in tests — it's a file-backed singleton).
- NIP-44 lives at the subpath: `import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44"`. There is **no** separate `nip44` package.
- **No DB schema change.** Do not bump `SCHEMA_VERSION`. Ciphertext goes in `messages.text`; encryption is gated on `chat.type === "direct"`.
- Encryption is **content-only** and **client-side only**. The server performs no crypto.
- Next.js 16 dynamic-route signature: `(_req: Request, context: { params: Promise<{ id: string }> })`, then `const { id } = await context.params;`.
- Server current-user pattern: `const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value); if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`
- Initials idiom (used verbatim across the codebase): `label.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()`.
- Work on a dedicated branch `feat/nostr-dm` (do NOT commit onto the current `feat/subledger-internal-transfer` branch).
- Every commit message ends with the trailer:
  ```
  Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb
  ```

---

## File Structure

**Create:**
- `app/api/_lib/avatar.ts` — `initialsFor(label)`, `colorForNpub(npub)` (deterministic avatar helpers).
- `app/api/_lib/avatar.test.ts`
- `app/api/_lib/dm.ts` — all DM data logic: `isChatMember`, `resolveIdentity`, `listChatMembers`, `findDirectChat`, `directCounterparty`, `createOrFindDirectChat`.
- `app/api/_lib/dm.test.ts`
- `app/api/dms/route.ts` — `POST /api/dms` (find-or-create).
- `app/api/chats/[id]/members/route.ts` — `GET` channel/DM roster.
- `app/ui/wallet/nostr-signer.ts` — client crypto: `NostrSigner` interface, `LocalKeySigner`, `Nip07Signer`, `personaSecret`, `resolveSigner`, stash helpers, `Window.nostr` augmentation.
- `app/ui/wallet/nostr-signer.test.ts`
- `app/ui/wallet/profile-popover.tsx` — `ProfilePopover` component.

**Modify:**
- `app/ui/wallet/types.ts` — add `ChatMessage.authorNpub?`, `Chat.counterpartyNpub?`.
- `app/api/chats/route.ts` — GET: select `author_npub`, filter DMs by membership, personalize DM name/avatar + set `counterpartyNpub`.
- `app/ui/login/login-form.tsx` — stash nsec secret for the session; remove the local `Window.nostr` declaration (now centralized in `nostr-signer.ts`).
- `app/ui/wallet/wallet.tsx` — resolve a signer; make message authors clickable; render a member roster; encrypt-on-send and decrypt-on-view for DMs.

---

## Task 1: Avatar helpers (`avatar.ts`)

**Files:**
- Create: `app/api/_lib/avatar.ts`
- Test: `app/api/_lib/avatar.test.ts`

**Interfaces:**
- Produces: `initialsFor(label: string): string`, `colorForNpub(npub: string): string`

- [ ] **Step 1: Write the failing test**

`app/api/_lib/avatar.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run app/api/_lib/avatar.test.ts`
Expected: FAIL — "Failed to resolve import './avatar'".

- [ ] **Step 3: Write minimal implementation**

`app/api/_lib/avatar.ts`:
```ts
/** First letter of the first two words, uppercased. Mirrors the inline idiom
 * used in messages/route.ts, chats/route.ts and data.ts. */
export function initialsFor(label: string): string {
  return label
    .split(" ")
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

const PALETTE = ["#6FB1FF", "#C99A5B", "#5FD08A", "#F7931A", "#B98AFF", "#FF8A8A", "#5FD0C8"];

/** Deterministic avatar color from an npub. Stable across server + UI. */
export function colorForNpub(npub: string): string {
  let h = 0;
  for (let i = 0; i < npub.length; i++) h = (h * 31 + npub.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run app/api/_lib/avatar.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add app/api/_lib/avatar.ts app/api/_lib/avatar.test.ts
git commit -m "feat(dm): deterministic avatar helpers (initials + npub color)

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 2: DM data logic (`dm.ts`)

**Files:**
- Create: `app/api/_lib/dm.ts`
- Test: `app/api/_lib/dm.test.ts`

**Interfaces:**
- Consumes: `DB` (from `./db`), `addMember`/`recordAudit` (from `./audit`), `initialsFor`/`colorForNpub` (from `./avatar`).
- Produces:
  - `type Member = { npub: string; label: string; role: string; initials: string; color: string }`
  - `isChatMember(db, chatId, npub): boolean` — strict `chat_members`-only check (NOT the signer-wildcard `isMember`).
  - `resolveIdentity(db, npub): { label: string; role: string }`
  - `listChatMembers(db, chatId): Member[]`
  - `findDirectChat(db, a, b): string | null`
  - `directCounterparty(db, chatId, meNpub): string | null`
  - `createOrFindDirectChat(db, me: { npub, label }, targetNpub): { id: string; created: boolean }`

Note: `audit.ts`'s existing `isMember` returns `true` for ANY chat if the npub is a signer anywhere — unsafe for DM privacy. This task adds the strict `isChatMember` used for DM visibility.

- [ ] **Step 1: Write the failing test**

`app/api/_lib/dm.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import { syncSigners } from "./identity";
import {
  isChatMember,
  resolveIdentity,
  listChatMembers,
  findDirectChat,
  directCounterparty,
  createOrFindDirectChat,
} from "./dm";

function npubsFor(db: ReturnType<typeof openTestDb>) {
  syncSigners(db, [
    { participant_id: 1, label: "Maya Ksiazek", role: "CEO" },
    { participant_id: 2, label: "Ravi Bose", role: "CFO" },
  ]);
  const rows = db.prepare("SELECT npub, label FROM signers ORDER BY participant_id").all() as
    { npub: string; label: string }[];
  return { maya: rows[0], ravi: rows[1] };
}

describe("dm", () => {
  it("resolveIdentity prefers users/signers, falls back to truncated npub", () => {
    const db = openTestDb();
    const { maya } = npubsFor(db);
    expect(resolveIdentity(db, maya.npub).label).toBe("Maya Ksiazek");
    const unknown = resolveIdentity(db, "npub1unknownunknownunknown");
    expect(unknown.label).toBe("npub1unknow…");
    expect(unknown.role).toBe("Observer");
  });

  it("createOrFindDirectChat creates a 2-member direct chat, then is idempotent", () => {
    const db = openTestDb();
    const { maya, ravi } = npubsFor(db);
    const first = createOrFindDirectChat(db, { npub: maya.npub, label: maya.label }, ravi.npub);
    expect(first.created).toBe(true);
    const again = createOrFindDirectChat(db, { npub: ravi.npub, label: ravi.label }, maya.npub);
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id); // unordered-pair idempotent

    const chat = db.prepare("SELECT type FROM chats WHERE id = ?").get(first.id) as { type: string };
    expect(chat.type).toBe("direct");
    expect(isChatMember(db, first.id, maya.npub)).toBe(true);
    expect(isChatMember(db, first.id, ravi.npub)).toBe(true);
    expect(isChatMember(db, first.id, "npub1stranger")).toBe(false);
  });

  it("findDirectChat / directCounterparty resolve the pair", () => {
    const db = openTestDb();
    const { maya, ravi } = npubsFor(db);
    const { id } = createOrFindDirectChat(db, { npub: maya.npub, label: maya.label }, ravi.npub);
    expect(findDirectChat(db, maya.npub, ravi.npub)).toBe(id);
    expect(findDirectChat(db, maya.npub, "npub1nobody")).toBeNull();
    expect(directCounterparty(db, id, maya.npub)).toBe(ravi.npub);
    expect(directCounterparty(db, id, ravi.npub)).toBe(maya.npub);
  });

  it("listChatMembers returns resolved identities with initials + color", () => {
    const db = openTestDb();
    const { maya, ravi } = npubsFor(db);
    const { id } = createOrFindDirectChat(db, { npub: maya.npub, label: maya.label }, ravi.npub);
    const members = listChatMembers(db, id);
    expect(members.map((m) => m.label).sort()).toEqual(["Maya Ksiazek", "Ravi Bose"]);
    const m = members.find((x) => x.label === "Maya Ksiazek")!;
    expect(m.initials).toBe("MK");
    expect(m.color).toMatch(/^#[0-9A-F]{6}$/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run app/api/_lib/dm.test.ts`
Expected: FAIL — "Failed to resolve import './dm'".

- [ ] **Step 3: Write minimal implementation**

`app/api/_lib/dm.ts`:
```ts
import { randomBytes } from "node:crypto";

import type { DB } from "./db";
import { addMember, recordAudit } from "./audit";
import { initialsFor, colorForNpub } from "./avatar";

export type Member = {
  npub: string;
  label: string;
  role: string;
  initials: string;
  color: string;
};

/** Strict membership: only `chat_members` (unlike audit.isMember, which treats
 * any signer as a member of every chat). Used for DM privacy gates. */
export function isChatMember(db: DB, chatId: string, npub: string): boolean {
  return !!db.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND npub = ?").get(chatId, npub);
}

export function resolveIdentity(db: DB, npub: string): { label: string; role: string } {
  const u = db.prepare("SELECT label, role FROM users WHERE npub = ?").get(npub) as
    | { label: string; role: string }
    | undefined;
  if (u) return u;
  const s = db.prepare("SELECT label, role FROM signers WHERE npub = ? LIMIT 1").get(npub) as
    | { label: string; role: string }
    | undefined;
  if (s) return s;
  return { label: `${npub.slice(0, 12)}…`, role: "Observer" };
}

export function listChatMembers(db: DB, chatId: string): Member[] {
  const rows = db.prepare("SELECT npub FROM chat_members WHERE chat_id = ?").all(chatId) as
    { npub: string }[];
  return rows.map(({ npub }) => {
    const { label, role } = resolveIdentity(db, npub);
    return { npub, label, role, initials: initialsFor(label), color: colorForNpub(npub) };
  });
}

/** Existing direct chat whose membership is exactly {a, b}, else null. */
export function findDirectChat(db: DB, a: string, b: string): string | null {
  const row = db
    .prepare(`
      SELECT c.id AS id FROM chats c
      WHERE c.type = 'direct'
        AND (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id) = 2
        AND EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.npub = ?)
        AND EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.npub = ?)
      LIMIT 1
    `)
    .get(a, b) as { id: string } | undefined;
  return row?.id ?? null;
}

export function directCounterparty(db: DB, chatId: string, meNpub: string): string | null {
  const row = db
    .prepare("SELECT npub FROM chat_members WHERE chat_id = ? AND npub != ? LIMIT 1")
    .get(chatId, meNpub) as { npub: string } | undefined;
  return row?.npub ?? null;
}

export function createOrFindDirectChat(
  db: DB,
  me: { npub: string; label: string },
  targetNpub: string,
): { id: string; created: boolean } {
  const existing = findDirectChat(db, me.npub, targetNpub);
  if (existing) return { id: existing, created: false };

  const id = `dm_${randomBytes(5).toString("hex")}`;
  const { label: targetLabel } = resolveIdentity(db, targetNpub);
  const meta = {
    id,
    type: "direct",
    name: targetLabel,
    members: 2,
    balanceBtc: "0.00",
    balanceUsd: "0",
    initials: initialsFor(targetLabel),
    color: colorForNpub(targetNpub),
    tiers: [],
  };
  db.prepare("INSERT INTO chats (id, type, name, data_json) VALUES (?, ?, ?, ?)").run(
    id,
    "direct",
    targetLabel,
    JSON.stringify(meta),
  );
  addMember(db, id, me.npub);
  addMember(db, id, targetNpub);
  recordAudit(db, {
    chatId: id,
    actorNpub: me.npub,
    actorLabel: me.label,
    action: "join",
    detail: `Opened DM with ${targetLabel}`,
  });
  return { id, created: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run app/api/_lib/dm.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add app/api/_lib/dm.ts app/api/_lib/dm.test.ts
git commit -m "feat(dm): find-or-create direct chats + strict membership + roster (dm.ts)

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 3: `POST /api/dms` route

**Files:**
- Create: `app/api/dms/route.ts`

**Interfaces:**
- Consumes: `createOrFindDirectChat` (Task 2), `isValidNpub` (from `_lib/identity`), `getSessionUser`/`SESSION_COOKIE` (from `_lib/auth`), `Chat`/`ChatMessage` types.
- Produces: `POST /api/dms` with body `{ targetNpub }` → `200 { chat: Chat }` (chat from the caller's perspective, `counterpartyNpub` = `targetNpub`), or `400`/`401`.

This route is a thin wrapper; its logic is already covered by Task 2's tests. Verification is typecheck + manual.

- [ ] **Step 1: Write the route**

`app/api/dms/route.ts`:
```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../_lib/auth";
import { createOrFindDirectChat } from "../_lib/dm";
import { isValidNpub } from "../_lib/identity";
import type { Chat, ChatMessage } from "../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Find or create a 1:1 direct chat with `targetNpub`. */
export async function POST(request: Request) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { targetNpub } = (await request.json().catch(() => ({}))) as { targetNpub?: string };
  if (!targetNpub || !isValidNpub(targetNpub)) {
    return NextResponse.json({ error: "valid targetNpub required" }, { status: 400 });
  }
  if (targetNpub === user.npub) {
    return NextResponse.json({ error: "cannot DM yourself" }, { status: 400 });
  }

  const { id } = createOrFindDirectChat(db, user, targetNpub);

  const row = db.prepare("SELECT data_json FROM chats WHERE id = ?").get(id) as { data_json: string };
  const meta = JSON.parse(row.data_json) as Omit<Chat, "messages">;
  const msgs = db
    .prepare(
      "SELECT id, who, handle, initials, color, time, text, signed, zaps, author_npub AS authorNpub FROM messages WHERE chat_id = ? ORDER BY created_at",
    )
    .all(id) as Record<string, unknown>[];
  const messages = msgs.map((m) => ({ ...m, signed: !!m.signed })) as unknown as ChatMessage[];
  const chat: Chat = { ...meta, counterpartyNpub: targetNpub, messages };

  return NextResponse.json({ chat });
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: no errors. (Depends on Task 5's type additions — `counterpartyNpub` and `authorNpub`. Do Task 5 first if typecheck flags these, or run typecheck after Task 5.)

- [ ] **Step 3: Commit**

```bash
git add app/api/dms/route.ts
git commit -m "feat(dm): POST /api/dms find-or-create direct chat

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 4: `GET /api/chats/[id]/members` route

**Files:**
- Create: `app/api/chats/[id]/members/route.ts`

**Interfaces:**
- Consumes: `listChatMembers` (Task 2), `isMember` (from `_lib/audit`), session helpers.
- Produces: `GET /api/chats/:id/members` → `200 { members: Member[] }` (member-gated), `401`, or `403`.

Mirrors the existing `app/api/chats/[id]/audit/route.ts` exactly. Gated with the existing `isMember` (channels are the primary use; DM membership is also covered since both DM participants are in `chat_members`).

- [ ] **Step 1: Write the route**

`app/api/chats/[id]/members/route.ts`:
```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { isMember } from "../../../_lib/audit";
import { listChatMembers } from "../../../_lib/dm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isMember(db, id, user.npub)) {
    return NextResponse.json({ error: "Restricted to members" }, { status: 403 });
  }
  return NextResponse.json({ members: listChatMembers(db, id) });
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/chats/[id]/members/route.ts
git commit -m "feat(dm): GET /api/chats/[id]/members roster endpoint

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 5: Types + personalize `GET /api/chats` for DMs

**Files:**
- Modify: `app/ui/wallet/types.ts`
- Modify: `app/api/chats/route.ts:14-54` (the `GET` handler)

**Interfaces:**
- Produces: `ChatMessage.authorNpub?: string`; `Chat.counterpartyNpub?: string`. `GET /api/chats` now (a) selects `author_npub` as `authorNpub`, (b) hides direct chats the caller is not a member of, (c) sets each visible DM's `counterpartyNpub`, `name`, `initials`, `color` from the *viewer's* counterparty.

- [ ] **Step 1: Add the type fields**

In `app/ui/wallet/types.ts`, extend `ChatMessage` (currently lines 24-34) — add the `authorNpub` field:
```ts
export type ChatMessage = {
  id: string;
  who: string;
  handle: string;
  initials: string;
  color: string;
  time: string;
  text: string;
  signed: boolean;
  zaps: string;
  /** Nostr pubkey (npub) of the author. Present once plumbed from the server;
   * used to open a DM with the sender. */
  authorNpub?: string;
};
```

In the same file, extend `Chat` (currently lines 38-67) — add `counterpartyNpub` near `receiveAddress`:
```ts
  /** For a `direct` chat: the other participant's npub (the member that is not
   * the current viewer). Used to derive the NIP-44 conversation key. */
  counterpartyNpub?: string;
```

- [ ] **Step 2: Update the `GET` handler in `app/api/chats/route.ts`**

Add imports at the top (the file already imports `cookies`, `getSessionUser`, `SESSION_COOKIE`):
```ts
import { isChatMember, directCounterparty, resolveIdentity } from "../_lib/dm";
import { initialsFor, colorForNpub } from "../_lib/avatar";
```

Replace the message SELECT (line 19) to include `author_npub`:
```ts
  const msgStmt = db.prepare(
    "SELECT id, who, handle, initials, color, time, text, signed, zaps, author_npub AS authorNpub FROM messages WHERE chat_id = ? ORDER BY created_at",
  );
```

Then, at the end of `GET` (just before `return NextResponse.json({ chats });`), resolve the session user, filter DMs, and personalize them. Replace the final `return NextResponse.json({ chats });` with:
```ts
  // Resolve the viewer so we can hide DMs they're not in and label each DM with
  // the *other* participant (the stored name is from the creator's POV).
  const viewer = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  const visible = chats.filter(
    (c) => c.type !== "direct" || (viewer != null && isChatMember(db, c.id, viewer.npub)),
  );
  if (viewer) {
    for (const c of visible) {
      if (c.type !== "direct") continue;
      const other = directCounterparty(db, c.id, viewer.npub);
      if (!other) continue;
      const { label } = resolveIdentity(db, other);
      c.counterpartyNpub = other;
      c.name = label;
      c.initials = initialsFor(label);
      c.color = colorForNpub(other);
    }
  }

  return NextResponse.json({ chats: visible });
```

Note: the existing vault-provisioning block (lines 33-52) only touches `type === "channel"` chats and persists their `data_json`; the DM personalization above is response-only and does not write back, so the stored DM metadata stays generic and each viewer sees their own counterparty.

- [ ] **Step 3: Verify the full suite + types still pass**

Run: `bun run test && bun run typecheck`
Expected: all existing tests PASS; no type errors. (No new test here — the personalization logic is `dm.ts` functions already covered by Task 2; this step wires them in.)

- [ ] **Step 4: Commit**

```bash
git add app/ui/wallet/types.ts app/api/chats/route.ts
git commit -m "feat(dm): plumb authorNpub + per-viewer DM labels/counterparty into GET /api/chats

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 6: Client crypto — `nostr-signer.ts`

**Files:**
- Create: `app/ui/wallet/nostr-signer.ts`
- Test: `app/ui/wallet/nostr-signer.test.ts`

**Interfaces:**
- Produces:
  - `interface NostrSigner { encrypt(counterpartyNpub, plaintext): Promise<string>; decrypt(counterpartyNpub, ciphertext): Promise<string> }`
  - `class LocalKeySigner implements NostrSigner` (ctor: `(secretKey: Uint8Array)`)
  - `class Nip07Signer implements NostrSigner`
  - `personaSecret(participantId: number): Promise<Uint8Array>`
  - `resolveSigner(me: { npub: string; participant_id: number | null }): Promise<NostrSigner | null>`
  - `stashSecretKey(sk: Uint8Array): void`, `clearStashedKey(): void`
  - Global augmentation of `Window["nostr"]` to add optional `nip44`.

- [ ] **Step 1: Write the failing test**

`app/ui/wallet/nostr-signer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { LocalKeySigner, personaSecret } from "./nostr-signer";

describe("LocalKeySigner", () => {
  it("round-trips a NIP-44 message between two parties", async () => {
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const npubA = nip19.npubEncode(getPublicKey(skA));
    const npubB = nip19.npubEncode(getPublicKey(skB));
    const alice = new LocalKeySigner(skA);
    const bob = new LocalKeySigner(skB);

    const ct = await alice.encrypt(npubB, "hello bob");
    expect(ct).not.toContain("hello bob"); // ciphertext, not plaintext
    expect(await bob.decrypt(npubA, ct)).toBe("hello bob"); // symmetric conversation key
  });

  it("rejects a non-npub counterparty", async () => {
    const alice = new LocalKeySigner(generateSecretKey());
    await expect(alice.encrypt("not-an-npub", "x")).rejects.toThrow();
  });
});

describe("personaSecret", () => {
  it("is deterministic and 32 bytes (mirrors the server derivation)", async () => {
    const a = await personaSecret(1);
    const b = await personaSecret(1);
    expect(a.length).toBe(32);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    expect(Buffer.from(await personaSecret(2)).toString("hex")).not.toBe(
      Buffer.from(a).toString("hex"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run app/ui/wallet/nostr-signer.test.ts`
Expected: FAIL — "Failed to resolve import './nostr-signer'".

- [ ] **Step 3: Write minimal implementation**

`app/ui/wallet/nostr-signer.ts`:
```ts
import { nip19 } from "nostr-tools";
import type { Event, EventTemplate } from "nostr-tools";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: EventTemplate): Promise<Event>;
      nip44?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>;
        decrypt(pubkey: string, ciphertext: string): Promise<string>;
      };
    };
  }
}

export interface NostrSigner {
  encrypt(counterpartyNpub: string, plaintext: string): Promise<string>;
  decrypt(counterpartyNpub: string, ciphertext: string): Promise<string>;
}

function pubHexFromNpub(npub: string): string {
  const d = nip19.decode(npub);
  if (d.type !== "npub" || typeof d.data !== "string") throw new Error("not an npub");
  return d.data;
}

/** Encrypt/decrypt with a locally-held secret key (demo persona or nsec). */
export class LocalKeySigner implements NostrSigner {
  constructor(private readonly secretKey: Uint8Array) {}
  private convKey(counterpartyNpub: string): Uint8Array {
    return getConversationKey(this.secretKey, pubHexFromNpub(counterpartyNpub));
  }
  async encrypt(counterpartyNpub: string, plaintext: string): Promise<string> {
    return encrypt(plaintext, this.convKey(counterpartyNpub));
  }
  async decrypt(counterpartyNpub: string, ciphertext: string): Promise<string> {
    return decrypt(ciphertext, this.convKey(counterpartyNpub));
  }
}

/** Encrypt/decrypt via a NIP-07 browser extension that supports nip44. */
export class Nip07Signer implements NostrSigner {
  async encrypt(counterpartyNpub: string, plaintext: string): Promise<string> {
    if (!window.nostr?.nip44) throw new Error("NIP-07 extension lacks nip44 support");
    return window.nostr.nip44.encrypt(pubHexFromNpub(counterpartyNpub), plaintext);
  }
  async decrypt(counterpartyNpub: string, ciphertext: string): Promise<string> {
    if (!window.nostr?.nip44) throw new Error("NIP-07 extension lacks nip44 support");
    return window.nostr.nip44.decrypt(pubHexFromNpub(counterpartyNpub), ciphertext);
  }
}

/** Deterministic demo-persona secret. Mirrors the server's `deterministicSecret`
 * and login-form's `personaSecret`. */
export async function personaSecret(participantId: number): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`btech-signer-v1:${participantId}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

const SK_KEY = "btech_dm_sk";

function toHex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Stash an nsec secret for the browser session (cleared on logout / tab close).
 * Demo-only: sessionStorage is XSS-readable; acceptable for this app. */
export function stashSecretKey(sk: Uint8Array): void {
  try {
    sessionStorage.setItem(SK_KEY, toHex(sk));
  } catch {
    /* storage unavailable — DM will fall back to NIP-07 or be disabled */
  }
}
export function clearStashedKey(): void {
  try {
    sessionStorage.removeItem(SK_KEY);
  } catch {
    /* ignore */
  }
}
function readStashedKey(): Uint8Array | null {
  try {
    const hex = sessionStorage.getItem(SK_KEY);
    return hex ? fromHex(hex) : null;
  } catch {
    return null;
  }
}

/** Pick the best available signer for the logged-in user, or null if none
 * (e.g. nsec login with no stash and no nip44-capable extension). */
export async function resolveSigner(
  me: { npub: string; participant_id: number | null },
): Promise<NostrSigner | null> {
  if (me.participant_id != null) return new LocalKeySigner(await personaSecret(me.participant_id));
  const stashed = readStashedKey();
  if (stashed) return new LocalKeySigner(stashed);
  if (typeof window !== "undefined" && window.nostr?.nip44) return new Nip07Signer();
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run app/ui/wallet/nostr-signer.test.ts`
Expected: PASS (3 passed). If `getConversationKey` errors on argument order, the round-trip test will fail loudly — confirm the installed signature with `bunx vitest run` output and adjust (the v2 signature is `getConversationKey(privkey: Uint8Array, pubkeyHex: string)`).

- [ ] **Step 5: Commit**

```bash
git add app/ui/wallet/nostr-signer.ts app/ui/wallet/nostr-signer.test.ts
git commit -m "feat(dm): client NIP-44 signer (persona/nsec/NIP-07) with conversation-key crypto

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 7: Stash nsec at login; centralize the `Window.nostr` type

**Files:**
- Modify: `app/ui/login/login-form.tsx`

**Interfaces:**
- Consumes: `stashSecretKey` (Task 6).
- Removes the local `declare global { Window.nostr }` block (lines 35-42) — now centralized in `nostr-signer.ts` (with `nip44`). Two conflicting declarations would be a type error, so the local one must go.

- [ ] **Step 1: Add the import**

At the top of `app/ui/login/login-form.tsx`, after the existing `nostr-tools` import (line 4-5), add:
```ts
import { stashSecretKey } from "../wallet/nostr-signer";
```

- [ ] **Step 2: Remove the duplicate global declaration**

Delete the block at lines 35-42:
```ts
declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: EventTemplate): Promise<Event>;
    };
  }
}
```
(The augmentation in `nostr-signer.ts` now provides `Window["nostr"]` project-wide. `EventTemplate`/`Event` remain imported and used by `challengeTemplate`/`submit`.)

- [ ] **Step 3: Stash the nsec secret on successful nsec login**

In `loginWithNsec` (lines 84-97), after the validity check and before `void submit(...)`, stash the decoded secret so the wallet page can encrypt/decrypt:
```ts
  function loginWithNsec() {
    const dec = (() => {
      try {
        return nip19.decode(nsec.trim());
      } catch {
        return null;
      }
    })();
    if (!dec || dec.type !== "nsec") {
      setError("Invalid nsec");
      return;
    }
    stashSecretKey(dec.data as Uint8Array);
    void submit(async (nonce) => finalizeEvent(challengeTemplate(nonce), dec.data as Uint8Array));
  }
```
(Persona logins re-derive their key on the wallet page from `participant_id`, so they need no stash. NIP-07 logins use the extension.)

- [ ] **Step 4: Verify it typechecks**

Run: `bun run typecheck`
Expected: no errors (in particular, no "Duplicate identifier" / conflicting `Window.nostr`).

- [ ] **Step 5: Commit**

```bash
git add app/ui/login/login-form.tsx
git commit -m "feat(dm): stash nsec for the session; centralize Window.nostr type

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 8: `ProfilePopover` component

**Files:**
- Create: `app/ui/wallet/profile-popover.tsx`

**Interfaces:**
- Produces:
  ```ts
  type ProfilePopoverProps = {
    npub: string;
    name: string;
    initials: string;
    color: string;
    role?: string;
    isSelf: boolean;
    onStartDm: (npub: string) => void;
    onClose: () => void;
  };
  export function ProfilePopover(props: ProfilePopoverProps): JSX.Element;
  ```
- The "Direct message" button is hidden when `isSelf`. Shows avatar, name, role chip, full npub with a copy button.

No component test infra exists (vitest is node-env). Verify via typecheck + manual.

- [ ] **Step 1: Write the component**

`app/ui/wallet/profile-popover.tsx`:
```tsx
"use client";

import { useState } from "react";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

type ProfilePopoverProps = {
  npub: string;
  name: string;
  initials: string;
  color: string;
  role?: string;
  isSelf: boolean;
  onStartDm: (npub: string) => void;
  onClose: () => void;
};

export function ProfilePopover({
  npub,
  name,
  initials,
  color,
  role,
  isSelf,
  onStartDm,
  onClose,
}: ProfilePopoverProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(npub).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    // Backdrop: click outside closes.
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 320,
          background: "#15181C",
          border: "1px solid #2A2F36",
          borderRadius: 14,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: color,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              fontWeight: 700,
              color: "#0E1013",
            }}
          >
            {initials}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{name}</div>
            {role && <div style={{ fontSize: 11, color: "#7B828B" }}>{role}</div>}
          </div>
        </div>

        <button
          onClick={copy}
          title="Copy npub"
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: "#9AA1AA",
            background: "#0E1013",
            border: "1px solid #2A2F36",
            borderRadius: 8,
            padding: "8px 10px",
            textAlign: "left",
            cursor: "pointer",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {copied ? "copied ✓" : npub}
        </button>

        {!isSelf && (
          <button
            onClick={() => onStartDm(npub)}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#0E1013",
              background: "#F7931A",
              border: "none",
              borderRadius: 9,
              padding: "9px 12px",
              cursor: "pointer",
            }}
          >
            Direct message
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/ui/wallet/profile-popover.tsx
git commit -m "feat(dm): ProfilePopover (avatar, npub copy, Direct message button)

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 9: Clickable message authors + open-DM wiring

**Files:**
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Consumes: `ProfilePopover` (Task 8), `POST /api/dms` (Task 3), `me` state (existing, line 115), `colorForNpub`/`initialsFor` are NOT needed client-side here (the message already carries `initials`/`color`).
- Produces: a `popover` state + `startDm` handler in `Wallet`; the message author avatar/name becomes a button that opens `ProfilePopover`.

- [ ] **Step 1: Import the popover and the Chat type usage**

At the top of `app/ui/wallet/wallet.tsx`, add:
```ts
import { ProfilePopover } from "./profile-popover";
```

- [ ] **Step 2: Add popover state + startDm handler in the `Wallet` component**

After the `me` state declaration (line 115), add popover state:
```ts
  const [popover, setPopover] = useState<{
    npub: string;
    name: string;
    initials: string;
    color: string;
    role?: string;
  } | null>(null);
```

Add the `startDm` handler near the other handlers (e.g. after `sendMsg`, around line 497). It finds-or-creates the DM, adds it to `chats`, and opens it:
```ts
  const startDm = useCallback(
    async (targetNpub: string) => {
      setPopover(null);
      const res = await fetch("/api/dms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetNpub }),
      });
      if (!res.ok) {
        setStateError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not open DM");
        return;
      }
      const { chat } = (await res.json()) as { chat: Chat };
      setChats((prev) => (prev.some((c) => c.id === chat.id) ? prev : [...prev, chat]));
      setActiveChat(chat.id);
      setView("chat");
    },
    [],
  );
```
(`setActiveChat`, `setView`, `setChats`, `setStateError` already exist in the component; confirm the exact setter names while editing — `view`/`activeChat` are existing state.)

- [ ] **Step 3: Render the popover once, at the end of `Wallet`'s returned JSX**

Just before the closing tag of the top-level returned element in `Wallet`, add:
```tsx
      {popover && me && (
        <ProfilePopover
          npub={popover.npub}
          name={popover.name}
          initials={popover.initials}
          color={popover.color}
          role={popover.role}
          isSelf={popover.npub === me.npub}
          onStartDm={(npub) => void startDm(npub)}
          onClose={() => setPopover(null)}
        />
      )}
```

- [ ] **Step 4: Make the message author clickable**

`ProfilePopover` opening must be reachable from `ChatDetail`'s message map (lines 1153-1167). Pass an `onAuthorClick` prop down to `ChatDetail`. Where `ChatDetail` is rendered, add the prop; in its signature add `onAuthorClick: (m: ChatMessage) => void`. Then wrap the avatar+name in a clickable element. Replace the avatar `<span>` + name `<span>` (lines 1155, 1158) region with a button that fires `onAuthorClick(m)` when `m.authorNpub` exists:
```tsx
                <button
                  type="button"
                  onClick={() => m.authorNpub && onAuthorClick(m)}
                  disabled={!m.authorNpub}
                  title={m.authorNpub ? "View profile" : undefined}
                  style={{ background: "none", border: "none", padding: 0, cursor: m.authorNpub ? "pointer" : "default" }}
                >
                  <span style={{ width: 34, height: 34, borderRadius: 10, background: m.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: C.bg, flex: "0 0 34px" }}>{m.initials}</span>
                </button>
```
And make the name `<span>` (line 1158) a clickable span inside the existing row:
```tsx
                    <span
                      onClick={() => m.authorNpub && onAuthorClick(m)}
                      style={{ fontSize: 13, fontWeight: 600, cursor: m.authorNpub ? "pointer" : "default" }}
                    >{m.who}</span>
```

In the `Wallet` component, pass `onAuthorClick` to `ChatDetail` (wherever `<ChatDetail ... />` is rendered):
```tsx
        onAuthorClick={(m) =>
          m.authorNpub &&
          setPopover({ npub: m.authorNpub, name: m.who, initials: m.initials, color: m.color })
        }
```

- [ ] **Step 5: Verify it typechecks**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Run: `bun run dev`, log in (any persona), open a channel with messages, click a message author's avatar or name. Expected: the popover appears with that user's name + npub + "Direct message". Clicking "Direct message" opens (or creates) a DM and navigates to it; the new DM appears under the sidebar DIRECT section. Clicking your own message shows the popover with NO "Direct message" button.

- [ ] **Step 7: Commit**

```bash
git add app/ui/wallet/wallet.tsx
git commit -m "feat(dm): clickable message authors open ProfilePopover + start DM

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 10: Channel member roster

**Files:**
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Consumes: `GET /api/chats/:id/members` (Task 4) → `{ members: { npub, label, role, initials, color }[] }`; `setPopover` (Task 9).
- Produces: a `members` state + fetch effect keyed on the active chat; a "Members" list rendered in `ChatDetail` whose rows open the popover.

- [ ] **Step 1: Add members state + fetch effect in `Wallet`**

After the `audit` state (line 116), add:
```ts
  const [members, setMembers] = useState<
    { npub: string; label: string; role: string; initials: string; color: string }[]
  >([]);
```

Add an effect that loads members when the active chat changes (place near the `refreshAudit` usage, after the `active` memo around line 332):
```ts
  useEffect(() => {
    if (!active) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/chats/${active.id}/members`);
      if (!res.ok) {
        if (!cancelled) setMembers([]);
        return;
      }
      const { members: rows } = (await res.json()) as { members: typeof members };
      if (!cancelled) setMembers(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [active?.id]);
```

- [ ] **Step 2: Pass members + an `onMemberClick` to `ChatDetail`**

Where `<ChatDetail ... />` is rendered, add:
```tsx
        members={members}
        onMemberClick={(mem) =>
          setPopover({ npub: mem.npub, name: mem.label, initials: mem.initials, color: mem.color, role: mem.role })
        }
```
In `ChatDetail`'s prop type, add:
```ts
  members: { npub: string; label: string; role: string; initials: string; color: string }[];
  onMemberClick: (m: { npub: string; label: string; role: string; initials: string; color: string }) => void;
```

- [ ] **Step 3: Render the roster in `ChatDetail`**

In the right-hand column area (lines 1213-1221), render a Members list. For channels it slots next to proposals/audit; for DMs (where `!isDirect` currently hides the whole column) show just the roster. Replace the `{!isDirect && ( ... )}` block (lines 1216-1221) with:
```tsx
        <div style={{ flex: "0 0 296px", display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
          <div style={{ background: "#15181C", border: "1px solid #2A2F36", borderRadius: 12, padding: 12 }}>
            <div style={{ fontSize: 10, color: "#5E6369", letterSpacing: ".5px", marginBottom: 8 }}>
              MEMBERS · {members.length}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {members.map((mem) => (
                <button
                  key={mem.npub}
                  type="button"
                  onClick={() => onMemberClick(mem)}
                  style={{ display: "flex", alignItems: "center", gap: 9, background: "none", border: "none", padding: "5px 6px", borderRadius: 8, cursor: "pointer", textAlign: "left", color: "inherit" }}
                >
                  <span style={{ width: 24, height: 24, borderRadius: 7, background: mem.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#0E1013", flex: "0 0 24px" }}>{mem.initials}</span>
                  <span style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mem.label}</span>
                </button>
              ))}
            </div>
          </div>
          {!isDirect && (
            <>
              <OngoingProposals proposals={pendingApprovals} onSign={onSign} signingId={signingId} />
              <AuditPanel audit={audit} />
            </>
          )}
        </div>
```

- [ ] **Step 4: Verify it typechecks**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Run: `bun run dev`. Open a channel — the right column shows a "MEMBERS · N" list of everyone in `chat_members`. Click a member who hasn't posted → popover → "Direct message" opens a DM with them. Open a DM — the right column shows just the 2-person roster, no proposals/audit.

- [ ] **Step 6: Commit**

```bash
git add app/ui/wallet/wallet.tsx
git commit -m "feat(dm): channel member roster, clickable to start a DM

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Task 11: Encrypt-on-send + decrypt-on-view for DMs

**Files:**
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Consumes: `resolveSigner`/`NostrSigner` (Task 6); `active.counterpartyNpub` (Task 5); `me` (existing).
- Produces: a `signer` state, a `plain` (messageId → decrypted text) state, encryption in `sendMsg`, and a decrypt effect for the active DM. Render path shows decrypted text for `type:"direct"` chats.

- [ ] **Step 1: Import the signer**

At the top of `app/ui/wallet/wallet.tsx`:
```ts
import { resolveSigner, type NostrSigner } from "./nostr-signer";
```

- [ ] **Step 2: Add signer + plaintext state and resolve the signer when `me` is known**

After the `popover` state (Task 9), add:
```ts
  const [signer, setSigner] = useState<NostrSigner | null>(null);
  const [plain, setPlain] = useState<Record<string, string>>({});
```

Add an effect to resolve the signer (place after the `me` is set, e.g. near other effects):
```ts
  useEffect(() => {
    if (!me) {
      setSigner(null);
      return;
    }
    let cancelled = false;
    void resolveSigner({ npub: me.npub, participant_id: me.participant_id }).then((s) => {
      if (!cancelled) setSigner(s);
    });
    return () => {
      cancelled = true;
    };
  }, [me]);
```

- [ ] **Step 3: Decrypt the active DM's history**

Add an effect that decrypts messages of the active direct chat as they appear (keyed on chat id + message count so new messages get decrypted, without looping on `plain`):
```ts
  useEffect(() => {
    if (!signer || !active || active.type !== "direct" || !active.counterpartyNpub) return;
    const cp = active.counterpartyNpub;
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const m of active.messages) {
        if (plain[m.id] !== undefined) continue;
        try {
          next[m.id] = await signer.decrypt(cp, m.text);
        } catch {
          next[m.id] = "🔒 can't decrypt";
        }
      }
      if (!cancelled && Object.keys(next).length) setPlain((p) => ({ ...p, ...next }));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer, active?.id, active?.messages.length]);
```

- [ ] **Step 4: Encrypt before sending in a DM**

In `sendMsg` (lines 473-497), encrypt the text when the active chat is a direct chat, and stash the plaintext for immediate display. Replace the body of the inner async send (lines 483-497) with:
```ts
    void (async () => {
      let payload = text;
      const dm = active && active.type === "direct" ? active : null;
      if (dm) {
        if (!signer || !dm.counterpartyNpub) {
          setStateError("DM encryption unavailable — log in with a persona or a NIP-44 capable signer");
          return;
        }
        payload = await signer.encrypt(dm.counterpartyNpub, text);
      }
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: cid, text: payload }),
      });
      if (!res.ok) {
        setStateError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Message failed");
        return;
      }
      const { message } = (await res.json()) as { message: ChatMessage };
      if (dm) setPlain((p) => ({ ...p, [message.id]: text })); // show our own plaintext immediately
      setChats((prev) =>
        prev.map((c) => (c.id === cid ? { ...c, messages: [...c.messages, message] } : c)),
      );
      void refreshAudit(cid);
    })();
```
(`active` must be in scope in `sendMsg`; it's the `active` memo from line 328. `cid` is the captured `activeChat`.)

- [ ] **Step 5: Render decrypted text for DMs**

`ChatDetail` needs the `plain` map. Pass it down: at `<ChatDetail ... />` add `plain={plain}`, and add `plain: Record<string, string>` to `ChatDetail`'s props. In the message text render (line 1163), show decrypted text for direct chats:
```tsx
                  <div style={{ fontSize: 13, color: "#C5C9CE", lineHeight: 1.55, marginTop: 4 }}>
                    {chat.type === "direct" ? (plain[m.id] ?? "🔒 decrypting…") : m.text}
                  </div>
```

- [ ] **Step 6: Verify the full suite + types**

Run: `bun run test && bun run typecheck`
Expected: all tests PASS; no type errors.

- [ ] **Step 7: Manual verification (two personas)**

Run: `bun run dev`.
1. Log in as persona A, open a channel, click persona B's message author → "Direct message". Send "hello B".
2. Open a second browser/profile, log in as persona B. The DM with A appears under DIRECT; opening it shows "hello B" decrypted (not ciphertext). Reply "hi A".
3. Back as A, the reply decrypts to "hi A".
4. Inspect the DB (`sqlite3 data/btech.db "SELECT text FROM messages WHERE chat_id LIKE 'dm_%'"`) → values are NIP-44 base64 ciphertext, NOT the plaintext. This is the E2E confidentiality check.

- [ ] **Step 8: Commit**

```bash
git add app/ui/wallet/wallet.tsx
git commit -m "feat(dm): NIP-44 encrypt-on-send + decrypt-on-view for direct chats

Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- §2 identity plumbing → Task 5 (`authorNpub` in SELECT + type) + Task 4 (members endpoint).
- §3 ProfilePopover → Task 8; reached from authors (Task 9) and roster (Task 10).
- §3b member roster → Task 4 (endpoint) + Task 10 (UI).
- §4 find-or-create `POST /api/dms` + `counterpartyNpub` → Task 2 (logic) + Task 3 (route) + Task 5 (per-viewer counterparty).
- §5 NostrSigner (persona/nsec/NIP-07, client-side) → Task 6 + Task 7 (nsec stash).
- §6 send/store ciphertext → Task 11 step 4 (encrypt) + reuse of existing `/api/messages` (no server crypto, no schema change).
- §7 render/decrypt, gated on `chat.type`, with 🔒 placeholder → Task 11 steps 3 & 5.
- §8 Phase 2 relay → out of scope (separate future plan), as the spec states.
- §9 edge cases: self-DM (Task 3 reject + Task 8 hides button), NIP-07 lacking nip44 (Task 6 throws → Task 11 shows error/placeholder), long npub (Task 8 truncates + copy).
- §10 testing → avatar/dm/nostr-signer unit tests (Tasks 1, 2, 6); DB-ciphertext integration is the Task 11 step-7 manual check (no route-test harness for cookie sessions exists; logic is covered at the `_lib` level).

**Placeholder scan:** none — every code step contains complete code.

**Type consistency:** `counterpartyNpub`/`authorNpub` defined in Task 5 and consumed in Tasks 3, 9, 11. `NostrSigner.encrypt/decrypt(counterpartyNpub, text)` defined in Task 6, used consistently in Task 11. `Member` shape `{ npub, label, role, initials, color }` consistent across Tasks 2, 4, 10.

**Known limitation (documented, not a gap):** the channel roster lists `chat_members` (people who have acted/joined), which for the demo personas fills in as they participate; it is not the full vault signer set (`SignerKey` rows carry no npub). This matches the spec's stated data source.
