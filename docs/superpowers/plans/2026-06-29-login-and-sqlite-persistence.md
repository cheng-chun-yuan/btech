# Login + SQLite Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. (Per this project's global rule, code is written by the main agent, not subagents — so subagent-driven execution does NOT apply here.) Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Nostr-key + demo-persona login and local SQLite persistence (sessions, chats, messages, approvals, signatures) to the BTech wallet console, without touching the Rust crypto crate.

**Architecture:** All persistence lives Next-side in a single SQLite file via `better-sqlite3`. The Rust binary stays a stateless CLI that computes deterministic crypto proofs. App data (the existing mock chats/approvals) is seeded into SQLite and becomes mutable. Identity = Nostr npub; the npub maps to a live-vault signer (deterministically derived per `participant_id`) to drive role-based views.

**Tech Stack:** Next.js 16 (App Router, Node runtime routes), TypeScript, `better-sqlite3`, `nostr-tools` (nip19), `vitest` (tests), Bun (package manager/scripts).

## Global Constraints

- Package manager / runner: **Bun** — `bun add`, `bun run <script>` (never npm).
- Node version of Next routes: `runtime = "nodejs"` (already set on existing routes) — required for `better-sqlite3`.
- Do **not** modify the Rust crate (`src/**`, `Cargo.toml`) or `app/api/_lib/btech.ts`'s behavior.
- nsec secret keys **never** leave the browser — only the derived npub is sent to the server.
- SQLite file path: `process.env.BTECH_DB ?? <cwd>/data/btech.db`; tests use `:memory:`.
- TS shapes (`Chat`, `Approval`, `ChatMessage`, etc.) are defined in `app/ui/wallet/types.ts` — API responses MUST match them exactly.
- Brand (per `PRODUCT.md`): precise/restrained/technical; WCAG AA; status not by color alone.

---

## File Structure

```
middleware.ts                          NEW  auth guard (PROJECT ROOT)
vitest.config.ts                       NEW  test runner config
data/                                  NEW  (gitignored) sqlite file lives here
app/
  login/page.tsx                       NEW  login route (server component)
  ui/login/login-form.tsx              NEW  client login form
  api/
    _lib/db.ts                         NEW  sqlite singleton + migrate + seed
    _lib/identity.ts                   NEW  npub validation, deterministic npub, signer sync
    _lib/auth.ts                       NEW  session + cookie helpers
    _lib/db.test.ts                    NEW
    _lib/identity.test.ts              NEW
    _lib/auth.test.ts                  NEW
    auth/login/route.ts                NEW
    auth/logout/route.ts               NEW
    auth/me/route.ts                   NEW
    auth/personas/route.ts             NEW
    chats/route.ts                     NEW
    messages/route.ts                  NEW
    approvals/route.ts                 NEW
    approvals/[id]/sign/route.ts       NEW
  ui/wallet/wallet.tsx                 EDIT  fetch chats/approvals; post messages; sign; identify "you"
.gitignore                             EDIT  add /data/
package.json                           EDIT  deps + test script
```

---

## Task 1: Project deps, test runner, gitignore, SQLite layer

**Files:**
- Modify: `package.json`, `.gitignore`
- Create: `vitest.config.ts`, `app/api/_lib/db.ts`, `app/api/_lib/db.test.ts`

**Interfaces:**
- Produces:
  - `getDb(): Database.Database` — process-singleton, migrated + seeded, file-backed.
  - `openTestDb(): Database.Database` — fresh `:memory:` db, migrated + seeded.
  - `migrate(db): void`, `seed(db): void`.
  - Tables per spec §5: `users, sessions, signers, chats, messages, approvals, approval_signatures`, plus `schema_meta(version INTEGER)`.

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/chengchunyuan/project/btech
bun add better-sqlite3 nostr-tools
bun add -d vitest @types/better-sqlite3
```

- [ ] **Step 2: Add test script to package.json**

In `package.json` `"scripts"`, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Ignore the data dir**

Append to `.gitignore`:

```
/data/
```

- [ ] **Step 4: Create vitest config**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Write the failing test for the DB layer**

`app/api/_lib/db.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";

describe("db", () => {
  it("creates all tables", () => {
    const db = openTestDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const t of [
      "users", "sessions", "signers", "chats",
      "messages", "approvals", "approval_signatures", "schema_meta",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("seeds the mock chats and approvals once (idempotent)", () => {
    const db = openTestDb();
    const chats1 = db.prepare("SELECT COUNT(*) c FROM chats").get() as { c: number };
    const approvals1 = db.prepare("SELECT COUNT(*) c FROM approvals").get() as { c: number };
    expect(chats1.c).toBeGreaterThan(0);
    expect(approvals1.c).toBeGreaterThan(0);
    // Re-seeding must not duplicate.
    const { seed } = require("./db");
    seed(db);
    const chats2 = db.prepare("SELECT COUNT(*) c FROM chats").get() as { c: number };
    expect(chats2.c).toBe(chats1.c);
  });

  it("seeds messages for seeded chats", () => {
    const db = openTestDb();
    const msgs = db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number };
    expect(msgs.c).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun run test app/api/_lib/db.test.ts`
Expected: FAIL — `Cannot find module './db'`.

- [ ] **Step 7: Implement the DB layer**

`app/api/_lib/db.ts`:

```ts
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

import { MOCK_CHATS, MOCK_APPROVALS } from "../../ui/wallet/data";
import type { Chat } from "../../ui/wallet/types";

export type DB = Database.Database;

const SCHEMA_VERSION = 1;

export function migrate(db: DB): void {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS users (
      npub TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      npub TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signers (
      vault_id TEXT NOT NULL,
      participant_id INTEGER NOT NULL,
      npub TEXT NOT NULL,
      label TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (vault_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      data_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      author_npub TEXT,
      who TEXT NOT NULL,
      handle TEXT,
      initials TEXT,
      color TEXT,
      time TEXT,
      text TEXT NOT NULL,
      signed INTEGER NOT NULL DEFAULT 0,
      zaps TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      vault TEXT NOT NULL,
      kind TEXT NOT NULL,
      data_json TEXT NOT NULL,
      status TEXT NOT NULL,
      is_live INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_signatures (
      approval_id TEXT NOT NULL,
      npub TEXT NOT NULL,
      aggregate_signature TEXT,
      signed_at INTEGER NOT NULL,
      PRIMARY KEY (approval_id, npub)
    );
  `);
  const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    | { version: number }
    | undefined;
  if (!row) db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(SCHEMA_VERSION);
}

export function seed(db: DB): void {
  const now = Date.now();
  const insertChat = db.prepare(
    "INSERT OR IGNORE INTO chats (id, type, name, data_json) VALUES (?, ?, ?, ?)",
  );
  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, chat_id, author_npub, who, handle, initials, color, time, text, signed, zaps, created_at)
    VALUES (@id, @chat_id, NULL, @who, @handle, @initials, @color, @time, @text, @signed, @zaps, @created_at)
  `);
  const insertApproval = db.prepare(
    "INSERT OR IGNORE INTO approvals (id, vault, kind, data_json, status, is_live, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
  );

  const seedTx = db.transaction(() => {
    for (const chat of MOCK_CHATS as Chat[]) {
      const { messages, ...meta } = chat;
      insertChat.run(chat.id, chat.type, chat.name, JSON.stringify(meta));
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        insertMsg.run({
          id: m.id,
          chat_id: chat.id,
          who: m.who,
          handle: m.handle,
          initials: m.initials,
          color: m.color,
          time: m.time,
          text: m.text,
          signed: m.signed ? 1 : 0,
          zaps: m.zaps,
          created_at: now + i,
        });
      }
    }
    for (const a of MOCK_APPROVALS) {
      insertApproval.run(a.id, a.vault, a.kind, JSON.stringify(a), a.status, now);
    }
  });
  seedTx();
}

export function openTestDb(): DB {
  const db = new Database(":memory:");
  migrate(db);
  seed(db);
  return db;
}

declare global {
  // eslint-disable-next-line no-var
  var __btechDb: DB | undefined;
}

export function getDb(): DB {
  if (globalThis.__btechDb) return globalThis.__btechDb;
  const file = process.env.BTECH_DB ?? path.join(process.cwd(), "data", "btech.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  migrate(db);
  seed(db);
  globalThis.__btechDb = db;
  return db;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun run test app/api/_lib/db.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock .gitignore vitest.config.ts app/api/_lib/db.ts app/api/_lib/db.test.ts
git commit -m "feat: add sqlite persistence layer seeded from mock data"
```

---

## Task 2: Identity helpers (npub validation + deterministic signer npubs)

**Files:**
- Create: `app/api/_lib/identity.ts`, `app/api/_lib/identity.test.ts`

**Interfaces:**
- Consumes: `getDb` from `./db`.
- Produces:
  - `isValidNpub(npub: string): boolean` — true iff bech32 `npub1...` decodes to 32-byte pubkey.
  - `normalizeNpub(input: string): string | null` — accepts npub or 64-char hex, returns canonical npub or null.
  - `deterministicNpub(participantId: number): string` — stable npub from `sha256("btech-signer-v1:" + id)`.
  - `syncSigners(db, invites): void` — upsert `users` + `signers` for a live vault from session-proof invites (`{participant_id,label,role}[]`, vault_id `"treasury"`).
  - `listSigners(db): { npub, label, role, participant_id }[]`.

- [ ] **Step 1: Write the failing test**

`app/api/_lib/identity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import {
  isValidNpub, normalizeNpub, deterministicNpub, syncSigners, listSigners,
} from "./identity";

describe("identity", () => {
  it("deterministicNpub is stable and valid", () => {
    const a = deterministicNpub(1);
    const b = deterministicNpub(1);
    expect(a).toBe(b);
    expect(isValidNpub(a)).toBe(true);
    expect(deterministicNpub(2)).not.toBe(a);
  });

  it("validates and normalizes npub + hex", () => {
    const npub = deterministicNpub(3);
    expect(isValidNpub(npub)).toBe(true);
    expect(isValidNpub("npub1notreal")).toBe(false);
    expect(normalizeNpub(npub)).toBe(npub);
    expect(normalizeNpub("z".repeat(64))).toBe(null);
    expect(normalizeNpub("ab")).toBe(null);
  });

  it("syncSigners upserts users and signers idempotently", () => {
    const db = openTestDb();
    const invites = [
      { participant_id: 1, label: "Alice", role: "Founder" },
      { participant_id: 2, label: "Bob", role: "Security" },
    ];
    syncSigners(db, invites);
    syncSigners(db, invites);
    const signers = listSigners(db);
    expect(signers.length).toBe(2);
    expect(signers[0].npub).toBe(deterministicNpub(1));
    const users = db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number };
    expect(users.c).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test app/api/_lib/identity.test.ts`
Expected: FAIL — `Cannot find module './identity'`.

- [ ] **Step 3: Implement identity helpers**

`app/api/_lib/identity.ts`:

```ts
import { createHash } from "node:crypto";
import { nip19 } from "nostr-tools";

import type { DB } from "./db";

const VAULT_ID = "treasury";

export function isValidNpub(npub: string): boolean {
  try {
    const d = nip19.decode(npub);
    return d.type === "npub" && typeof d.data === "string" && d.data.length === 64;
  } catch {
    return false;
  }
}

export function normalizeNpub(input: string): string | null {
  const s = input.trim();
  if (s.startsWith("npub1")) return isValidNpub(s) ? s : null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    try {
      return nip19.npubEncode(s.toLowerCase());
    } catch {
      return null;
    }
  }
  return null;
}

export function deterministicNpub(participantId: number): string {
  const hex = createHash("sha256").update(`btech-signer-v1:${participantId}`).digest("hex");
  return nip19.npubEncode(hex);
}

type Invite = { participant_id: number; label: string; role: string };

export function syncSigners(db: DB, invites: Invite[]): void {
  const upsertUser = db.prepare(`
    INSERT INTO users (npub, label, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(npub) DO UPDATE SET label=excluded.label, role=excluded.role
  `);
  const upsertSigner = db.prepare(`
    INSERT INTO signers (vault_id, participant_id, npub, label, role) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(vault_id, participant_id) DO UPDATE SET npub=excluded.npub, label=excluded.label, role=excluded.role
  `);
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const inv of invites) {
      const npub = deterministicNpub(inv.participant_id);
      upsertUser.run(npub, inv.label, inv.role, now);
      upsertSigner.run(VAULT_ID, inv.participant_id, npub, inv.label, inv.role);
    }
  });
  tx();
}

export function listSigners(
  db: DB,
): { npub: string; label: string; role: string; participant_id: number }[] {
  return db
    .prepare("SELECT npub, label, role, participant_id FROM signers WHERE vault_id = ? ORDER BY participant_id")
    .all(VAULT_ID) as { npub: string; label: string; role: string; participant_id: number }[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test app/api/_lib/identity.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/_lib/identity.ts app/api/_lib/identity.test.ts
git commit -m "feat: add npub identity helpers and deterministic signer mapping"
```

---

## Task 3: Session + cookie helpers

**Files:**
- Create: `app/api/_lib/auth.ts`, `app/api/_lib/auth.test.ts`

**Interfaces:**
- Consumes: `getDb` from `./db`.
- Produces:
  - `SESSION_COOKIE = "btech_session"`.
  - `createSession(db, npub): string` — inserts a session row, returns token (32-byte hex).
  - `getSessionUser(db, token): { npub, label, role } | null` — null if missing/expired.
  - `deleteSession(db, token): void`.
  - `SESSION_TTL_MS = 1000*60*60*12`.

- [ ] **Step 1: Write the failing test**

`app/api/_lib/auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import { createSession, getSessionUser, deleteSession } from "./auth";

function addUser(db: ReturnType<typeof openTestDb>, npub: string) {
  db.prepare("INSERT INTO users (npub, label, role, created_at) VALUES (?, 'Tester', 'Founder', ?)")
    .run(npub, Date.now());
}

describe("auth", () => {
  it("creates and resolves a session", () => {
    const db = openTestDb();
    addUser(db, "npub_x");
    const token = createSession(db, "npub_x");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const user = getSessionUser(db, token);
    expect(user?.npub).toBe("npub_x");
    expect(user?.label).toBe("Tester");
  });

  it("returns null for unknown or deleted token", () => {
    const db = openTestDb();
    addUser(db, "npub_y");
    const token = createSession(db, "npub_y");
    deleteSession(db, token);
    expect(getSessionUser(db, token)).toBe(null);
    expect(getSessionUser(db, "nope")).toBe(null);
  });

  it("returns null for expired session", () => {
    const db = openTestDb();
    addUser(db, "npub_z");
    const token = "deadbeef".repeat(8);
    db.prepare("INSERT INTO sessions (token, npub, created_at, expires_at) VALUES (?, 'npub_z', ?, ?)")
      .run(token, Date.now() - 1000, Date.now() - 500);
    expect(getSessionUser(db, token)).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test app/api/_lib/auth.test.ts`
Expected: FAIL — `Cannot find module './auth'`.

- [ ] **Step 3: Implement session helpers**

`app/api/_lib/auth.ts`:

```ts
import { randomBytes } from "node:crypto";

import type { DB } from "./db";

export const SESSION_COOKIE = "btech_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

export function createSession(db: DB, npub: string): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token, npub, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, npub, now, now + SESSION_TTL_MS);
  return token;
}

export function getSessionUser(
  db: DB,
  token: string | undefined,
): { npub: string; label: string; role: string } | null {
  if (!token) return null;
  const row = db
    .prepare(`
      SELECT u.npub AS npub, u.label AS label, u.role AS role, s.expires_at AS expires_at
      FROM sessions s JOIN users u ON u.npub = s.npub
      WHERE s.token = ?
    `)
    .get(token) as { npub: string; label: string; role: string; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    deleteSession(db, token);
    return null;
  }
  return { npub: row.npub, label: row.label, role: row.role };
}

export function deleteSession(db: DB, token: string | undefined): void {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test app/api/_lib/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/_lib/auth.ts app/api/_lib/auth.test.ts
git commit -m "feat: add session and cookie helpers backed by sqlite"
```

---

## Task 4: Auth + personas API routes

**Files:**
- Create: `app/api/auth/login/route.ts`, `app/api/auth/logout/route.ts`, `app/api/auth/me/route.ts`, `app/api/auth/personas/route.ts`

**Interfaces:**
- Consumes: `getDb` (db.ts), `normalizeNpub`/`listSigners`/`syncSigners` (identity.ts), `createSession`/`getSessionUser`/`deleteSession`/`SESSION_COOKIE`/`SESSION_TTL_MS` (auth.ts), `runSessionProof` (btech.ts).
- Produces (HTTP):
  - `POST /api/auth/login` body `{ npub }` → 200 `{ npub, label, role, signer: boolean }` + Set-Cookie; 400 invalid.
  - `POST /api/auth/logout` → 200 `{ ok: true }`, clears cookie.
  - `GET /api/auth/me` → 200 `{ npub, label, role, participant_id|null }` or 401.
  - `GET /api/auth/personas` → 200 `{ personas: {npub,label,role,participant_id}[] }`.

- [ ] **Step 1: Implement `GET /api/auth/personas`**

`app/api/auth/personas/route.ts`:

```ts
import { NextResponse } from "next/server";

import { getDb } from "../../_lib/db";
import { listSigners, syncSigners } from "../../_lib/identity";
import { runSessionProof } from "../../_lib/btech";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  let personas = listSigners(db);
  if (personas.length === 0) {
    // First boot: derive signer identities from the live vault invites.
    try {
      const session = await runSessionProof("btech-wallet-ui");
      syncSigners(db, session.invites);
      personas = listSigners(db);
    } catch {
      // Backend offline — return empty; UI can still use nsec/NIP-07 login.
    }
  }
  return NextResponse.json({ personas });
}
```

- [ ] **Step 2: Implement `POST /api/auth/login`**

`app/api/auth/login/route.ts`:

```ts
import { NextResponse } from "next/server";

import { getDb } from "../../_lib/db";
import { normalizeNpub } from "../../_lib/identity";
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from "../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { npub?: string };
  const npub = body.npub ? normalizeNpub(body.npub) : null;
  if (!npub) {
    return NextResponse.json({ error: "Invalid Nostr key" }, { status: 400 });
  }

  const db = getDb();
  const existing = db.prepare("SELECT npub, label, role FROM users WHERE npub = ?").get(npub) as
    | { npub: string; label: string; role: string }
    | undefined;

  // Unknown npub logs in as a read-only observer.
  const user =
    existing ??
    (() => {
      db.prepare("INSERT INTO users (npub, label, role, created_at) VALUES (?, 'Observer', 'Observer', ?)")
        .run(npub, Date.now());
      return { npub, label: "Observer", role: "Observer" };
    })();

  const signer = !!db
    .prepare("SELECT 1 FROM signers WHERE npub = ? LIMIT 1")
    .get(npub);

  const token = createSession(db, npub);
  const res = NextResponse.json({ ...user, signer });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
```

- [ ] **Step 3: Implement `POST /api/auth/logout`**

`app/api/auth/logout/route.ts`:

```ts
import { NextResponse } from "next/server";

import { getDb } from "../../_lib/db";
import { deleteSession, SESSION_COOKIE } from "../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  deleteSession(getDb(), token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
```

- [ ] **Step 4: Implement `GET /api/auth/me`**

`app/api/auth/me/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const db = getDb();
  const user = getSessionUser(db, token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const signer = db
    .prepare("SELECT participant_id FROM signers WHERE npub = ? LIMIT 1")
    .get(user.npub) as { participant_id: number } | undefined;
  return NextResponse.json({ ...user, participant_id: signer?.participant_id ?? null });
}
```

- [ ] **Step 5: Verify routes by hand**

Run (dev server up via `bun run dev`):

```bash
curl -s localhost:3000/api/auth/personas | head -c 400; echo
NPUB=$(curl -s localhost:3000/api/auth/personas | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).personas[0].npub))')
curl -s -i -X POST localhost:3000/api/auth/login -H 'content-type: application/json' -d "{\"npub\":\"$NPUB\"}" | grep -i set-cookie
```

Expected: personas JSON lists derived signers; login returns 200 with a `set-cookie: btech_session=...`.

- [ ] **Step 6: Commit**

```bash
git add app/api/auth
git commit -m "feat: add auth (login/logout/me) and personas routes"
```

---

## Task 5: Route guard middleware

**Files:**
- Create: `middleware.ts` (project root)

**Interfaces:**
- Consumes: `SESSION_COOKIE` value `"btech_session"` (string literal — middleware runs on the edge runtime and must NOT import `better-sqlite3`).
- Produces: redirect unauthenticated page requests to `/login`; 401 JSON for unauthenticated `/api/*` (except `/api/auth/*`).

- [ ] **Step 1: Implement middleware**

`middleware.ts` (project root, sibling of `app/`):

```ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE = "btech_session";

// Presence-only check here (no DB on the edge); routes do the authoritative
// session lookup against SQLite.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico";
  if (isPublic) return NextResponse.next();

  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (hasSession) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 2: Verify the guard**

Run:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" localhost:3000/         # 307 -> /login
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/wallet/state          # 401
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/auth/personas         # 200
```

Expected: `/` redirects to `/login`; protected API is 401; auth API is 200.

- [ ] **Step 3: Commit**

```bash
git add middleware.ts
git commit -m "feat: guard routes behind session cookie via middleware"
```

---

## Task 6: Login page UI

**Files:**
- Create: `app/login/page.tsx`, `app/ui/login/login-form.tsx`

**Interfaces:**
- Consumes: `GET /api/auth/personas`, `POST /api/auth/login`, browser `window.nostr` (NIP-07), `nip19` from `nostr-tools` for nsec → npub.
- Produces: on success, `window.location.href = "/"`.

- [ ] **Step 1: Implement the login route (server component)**

`app/login/page.tsx`:

```tsx
import LoginForm from "../ui/login/login-form";

export default function LoginPage() {
  return <LoginForm />;
}
```

- [ ] **Step 2: Implement the client login form**

`app/ui/login/login-form.tsx` (reuse the wallet palette; status not by color alone):

```tsx
"use client";

import { useEffect, useState } from "react";
import { nip19 } from "nostr-tools";

type Persona = { npub: string; label: string; role: string; participant_id: number };

const C = {
  bg: "#0A0B0D", surface: "#121418", line: "rgba(255,255,255,.08)",
  ink: "#EDEEF0", muted: "#A9AEB4", orange: "#F7931A", red: "#F0616D",
};
const MONO = "'JetBrains Mono', monospace";

declare global {
  interface Window { nostr?: { getPublicKey(): Promise<string> } }
}

export default function LoginForm() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [nsec, setNsec] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/personas")
      .then((r) => r.json())
      .then((d) => setPersonas(d.personas ?? []))
      .catch(() => setPersonas([]));
  }, []);

  async function login(npub: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npub }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Login failed");
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
      setBusy(false);
    }
  }

  async function connectNip07() {
    try {
      if (!window.nostr) throw new Error("No NIP-07 extension found (try Alby or nos2x)");
      const hex = await window.nostr.getPublicKey();
      await login(nip19.npubEncode(hex));
    } catch (e) {
      setError(e instanceof Error ? e.message : "NIP-07 connect failed");
    }
  }

  function loginWithNsec() {
    try {
      const dec = nip19.decode(nsec.trim());
      if (dec.type !== "nsec") throw new Error("Not an nsec key");
      const { getPublicKey } = require("nostr-tools");
      const hex = getPublicKey(dec.data as Uint8Array);
      void login(nip19.npubEncode(hex));
    } catch {
      setError("Invalid nsec");
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: C.bg, color: C.ink, display: "grid", placeItems: "center", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}>
      <div style={{ width: 380, padding: 28, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>BTech DKGKit Console</h1>
        <p style={{ color: C.muted, fontSize: 13, marginTop: 6 }}>Sign in with a Nostr key to access the vault.</p>

        <button onClick={connectNip07} disabled={busy} style={btn(C.orange, "#0A0B0D")}>Connect Nostr extension</button>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input value={nsec} onChange={(e) => setNsec(e.target.value)} placeholder="nsec1…" style={{ flex: 1, padding: "10px 12px", background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontFamily: MONO, fontSize: 12 }} />
          <button onClick={loginWithNsec} disabled={busy || !nsec} style={btn("transparent", C.ink, C.line)}>Use</button>
        </div>

        {personas.length > 0 && (
          <>
            <div style={{ color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, margin: "18px 0 8px" }}>Demo personas</div>
            <div style={{ display: "grid", gap: 6 }}>
              {personas.map((p) => (
                <button key={p.npub} onClick={() => login(p.npub)} disabled={busy} style={{ ...btn(C.bg, C.ink, C.line), justifyContent: "space-between", display: "flex" }}>
                  <span>{p.label}</span>
                  <span style={{ color: C.muted, fontFamily: MONO, fontSize: 11 }}>{p.role} · #{p.participant_id}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {error && <p role="alert" style={{ color: C.red, fontSize: 12, marginTop: 14 }}>⚠ {error}</p>}
      </div>
    </main>
  );
}

function btn(bg: string, fg: string, border = "transparent") {
  return {
    width: "100%", marginTop: 10, padding: "11px 14px", background: bg, color: fg,
    border: `1px solid ${border}`, borderRadius: 9, fontSize: 13, cursor: "pointer",
  } as const;
}
```

- [ ] **Step 3: Verify the login page renders and a persona login works**

Run: open `http://localhost:3000/login` in a browser (or `curl -s localhost:3000/login | grep -o "BTech DKGKit Console"`).
Then click a demo persona → should land on `/` (the wallet). Expected: redirected in, session cookie set.

- [ ] **Step 4: Commit**

```bash
git add app/login app/ui/login
git commit -m "feat: add Nostr + demo-persona login screen"
```

---

## Task 7: Chats + messages persistence and UI wiring

**Files:**
- Create: `app/api/chats/route.ts`, `app/api/messages/route.ts`
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Consumes: `getDb`, `cookies()`/`getSessionUser` for the author.
- Produces (HTTP):
  - `GET /api/chats` → `{ chats: Chat[] }` (each chat's `messages` joined from the messages table, ordered by `created_at`).
  - `POST /api/messages` body `{ chatId, text }` → `{ message: ChatMessage }`, persisted with the session user as author.

- [ ] **Step 1: Implement `GET /api/chats`**

`app/api/chats/route.ts`:

```ts
import { NextResponse } from "next/server";

import { getDb } from "../_lib/db";
import type { Chat, ChatMessage } from "../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const chatRows = db.prepare("SELECT id, data_json FROM chats").all() as
    { id: string; data_json: string }[];
  const msgStmt = db.prepare(
    "SELECT id, who, handle, initials, color, time, text, signed, zaps FROM messages WHERE chat_id = ? ORDER BY created_at",
  );
  const chats: Chat[] = chatRows.map((row) => {
    const meta = JSON.parse(row.data_json) as Omit<Chat, "messages">;
    const messages = (msgStmt.all(row.id) as Record<string, unknown>[]).map((m) => ({
      ...m, signed: !!m.signed,
    })) as unknown as ChatMessage[];
    return { ...meta, messages };
  });
  return NextResponse.json({ chats });
}
```

- [ ] **Step 2: Implement `POST /api/messages`**

`app/api/messages/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";

import { getDb } from "../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../_lib/auth";
import type { ChatMessage } from "../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const db = getDb();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = getSessionUser(db, token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { chatId, text } = (await request.json().catch(() => ({}))) as { chatId?: string; text?: string };
  if (!chatId || !text?.trim()) {
    return NextResponse.json({ error: "chatId and text required" }, { status: 400 });
  }
  const exists = db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId);
  if (!exists) return NextResponse.json({ error: "Unknown chat" }, { status: 404 });

  const initials = user.label.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  const message: ChatMessage = {
    id: `m_${randomBytes(6).toString("hex")}`,
    who: user.label,
    handle: user.npub.slice(0, 12) + "…",
    initials,
    color: "#F7931A",
    time: "now",
    text: text.trim(),
    signed: false,
    zaps: "",
  };
  db.prepare(`
    INSERT INTO messages (id, chat_id, author_npub, who, handle, initials, color, time, text, signed, zaps, created_at)
    VALUES (@id, @chat_id, @author_npub, @who, @handle, @initials, @color, @time, @text, 0, @zaps, @created_at)
  `).run({ ...message, chat_id: chatId, author_npub: user.npub, signed: 0, created_at: Date.now() });

  return NextResponse.json({ message });
}
```

- [ ] **Step 3: Wire the wallet UI to fetch chats and post messages**

In `app/ui/wallet/wallet.tsx`:

1. Remove the static `MOCK_CHATS` import usage for the rendered list; keep `buildLiveVault`, `buildLiveApproval`, `livePolicyString` imports.
2. Add state + fetch on mount:

```tsx
const [chats, setChats] = useState<Chat[]>([]);
useEffect(() => {
  fetch("/api/chats").then((r) => r.json()).then((d) => setChats(d.chats ?? []));
}, []);
```

3. Where the component currently builds the chat list from `MOCK_CHATS` plus the live vault, replace the `MOCK_CHATS` portion with `chats` from state (the live vault from `/api/wallet/state` is still prepended via `buildLiveVault`).
4. In the message composer's submit handler, POST and append:

```tsx
async function sendMessage(chatId: string, text: string) {
  const res = await fetch("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId, text }),
  });
  if (res.ok) {
    const { message } = await res.json();
    setChats((cs) => cs.map((c) => (c.id === chatId ? { ...c, messages: [...c.messages, message] } : c)));
  }
}
```

- [ ] **Step 4: Verify persistence**

Run: log in, post a message in `#ops-petty-cash`, refresh the page.
Expected: the message is still there after refresh. Also:

```bash
# (cookie required) confirm message row exists
curl -s -b "btech_session=<token>" localhost:3000/api/chats | grep -c "<your message text>"   # >= 1
```

- [ ] **Step 5: Commit**

```bash
git add app/api/chats app/api/messages app/ui/wallet/wallet.tsx
git commit -m "feat: persist chats and messages in sqlite, wire wallet UI"
```

---

## Task 8: Approvals + live signing persistence and UI wiring

**Files:**
- Create: `app/api/approvals/route.ts`, `app/api/approvals/[id]/sign/route.ts`
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Consumes: `getDb`, `getSessionUser`, `runDemo` (btech.ts).
- Produces (HTTP):
  - `GET /api/approvals` → `{ approvals: Approval[] }` with `signed` recomputed from `approval_signatures` and `youSigned` set for the session user.
  - `POST /api/approvals/[id]/sign` → for live approvals, runs `runDemo()` and stores the real aggregate signature under the user's npub; returns the updated `{ approval }`.

- [ ] **Step 1: Implement `GET /api/approvals`**

`app/api/approvals/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../_lib/auth";
import type { Approval } from "../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  const rows = db.prepare("SELECT id, data_json FROM approvals").all() as
    { id: string; data_json: string }[];
  const sigCount = db.prepare("SELECT COUNT(*) c FROM approval_signatures WHERE approval_id = ?");
  const mineStmt = db.prepare("SELECT 1 FROM approval_signatures WHERE approval_id = ? AND npub = ?");

  const approvals: Approval[] = rows.map((row) => {
    const a = JSON.parse(row.data_json) as Approval;
    const persistedSigs = (sigCount.get(row.id) as { c: number }).c;
    const signed = Math.max(a.signed ?? 0, persistedSigs);
    const youSigned = user ? !!mineStmt.get(row.id, user.npub) : false;
    return { ...a, signed, youSigned };
  });
  return NextResponse.json({ approvals });
}
```

- [ ] **Step 2: Implement `POST /api/approvals/[id]/sign`**

`app/api/approvals/[id]/sign/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { runDemo } from "../../../_lib/btech";
import type { Approval, SigningProof } from "../../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = db.prepare("SELECT id, data_json, is_live FROM approvals WHERE id = ?").get(id) as
    | { id: string; data_json: string; is_live: number }
    | undefined;
  if (!row) return NextResponse.json({ error: "Unknown approval" }, { status: 404 });

  const approval = JSON.parse(row.data_json) as Approval;

  let aggregate: string | null = null;
  let proof: SigningProof | undefined;
  if (row.is_live || approval.live) {
    // Live vault: run a real grouped HTSS signing round in Rust.
    const report = await runDemo();
    aggregate = report.aggregate_signature;
    proof = {
      digest: report.authorization_digest,
      signature: report.aggregate_signature,
      groupKey: report.group_xonly_public_key,
      signers: report.signers,
      verified: report.verified,
    };
  }

  db.prepare(`
    INSERT OR IGNORE INTO approval_signatures (approval_id, npub, aggregate_signature, signed_at)
    VALUES (?, ?, ?, ?)
  `).run(id, user.npub, aggregate, Date.now());

  const count = (db.prepare("SELECT COUNT(*) c FROM approval_signatures WHERE approval_id = ?").get(id) as { c: number }).c;
  const updated: Approval = {
    ...approval,
    signed: Math.max(approval.signed ?? 0, count),
    youSigned: true,
    proof: proof ?? approval.proof,
    status: count >= approval.threshold ? "ready" : approval.status,
  };
  db.prepare("UPDATE approvals SET data_json = ?, status = ? WHERE id = ?")
    .run(JSON.stringify(updated), updated.status, id);

  return NextResponse.json({ approval: updated });
}
```

- [ ] **Step 3: Mark the live approval as live in seed-time data**

The live approval (`buildLiveApproval`, id `tx1`) is created client-side, not seeded. To persist its signatures, ensure it exists as a row the first time the wallet loads. Add to `app/api/approvals/route.ts` `GET`, before reading rows:

```ts
// Ensure the live approval row exists so its signatures can persist.
db.prepare(`
  INSERT OR IGNORE INTO approvals (id, vault, kind, data_json, status, is_live, created_at)
  VALUES ('tx1', '#treasury-ops', 'send', ?, 'pending', 1, ?)
`).run(
  JSON.stringify({ id: "tx1", kind: "send", vault: "#treasury-ops", title: "Vendor payment — Blockstream", live: true, threshold: 6, total: 10, signed: 1, youSigned: false, status: "pending", policy: "1/2 + 2/3 + 3/5", time: "12m ago" }),
  Date.now(),
);
```

(The wallet UI overlays the richer `buildLiveApproval(state)` fields for display; the DB row exists solely to anchor `approval_signatures`. The `threshold`/`total`/`policy` here are the canonical 1/2+2/3+3/5 grouped policy — adjust if the live `vault_policy_groups` differ.)

- [ ] **Step 4: Wire the wallet UI to load approvals and sign via the API**

In `app/ui/wallet/wallet.tsx`:

1. Fetch approvals + current user on mount:

```tsx
const [approvals, setApprovals] = useState<Approval[]>([]);
const [me, setMe] = useState<{ npub: string; participant_id: number | null } | null>(null);
useEffect(() => {
  fetch("/api/approvals").then((r) => r.json()).then((d) => setApprovals(d.approvals ?? []));
  fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then(setMe);
}, []);
```

2. Replace the "Approve & sign" handler for any approval with:

```tsx
async function approveAndSign(id: string) {
  const res = await fetch(`/api/approvals/${id}/sign`, { method: "POST" });
  if (res.ok) {
    const { approval } = await res.json();
    setApprovals((as) => as.map((a) => (a.id === id ? approval : a)));
  }
}
```

3. Render `youSigned` / `signed` from this state (the `ApprovalCard` already takes these props). Use `me.participant_id` to label the "you" signer row.

- [ ] **Step 5: Verify the multi-signer signing demo**

Run:
1. Log in as persona #1 → open the live approval → Approve & sign → note `signed` increments and a real `proof.verified === true` is returned.
2. Log out, log in as persona #2 → Approve & sign the same approval → `signed` increments again; refresh confirms both persist.

```bash
# after signing, confirm two signature rows persisted (cookie required)
curl -s -b "btech_session=<token>" localhost:3000/api/approvals | grep -o '"signed":[0-9]*' | head
```

Expected: `signed` reflects accumulated signatures across logins/refreshes; live sign returns `verified: true`.

- [ ] **Step 6: Run the full test + typecheck + build gate**

Run:

```bash
bun run test
bun run typecheck
bun run build
```

Expected: tests pass, no type errors, production build succeeds.

- [ ] **Step 7: Commit**

```bash
git add app/api/approvals app/ui/wallet/wallet.tsx
git commit -m "feat: persist approvals and real live signatures across signers"
```

---

## Task 9: Audit log infrastructure (tables, helpers, guarded route)

**Files:**
- Modify: `app/api/_lib/db.ts` (add `audit_log` + `chat_members` tables; bump `SCHEMA_VERSION` to 2)
- Create: `app/api/_lib/audit.ts`, `app/api/_lib/audit.test.ts`, `app/api/chats/[id]/audit/route.ts`

**Interfaces:**
- Produces:
  - `recordAudit(db, { chatId, actorNpub, actorLabel, action, detail }): AuditEntry` — inserts an `audit_log` row and auto-adds the actor to `chat_members`.
  - `isMember(db, chatId, npub): boolean` — true if npub is a signer (any vault) OR in `chat_members(chatId)`.
  - `addMember(db, chatId, npub): void` — `INSERT OR IGNORE`.
  - `listAudit(db, chatId): AuditEntry[]` — newest-first.
  - `resolveChatId(db, vaultName): string` — maps an approval's vault display name (e.g. `#treasury-ops`) to a chat id (`treasury`); falls back to the input.
  - `AuditEntry = { id, chat_id, actor_npub, actor_label, action, detail, created_at }`.
  - HTTP: `GET /api/chats/[id]/audit` → 401 unauth / 403 non-member / 200 `{ entries }`.

- [ ] **Step 1: Add tables to `migrate()` and bump `SCHEMA_VERSION` to 2** in `app/api/_lib/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  actor_npub TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL,
  npub TEXT NOT NULL,
  PRIMARY KEY (chat_id, npub)
);
```

- [ ] **Step 2: Write the failing test** `app/api/_lib/audit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import { recordAudit, isMember, listAudit } from "./audit";
import { syncSigners } from "./identity";

describe("audit", () => {
  it("signers are members; observers are not", () => {
    const db = openTestDb();
    syncSigners(db, [{ participant_id: 1, label: "Alice", role: "Founder" }]);
    const signer = db.prepare("SELECT npub FROM signers LIMIT 1").get() as { npub: string };
    expect(isMember(db, "treasury", signer.npub)).toBe(true);
    expect(isMember(db, "treasury", "npub_outsider")).toBe(false);
  });

  it("records entries and auto-adds the actor as a member", () => {
    const db = openTestDb();
    recordAudit(db, { chatId: "cold", actorNpub: "npub_obs", actorLabel: "Obs", action: "message", detail: "hi" });
    expect(isMember(db, "cold", "npub_obs")).toBe(true);
    const entries = listAudit(db, "cold");
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe("message");
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `bun run test app/api/_lib/audit.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement** `app/api/_lib/audit.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { DB } from "./db";

export type AuditAction = "propose" | "sign" | "message" | "join";
export type AuditEntry = {
  id: string; chat_id: string; actor_npub: string; actor_label: string;
  action: AuditAction; detail: string | null; created_at: number;
};

export function addMember(db: DB, chatId: string, npub: string): void {
  db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, npub) VALUES (?, ?)").run(chatId, npub);
}

export function isMember(db: DB, chatId: string, npub: string): boolean {
  const signer = db.prepare("SELECT 1 FROM signers WHERE npub = ? LIMIT 1").get(npub);
  if (signer) return true;
  return !!db.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND npub = ?").get(chatId, npub);
}

export function recordAudit(
  db: DB,
  e: { chatId: string; actorNpub: string; actorLabel: string; action: AuditAction; detail?: string },
): AuditEntry {
  const entry: AuditEntry = {
    id: `a_${randomBytes(6).toString("hex")}`,
    chat_id: e.chatId, actor_npub: e.actorNpub, actor_label: e.actorLabel,
    action: e.action, detail: e.detail ?? null, created_at: Date.now(),
  };
  db.prepare(`INSERT INTO audit_log (id, chat_id, actor_npub, actor_label, action, detail, created_at)
    VALUES (@id, @chat_id, @actor_npub, @actor_label, @action, @detail, @created_at)`).run(entry);
  addMember(db, e.chatId, e.actorNpub);
  return entry;
}

export function listAudit(db: DB, chatId: string): AuditEntry[] {
  return db.prepare("SELECT * FROM audit_log WHERE chat_id = ? ORDER BY created_at DESC, id DESC")
    .all(chatId) as AuditEntry[];
}

export function resolveChatId(db: DB, vaultName: string): string {
  if (vaultName === "#treasury-ops") return "treasury";
  const row = db.prepare("SELECT id FROM chats WHERE name = ?").get(vaultName) as { id: string } | undefined;
  return row?.id ?? vaultName;
}
```

- [ ] **Step 5: Run test to verify it passes** — `bun run test app/api/_lib/audit.test.ts` → PASS (2 tests).

- [ ] **Step 6: Implement the guarded route** `app/api/chats/[id]/audit/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { isMember, listAudit } from "../../../_lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isMember(db, id, user.npub)) {
    return NextResponse.json({ error: "Restricted to vault members" }, { status: 403 });
  }
  return NextResponse.json({ entries: listAudit(db, id) });
}
```

- [ ] **Step 7: Commit**

```bash
git add app/api/_lib/db.ts app/api/_lib/audit.ts app/api/_lib/audit.test.ts app/api/chats/[id]/audit
git commit -m "feat: add per-chat audit log with member-only visibility"
```

> **Recording hooks (folded into Tasks 7 & 8):**
> - Task 7 `POST /api/messages`: after insert, `recordAudit(db, { chatId, actorNpub: user.npub, actorLabel: user.label, action: "message", detail: text.slice(0,80) })`.
> - Task 8 `POST /api/approvals` (propose): `recordAudit(..., action: "propose", detail: approval.title)` against `resolveChatId(db, approval.vault)`.
> - Task 8 `POST /api/approvals/[id]/sign`: `recordAudit(..., action: "sign", detail: aggregate ? "live HTSS aggregate" : approval.title)` against `resolveChatId(db, approval.vault)`.

## Task 10: Audit panel in the chat UI

**Files:**
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Consumes: `GET /api/chats/[id]/audit` (200 entries | 403 restricted).

- [ ] **Step 1:** Add per-chat audit state + fetch when a chat is opened:

```tsx
const [audit, setAudit] = useState<{ entries?: AuditEntryUI[]; restricted?: boolean }>({});
useEffect(() => {
  if (!activeChatId) return;
  fetch(`/api/chats/${activeChatId}/audit`).then(async (r) => {
    if (r.status === 403) return setAudit({ restricted: true });
    if (!r.ok) return setAudit({});
    setAudit({ entries: (await r.json()).entries });
  });
}, [activeChatId]);
```

where `type AuditEntryUI = { id: string; actor_label: string; action: string; detail: string | null; created_at: number }`.

- [ ] **Step 2:** Render an **Audit** section in the open chat: a compact list of
`{actor_label} {action} {detail}` rows with a relative time. If `audit.restricted`,
render "Audit log restricted to vault members" instead. Action labels must not rely
on color alone (per `PRODUCT.md`) — prefix with a glyph (e.g. `✓ signed`,
`◆ proposed`, `· message`).

- [ ] **Step 3: Verify** — as a signer, open `#treasury-ops`, propose+sign, see
the audit rows appear; refresh persists them. Log in with a random nsec (Observer)
and open the same vault → "restricted to vault members".

```bash
# member sees entries (cookie = signer session)
curl -s -b "btech_session=<signer-token>" localhost:3000/api/chats/treasury/audit | head -c 200; echo
# outsider blocked
curl -s -o /dev/null -w "observer -> HTTP %{http_code}\n" -b "btech_session=<observer-token>" localhost:3000/api/chats/treasury/audit
```

Expected: signer 200 with entries; observer 403.

- [ ] **Step 4: Commit**

```bash
git add app/ui/wallet/wallet.tsx
git commit -m "feat: show member-only audit log panel in each chat"
```

## Self-Review

**Spec coverage:**
- §3 identity / 3 login paths → Task 2 (npub helpers) + Task 6 (NIP-07, nsec, personas UI). ✓
- §4 session (login/logout/me, cookie, middleware) → Tasks 3, 4, 5. ✓
- §5 SQLite schema + singleton + idempotent seed → Task 1. ✓
- §6 data flow (live crypto stays Rust; signatures accumulate; mock vaults mutable) → Tasks 7, 8. ✓
- §7 file layout → matches Tasks 1–8 (middleware at root corrected). ✓
- §8 demo flow → verified in Task 6 Step 3, Task 7 Step 4, Task 8 Step 5. ✓
- §9 non-goals respected (no Rust edits, no realtime, nsec verify optional). ✓
- §10 risks: globalThis cache (Task 1 Step 7), `INSERT OR IGNORE` + schema_meta idempotency (Task 1), unknown npub → observer (Task 4 Step 2), native-module risk (call out below). ✓
- §11 testing → vitest unit tests (Tasks 1–3) + curl smokes + manual flow. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code; commands have expected output. The only intentional human-substituted tokens are `<token>` (a runtime session cookie) and `<your message text>` in verification curls — these are runtime values, not plan gaps.

**Type consistency:** API responses use `Chat`, `ChatMessage`, `Approval`, `SigningProof` exactly as defined in `app/ui/wallet/types.ts`. `getDb`/`openTestDb`/`migrate`/`seed`, `deterministicNpub`/`syncSigners`/`listSigners`/`normalizeNpub`, `createSession`/`getSessionUser`/`deleteSession`/`SESSION_COOKIE`/`SESSION_TTL_MS` are named identically across producing and consuming tasks. ✓

**Known risk to watch during execution:** `better-sqlite3` is a native addon. If `bun add` doesn't fetch a prebuilt for darwin/arm64, either run `bun pm trust better-sqlite3` (allow its postinstall build) or fall back to `@libsql/client` (swap `new Database(...)` for libSQL's client and adjust the `.prepare().run/get/all` calls). Verify with the Task 1 test before building further.
