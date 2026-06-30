# Wire Crypto Subledger Into the Live App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-built, headless crypto accounting subledger reachable from the running BTech app — its `sl_*` schema provisioned in the live database, and authenticated HTTP routes to ingest events, seed prices, run reconciliation, and read the §9 outputs.

**Architecture:** Keep the engine untouched and pure. Add one thin glue lib (`subledger-api.ts`) that maps request payloads to the engine's `index.ts` functions and is fully unit-tested. Add four Next.js route handlers that do only auth + parse + delegate + respond. Provision the subledger schema by extending the app's existing `getDb()` so the `sl_*` tables live alongside the treasury tables in the same `data/btech.db`.

**Tech Stack:** Next.js 16 (App Router, Node runtime), React 19, TypeScript, `bun`, `better-sqlite3`, `vitest`. Subledger engine at `app/api/_lib/subledger/` (public surface `index.ts`).

## Global Constraints

- Route handlers MUST declare `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"` (native `better-sqlite3` needs node; data is request-time).
- Every subledger route MUST require a valid session: read `SESSION_COOKIE` via `next/headers` `cookies()`, resolve with `getSessionUser(db, token)`, and return `NextResponse.json({ error: "Unauthorized" }, { status: 401 })` when absent.
- The engine is the only place accounting logic lives. Glue code MUST NOT compute amounts, classify, or post — it only calls `index.ts` functions. No `number` math on money anywhere.
- Subledger persistence stays in the `sl_*` table namespace; never read/write treasury tables from subledger code.
- Functional currency is TWD; standard is IFRS/TIFRS. No behavioral change to the engine in this plan.
- TypeScript target is ES2017: use the `BigInt()` constructor, never `1n` literals (only relevant if any test touches money).
- Tests live at `app/**/*.test.ts` (vitest `include`). Helper files that are not tests MUST NOT end in `.test.ts`.

---

### Task 1: Provision the subledger schema in the live database

**Files:**
- Modify: `app/api/_lib/db.ts` (the `getDb()` function, ~lines 191-200)
- Test: `app/api/_lib/db.test.ts`

**Interfaces:**
- Consumes: `migrateSubledger(db: DB): void`, `seedConfig(db: DB): void` from `app/api/_lib/subledger` (already exported by `index.ts`).
- Produces: `getDb()` returns a `better-sqlite3` database that now also contains all `sl_*` tables, with `sl_config` seeded.

- [ ] **Step 1: Write the failing test**

Add to `app/api/_lib/db.test.ts` (add the two imports at the top of the file alongside the existing imports, then the test inside the `describe("db", ...)` block):

```typescript
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";

it("getDb() provisions the subledger sl_* schema in the app database", () => {
  const tmp = path.join(os.tmpdir(), `btech-sl-test-${process.pid}.db`);
  // force a fresh, file-backed db (getDb caches on globalThis)
  (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined;
  const prev = process.env.BTECH_DB;
  process.env.BTECH_DB = tmp;
  try {
    const db = getDb();
    const cfg = db.prepare("SELECT classification FROM sl_config WHERE asset='BTC'").get() as
      | { classification: string }
      | undefined;
    expect(cfg?.classification).toBe("INTANGIBLE_IAS38");
    // treasury tables still present alongside sl_* tables
    const chats = db.prepare("SELECT COUNT(*) c FROM chats").get() as { c: number };
    expect(chats.c).toBeGreaterThanOrEqual(0);
    db.close();
  } finally {
    (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined;
    if (prev === undefined) delete process.env.BTECH_DB;
    else process.env.BTECH_DB = prev;
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test app/api/_lib/db.test.ts`
Expected: FAIL — `no such table: sl_config` (getDb does not yet migrate the subledger).

- [ ] **Step 3: Write minimal implementation**

In `app/api/_lib/db.ts`, add the import near the other imports at the top:

```typescript
import { migrateSubledger, seedConfig } from "./subledger";
```

Then in `getDb()`, add the two calls right after `seed(db);`:

```typescript
export function getDb(): DB {
  if (globalThis.__btechDb) return globalThis.__btechDb;
  const file = process.env.BTECH_DB ?? path.join(process.cwd(), "data", "btech.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  migrate(db);
  seed(db);
  migrateSubledger(db);
  seedConfig(db);
  globalThis.__btechDb = db;
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test app/api/_lib/db.test.ts`
Expected: PASS (all db tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add app/api/_lib/db.ts app/api/_lib/db.test.ts
git commit -m "feat(subledger): provision sl_* schema in the live app database"
```

---

### Task 2: Glue lib mapping requests to the engine

**Files:**
- Create: `app/api/_lib/subledger-api.ts`
- Test: `app/api/_lib/subledger-api.test.ts`

**Interfaces:**
- Consumes from `app/api/_lib/subledger`: `ingest`, `runReconcile`, `insertPrice`, `journalRows`, `positions`, `pnlDetail`, `lotDisposals`, `reconciliationRows`, `exceptions`, `disclosures`, `auditPack`, and types `DB`, `SubledgerEvent`, `PricePoint`, `IngestResult`.
- Produces:
  - `seedPrices(db: DB, prices: PricePoint[]): number` — returns count written.
  - `ingestEvents(db: DB, events: SubledgerEvent[]): IngestResult[]`
  - `getOutput(db: DB, kind: string, period?: string): unknown` — throws `Error` on unknown kind or missing `period` for `audit_pack`.
  - `runPeriodReconcile(db: DB, period: string, chainBalances: Record<string, string>): unknown`

- [ ] **Step 1: Write the failing test**

Create `app/api/_lib/subledger-api.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

import { seedPrices, ingestEvents, getOutput, runPeriodReconcile } from "./subledger-api";
import { openTestSubledgerDb, type DB } from "./subledger";
import type { PricePoint, SubledgerEvent } from "./subledger";

const PRICES: PricePoint[] = [
  { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" },
];
const BUY: SubledgerEvent = {
  event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1",
};

function ready(): DB {
  const db = openTestSubledgerDb();
  seedPrices(db, PRICES);
  ingestEvents(db, [BUY]);
  return db;
}

describe("subledger-api", () => {
  it("seedPrices writes PricePoints and returns the count", () => {
    const db = openTestSubledgerDb();
    expect(seedPrices(db, PRICES)).toBe(1);
  });

  it("ingestEvents posts valid events and reports per-event results", () => {
    const db = openTestSubledgerDb();
    seedPrices(db, PRICES);
    const [r] = ingestEvents(db, [BUY]);
    expect(r.posted).toBe(true);
  });

  it("getOutput dispatches each output kind", () => {
    const db = ready();
    expect(Array.isArray(getOutput(db, "journal"))).toBe(true);
    expect(Array.isArray(getOutput(db, "positions"))).toBe(true);
    expect(getOutput(db, "disclosures")).toHaveProperty("fx_lock_note");
    const pack = getOutput(db, "audit_pack", "2026-06") as { policy_version: string };
    expect(pack.policy_version).toBe("2026-06-29");
  });

  it("getOutput throws on an unknown kind and on audit_pack without a period", () => {
    const db = ready();
    expect(() => getOutput(db, "nope")).toThrow(/unknown output kind/);
    expect(() => getOutput(db, "audit_pack")).toThrow(/period/);
  });

  it("runPeriodReconcile returns a per-asset tie/break result", () => {
    const db = ready();
    const res = runPeriodReconcile(db, "2026-06", { BTC: "1" }) as { asset: string; status: string }[];
    expect(res.find((r) => r.asset === "BTC")?.status).toBe("tie");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test app/api/_lib/subledger-api.test.ts`
Expected: FAIL — `Cannot find module './subledger-api'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/api/_lib/subledger-api.ts`:

```typescript
// subledger-api.ts — request->engine glue. Holds NO accounting logic; it only
// maps payloads to the engine's public functions (index.ts). Pure and testable;
// the route handlers add auth and (de)serialization around these.

import {
  ingest,
  runReconcile,
  insertPrice,
  journalRows,
  positions,
  pnlDetail,
  lotDisposals,
  reconciliationRows,
  exceptions,
  disclosures,
  auditPack,
  type DB,
  type SubledgerEvent,
  type PricePoint,
  type IngestResult,
} from "./subledger";

export function seedPrices(db: DB, prices: PricePoint[]): number {
  for (const p of prices) insertPrice(db, p);
  return prices.length;
}

export function ingestEvents(db: DB, events: SubledgerEvent[]): IngestResult[] {
  return events.map((e) => ingest(db, e));
}

export function getOutput(db: DB, kind: string, period?: string): unknown {
  switch (kind) {
    case "journal":
      return journalRows(db);
    case "positions":
      return positions(db);
    case "pnl":
      return pnlDetail(db);
    case "lot_disposal":
      return lotDisposals(db);
    case "reconciliation":
      return reconciliationRows(db);
    case "exceptions":
      return exceptions(db);
    case "disclosures":
      return disclosures(db);
    case "audit_pack":
      if (!period) throw new Error("audit_pack requires a ?period=YYYY-MM query parameter");
      return auditPack(db, period);
    default:
      throw new Error(`unknown output kind: ${kind}`);
  }
}

export function runPeriodReconcile(
  db: DB,
  period: string,
  chainBalances: Record<string, string>,
): unknown {
  return runReconcile(db, period, chainBalances);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test app/api/_lib/subledger-api.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/_lib/subledger-api.ts app/api/_lib/subledger-api.test.ts
git commit -m "feat(subledger): request->engine glue lib (seed/ingest/outputs/reconcile)"
```

---

### Task 3: Route test harness + the prices route

**Files:**
- Create: `app/api/subledger/_test-helpers.ts` (shared by all route tests; NOT a `.test.ts`)
- Create: `app/api/subledger/prices/route.ts`
- Test: `app/api/subledger/prices/route.test.ts`

**Interfaces:**
- Consumes: `seedPrices` (Task 2); `getDb` from `app/api/_lib/db`; `getSessionUser`, `SESSION_COOKIE` from `app/api/_lib/auth`.
- Produces:
  - Helper `installTestDb(token?: string): void` — builds an in-memory db with treasury + subledger schema and a user/session, assigns it to `globalThis.__btechDb` so `getDb()` returns it.
  - Helper `clearTestDb(): void` — resets `globalThis.__btechDb`.
  - `POST /api/subledger/prices` — body `{ prices: PricePoint[] }` → `{ count: number }`; 401 without a session.

- [ ] **Step 1: Write the failing test**

Create the shared helper `app/api/subledger/_test-helpers.ts`:

```typescript
// _test-helpers.ts — installs an in-memory app+subledger db (with a session)
// onto globalThis so route handlers' getDb() returns it. Not a vitest file.

import Database from "better-sqlite3";

import { migrate, seed } from "../_lib/db";
import { migrateSubledger, seedConfig } from "../_lib/subledger";

export const TEST_TOKEN = "test-token";

export function installTestDb(token: string = TEST_TOKEN): void {
  const db = new Database(":memory:");
  migrate(db);
  seed(db);
  migrateSubledger(db);
  seedConfig(db);
  db.prepare("INSERT INTO users (npub, label, role, created_at) VALUES (?, ?, ?, ?)").run(
    "npub-test",
    "Tester",
    "operator",
    0,
  );
  db.prepare("INSERT INTO sessions (token, npub, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token,
    "npub-test",
    0,
    4102444800000, // year 2100
  );
  (globalThis as unknown as { __btechDb?: unknown }).__btechDb = db;
}

export function clearTestDb(): void {
  (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined;
}
```

Create `app/api/subledger/prices/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installTestDb, clearTestDb, TEST_TOKEN } from "../_test-helpers";

// Controllable cookie value (vi.hoisted so the mock factory can read it).
const h = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}));

import { POST } from "./route";

const body = { prices: [{ asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" }] };
const req = () => new Request("http://x/api/subledger/prices", { method: "POST", body: JSON.stringify(body) });

describe("POST /api/subledger/prices", () => {
  beforeEach(() => installTestDb());
  afterEach(() => clearTestDb());

  it("seeds prices for an authenticated user", async () => {
    h.token = TEST_TOKEN;
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(1);
  });

  it("rejects an unauthenticated request with 401", async () => {
    h.token = undefined;
    const res = await POST(req());
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test app/api/subledger/prices/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/api/subledger/prices/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../_lib/auth";
import { seedPrices } from "../../_lib/subledger-api";
import type { PricePoint } from "../../_lib/subledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { prices?: PricePoint[] };
  const count = seedPrices(db, body.prices ?? []);
  return NextResponse.json({ count });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test app/api/subledger/prices/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/subledger/_test-helpers.ts app/api/subledger/prices/route.ts app/api/subledger/prices/route.test.ts
git commit -m "feat(subledger): POST /api/subledger/prices (auth-gated price seed)"
```

---

### Task 4: Ingest route

**Files:**
- Create: `app/api/subledger/ingest/route.ts`
- Test: `app/api/subledger/ingest/route.test.ts`

**Interfaces:**
- Consumes: `ingestEvents` (Task 2); the auth + `getDb` pattern (Task 3).
- Produces: `POST /api/subledger/ingest` — body `{ events: SubledgerEvent[] }` → `{ results: IngestResult[] }`; 401 without a session.

- [ ] **Step 1: Write the failing test**

Create `app/api/subledger/ingest/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installTestDb, clearTestDb, TEST_TOKEN } from "../_test-helpers";
import { seedPrices } from "../../_lib/subledger-api";

const h = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}));

import { POST } from "./route";

const events = [{ event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" }];
const req = () => new Request("http://x/api/subledger/ingest", { method: "POST", body: JSON.stringify({ events }) });

describe("POST /api/subledger/ingest", () => {
  beforeEach(() => {
    installTestDb();
    seedPrices((globalThis as unknown as { __btechDb: import("../../_lib/subledger").DB }).__btechDb, [
      { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" },
    ]);
  });
  afterEach(() => clearTestDb());

  it("ingests events and returns per-event results", async () => {
    h.token = TEST_TOKEN;
    const res = await POST(req());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: { posted: boolean }[] };
    expect(json.results[0].posted).toBe(true);
  });

  it("rejects an unauthenticated request with 401", async () => {
    h.token = undefined;
    expect((await POST(req())).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test app/api/subledger/ingest/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/api/subledger/ingest/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../_lib/auth";
import { ingestEvents } from "../../_lib/subledger-api";
import type { SubledgerEvent } from "../../_lib/subledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { events?: SubledgerEvent[] };
  const results = ingestEvents(db, body.events ?? []);
  return NextResponse.json({ results });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test app/api/subledger/ingest/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/subledger/ingest/route.ts app/api/subledger/ingest/route.test.ts
git commit -m "feat(subledger): POST /api/subledger/ingest (auth-gated event ingest)"
```

---

### Task 5: Outputs route (`/outputs/[kind]`)

**Files:**
- Create: `app/api/subledger/outputs/[kind]/route.ts`
- Test: `app/api/subledger/outputs/[kind]/route.test.ts`

**Interfaces:**
- Consumes: `getOutput` (Task 2); `ingestEvents`/`seedPrices` to set up data; auth pattern (Task 3). Dynamic route param: `context: { params: Promise<{ kind: string }> }`, read via `await context.params` (matches `app/api/chain/address/[addr]/route.ts`).
- Produces: `GET /api/subledger/outputs/:kind?period=YYYY-MM` → `{ kind, data }`; `400` on unknown kind or missing period for `audit_pack`; `401` without a session.

- [ ] **Step 1: Write the failing test**

Create `app/api/subledger/outputs/[kind]/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installTestDb, clearTestDb, TEST_TOKEN } from "../../_test-helpers";
import { seedPrices, ingestEvents } from "../../../_lib/subledger-api";
import type { DB } from "../../../_lib/subledger";

const h = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}));

import { GET } from "./route";

const db = () => (globalThis as unknown as { __btechDb: DB }).__btechDb;
const ctx = (kind: string) => ({ params: Promise.resolve({ kind }) });
const get = (kind: string, qs = "") =>
  GET(new Request(`http://x/api/subledger/outputs/${kind}${qs}`), ctx(kind));

describe("GET /api/subledger/outputs/[kind]", () => {
  beforeEach(() => {
    installTestDb();
    seedPrices(db(), [{ asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" }]);
    ingestEvents(db(), [{ event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" }]);
    h.token = TEST_TOKEN;
  });
  afterEach(() => clearTestDb());

  it("returns journal rows", async () => {
    const res = await get("journal");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string; data: unknown[] };
    expect(json.kind).toBe("journal");
    expect(json.data.length).toBeGreaterThan(0);
  });

  it("returns 400 for an unknown kind", async () => {
    expect((await get("nope")).status).toBe(400);
  });

  it("returns 401 without a session", async () => {
    h.token = undefined;
    expect((await get("journal")).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test "app/api/subledger/outputs/[kind]/route.test.ts"`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/api/subledger/outputs/[kind]/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { getOutput } from "../../../_lib/subledger-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ kind: string }> }) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { kind } = await context.params;
  const period = new URL(req.url).searchParams.get("period") ?? undefined;
  try {
    return NextResponse.json({ kind, data: getOutput(db, kind, period) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "bad output request" },
      { status: 400 },
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test "app/api/subledger/outputs/[kind]/route.test.ts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add "app/api/subledger/outputs/[kind]/route.ts" "app/api/subledger/outputs/[kind]/route.test.ts"
git commit -m "feat(subledger): GET /api/subledger/outputs/[kind] (auth-gated §9 outputs)"
```

---

### Task 6: Reconcile route

**Files:**
- Create: `app/api/subledger/reconcile/route.ts`
- Test: `app/api/subledger/reconcile/route.test.ts`

**Interfaces:**
- Consumes: `runPeriodReconcile` (Task 2); auth pattern (Task 3).
- Produces: `POST /api/subledger/reconcile` — body `{ period: string, chainBalances: Record<string,string> }` → `{ data: ReconResult[] }`; 401 without a session.

- [ ] **Step 1: Write the failing test**

Create `app/api/subledger/reconcile/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installTestDb, clearTestDb, TEST_TOKEN } from "../_test-helpers";
import { seedPrices, ingestEvents } from "../../_lib/subledger-api";
import type { DB } from "../../_lib/subledger";

const h = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}));

import { POST } from "./route";

const db = () => (globalThis as unknown as { __btechDb: DB }).__btechDb;
const req = () =>
  new Request("http://x/api/subledger/reconcile", {
    method: "POST",
    body: JSON.stringify({ period: "2026-06", chainBalances: { BTC: "1" } }),
  });

describe("POST /api/subledger/reconcile", () => {
  beforeEach(() => {
    installTestDb();
    seedPrices(db(), [{ asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" }]);
    ingestEvents(db(), [{ event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" }]);
  });
  afterEach(() => clearTestDb());

  it("reconciles a period and reports tie/break per asset", async () => {
    h.token = TEST_TOKEN;
    const res = await POST(req());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { asset: string; status: string }[] };
    expect(json.data.find((r) => r.asset === "BTC")?.status).toBe("tie");
  });

  it("rejects an unauthenticated request with 401", async () => {
    h.token = undefined;
    expect((await POST(req())).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test app/api/subledger/reconcile/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/api/subledger/reconcile/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../_lib/auth";
import { runPeriodReconcile } from "../../_lib/subledger-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { period?: string; chainBalances?: Record<string, string> };
  if (!body.period) return NextResponse.json({ error: "period is required" }, { status: 400 });
  const data = runPeriodReconcile(db, body.period, body.chainBalances ?? {});
  return NextResponse.json({ data });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test app/api/subledger/reconcile/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/subledger/reconcile/route.ts app/api/subledger/reconcile/route.test.ts
git commit -m "feat(subledger): POST /api/subledger/reconcile (auth-gated three-way tie)"
```

---

### Task 7: Full verification + live smoke test

**Files:** none (verification only).

- [ ] **Step 1: Full suite + typecheck**

Run: `bun run test && bun run typecheck`
Expected: all test files pass (the 58 existing subledger tests + 11 app tests + the new db/api/route tests); `tsc --noEmit` exit 0.

- [ ] **Step 2: Live smoke test against `next dev`**

Start the app in one shell: `bun run dev` (serves http://localhost:3000). In another shell, log in through the UI with a demo persona, copy the `btech_session` cookie value, then exercise the routes (replace `<COOKIE>`):

```bash
C='Cookie: btech_session=<COOKIE>'
# 401 when unauthenticated
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/subledger/outputs/journal   # expect 401

# seed a price, ingest a BUY, read journal, reconcile
curl -s -H "$C" -H 'Content-Type: application/json' -X POST http://localhost:3000/api/subledger/prices \
  -d '{"prices":[{"asset":"BTC","date":"2026-06-01","source":"live","market":"CB","price_usd":"60000","usd_twd_rate":"31.25"}]}'   # {"count":1}
curl -s -H "$C" -H 'Content-Type: application/json' -X POST http://localhost:3000/api/subledger/ingest \
  -d '{"events":[{"event_id":"smoke-b1","type":"BUY","timestamp":"2026-06-01T10:00:00Z","wallet_id":"treasury","asset":"BTC","qty":"1"}]}'   # results[0].posted == true
curl -s -H "$C" http://localhost:3000/api/subledger/outputs/journal | head -c 300   # balanced DR/CR lines
curl -s -H "$C" -H 'Content-Type: application/json' -X POST http://localhost:3000/api/subledger/reconcile \
  -d '{"period":"2026-06","chainBalances":{"BTC":"1"}}'   # data[].status == "tie"
```

Expected: the unauthenticated call returns `401`; the authenticated calls return the JSON shapes noted in the comments; the journal is balanced; reconcile reports `tie`.

> NOTE: events ingested here persist in `data/btech.db`. To reset the demo, stop the app and `rm data/btech.db data/btech.db-wal data/btech.db-shm` (the app re-seeds on next start).

- [ ] **Step 3: Final commit (if any verification fixes were needed)**

```bash
git add -A && git commit -m "test(subledger): verify live wiring (suite + typecheck + smoke)"
```

---

## Self-Review

**Spec coverage** (the two reachable-increment steps from the conversation):
- DB hookup (`getDb()` provisions `sl_*`): Task 1.
- Routes calling `index.ts`: prices (Task 3), ingest (Task 4), outputs (Task 5), reconcile (Task 6); logic centralized + tested in Task 2.
- Auth required on every route: enforced in Tasks 3-6, asserted by the 401 tests.
- Prices seeded via a route (chosen option): Task 3.
- Out of scope by decision: BTech→Event adapter and any UI page (not in this plan).

**Placeholder scan:** none — every step has full code and exact commands.

**Type consistency:** glue signatures defined in Task 2 (`seedPrices`/`ingestEvents`/`getOutput`/`runPeriodReconcile`) are the exact names imported by Tasks 3-6; helper names (`installTestDb`/`clearTestDb`/`TEST_TOKEN`) defined in Task 3 are reused verbatim; dynamic-param signature (`context: { params: Promise<{ kind: string }> }`) matches the existing `[addr]` route.
