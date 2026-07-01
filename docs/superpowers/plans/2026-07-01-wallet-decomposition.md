# Wallet Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the 2135-line `app/ui/wallet/wallet.tsx` god-file into well-bounded components + hooks + a typed API client, and move data aggregation + protocol derivation to the backend, with zero user-visible behavior change.

**Architecture:** Incremental in-place decomposition of `app/ui/wallet/`: add `components/`, `hooks/`, `lib/` subdirs; extract shared theme/helpers first (foundation), then components leaf→panel, then a server aggregation endpoint, then hooks + a typed api-client that slim `wallet.tsx` to an orchestrator. Each task is `tsc`-clean, keeps tests green, and leaves the app runnable.

**Tech Stack:** Next.js 16 + React 19, TypeScript, Bun, Vitest. Silent-payment + NIP-44 crypto (`@noble/*`, `nostr-tools`) unchanged.

## Global Constraints

- Package manager **Bun**. Tests: **`bun run test`** (→ `vitest run`), NOT `bun test`. Typecheck: **`bun run typecheck`**.
- **Behavior-preserving:** extractions relocate existing code verbatim (same JSX, same logic) — only the file location + import wiring changes. No feature/visual changes.
- **Convention for extraction steps:** the plan names the exact symbols to move, the target file, what it must import, and how `wallet.tsx` re-imports it. Do NOT rewrite the moved code — cut it, paste it, wire imports. Locate symbols by NAME (grep), not absolute line numbers — line numbers shift as earlier tasks remove code.
- **Keep client-side (do NOT move server-side):** NIP-44 encrypt/decrypt (`nostr-signer.ts`), the Nostr relay connection (`nostr-chat.ts`), and `relTime` (must tick with the wall clock).
- **Activity stays its own endpoint** (`/api/chain/activity`); the new overview endpoint does NOT fold it in.
- Shared color palette `C`, fonts `MONO`/`SANS`, and `inputStyle` live in `app/ui/wallet/lib/theme.ts` after Task 1; every extracted component imports from there.
- Verification gate for EVERY task: `bun run typecheck` clean + full `bun run test` green (baseline: 166 tests; tasks add tests). Extraction tasks add no behavior tests — `tsc` + the existing suites are their gate; the browser smoke (Task 8) is the end-to-end regression gate.
- Commit after every task; message ends with:
  `Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4`

---

## File Structure (created in this plan)

- `app/ui/wallet/lib/theme.ts` — `C`, `MONO`, `SANS`, `inputStyle` (**create**, Task 1)
- `app/ui/wallet/lib/format.ts` — `fmtBtc`, `relTime`, `initialsOf`, `shortHex` (**create**, Task 2)
- `app/ui/wallet/lib/policy.ts` — `clampNeed`, `quorumOf`, `spendOf`, `chatToPolicyConfig` (**create**, Task 2; client-safe pure fns, also imported by the server route)
- `app/ui/wallet/lib/format.test.ts`, `app/ui/wallet/lib/policy.test.ts` (**create**, Task 2)
- `app/ui/wallet/components/{stat,tab-button,address-chip,field,live-vault-card,vault-balance}.tsx` (**create**, Task 3)
- `app/ui/wallet/components/{sidebar,overview,approvals,ongoing-proposals,audit-panel,vault-panel,plan}.tsx` (**create**, Task 4)
- `app/ui/wallet/components/{chat-detail,send-form}.tsx` (**create**, Task 5)
- `app/api/wallet/overview/route.ts` (**create**, Task 6) + `app/api/wallet/overview/route.test.ts` (**create**, Task 6)
- `app/ui/wallet/lib/api-client.ts` (**create**, Task 7)
- `app/ui/wallet/hooks/{use-session,use-chats,use-approvals,use-audit,use-wallet-overview}.ts` (**create**, Task 7)
- `app/ui/wallet/wallet.tsx` — slimmed to an orchestrator (**modify**, Tasks 1–7)

---

## Task 1: Extract shared theme + local types (foundation)

Everything depends on `C`/`MONO`/`SANS`/`inputStyle`, so extract them first.

**Files:**
- Create: `app/ui/wallet/lib/theme.ts`
- Modify: `app/ui/wallet/wallet.tsx`
- Modify: `app/ui/wallet/types.ts` (add shared local types)

**Interfaces:**
- Produces: `export const C`, `export const MONO`, `export const SANS`, `export const inputStyle: CSSProperties` from `./lib/theme`; and `View`, `Tab`, `AuditEntryUI`, `ActivityApiEntry`, `ActivityRow` exported from `./types`.

- [ ] **Step 1: Create `app/ui/wallet/lib/theme.ts`**

Move the `C` object (currently `wallet.tsx` ~line 25), `MONO`, `SANS` (~42–43), and `inputStyle` (`const inputStyle: CSSProperties = {…}`, ~line 2043) into a new file, exported:
```ts
import type { CSSProperties } from "react";

export const C = { /* …exact object moved from wallet.tsx… */ } as const;
export const MONO = "'JetBrains Mono', monospace";
export const SANS = "'Space Grotesk', system-ui, sans-serif";
export const inputStyle: CSSProperties = { /* …exact object moved from wallet.tsx… */ };
```
(Copy the `C` and `inputStyle` object bodies verbatim from `wallet.tsx` — do not retype the values.)

- [ ] **Step 2: Move the shared local types into `types.ts`**

Cut `type View`, `type Tab`, `type AuditEntryUI`, `type ActivityApiEntry`, `type ActivityRow` from `wallet.tsx` and add them to `app/ui/wallet/types.ts` as `export type …` (verbatim bodies).

- [ ] **Step 3: Rewire `wallet.tsx` imports**

Delete the moved `C`/`MONO`/`SANS`/`inputStyle` definitions and the moved types from `wallet.tsx`. Add:
```ts
import { C, MONO, SANS, inputStyle } from "./lib/theme";
```
and add `View, Tab, AuditEntryUI, ActivityApiEntry, ActivityRow` to the existing `import type { … } from "./types";`.

- [ ] **Step 4: Typecheck + tests**

Run: `bun run typecheck` → clean. Run: `bun run test` → 166 passing.
(If `tsc` reports `C`/`inputStyle` used before the import, or a duplicate type, fix the import/removal.)

- [ ] **Step 5: Commit**

```bash
git add app/ui/wallet/lib/theme.ts app/ui/wallet/types.ts app/ui/wallet/wallet.tsx
git commit -m "refactor(wallet): extract shared theme + local types

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 2: Extract pure helpers (format + policy) with tests

**Files:**
- Create: `app/ui/wallet/lib/format.ts`, `app/ui/wallet/lib/format.test.ts`
- Create: `app/ui/wallet/lib/policy.ts`, `app/ui/wallet/lib/policy.test.ts`
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Produces from `./lib/format`: `fmtBtc(sats: number): string`, `relTime(unixSec: number | null): string`, `initialsOf(label: string): string`, `shortHex(hex: string): string`.
- Produces from `./lib/policy`: `clampNeed(t: Tier): number`, `quorumOf(tiers: Tier[]): string`, `spendOf(tiers: Tier[]): string`, `chatToPolicyConfig(chat: Chat, roster: { npub: string; label: string; participantId: number }[]): PolicyConfig`.

- [ ] **Step 1: Write the failing tests**

Create `app/ui/wallet/lib/format.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { fmtBtc, initialsOf, shortHex } from "./format";

describe("format", () => {
  it("fmtBtc renders sats as BTC", () => {
    expect(fmtBtc(100_000_000)).toBe("1.00000000");
    expect(fmtBtc(0)).toBe("0.00000000");
  });
  it("initialsOf takes up to two word-initials, uppercased", () => {
    expect(initialsOf("Alice Founder")).toBe("AF");
    expect(initialsOf("bob")).toBe("B");
  });
  it("shortHex abbreviates a long hex", () => {
    const h = "ab".repeat(20);
    expect(shortHex(h).length).toBeLessThan(h.length);
    expect(shortHex(h).startsWith("ab")).toBe(true);
  });
});
```
Create `app/ui/wallet/lib/policy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { clampNeed, quorumOf, spendOf } from "./policy";
import type { Tier } from "../types";

const tier = (short: string, minNeed: number, keyCount: number): Tier => ({
  id: short, name: short, short, minNeed,
  keys: Array.from({ length: keyCount }, (_, i) => ({ id: `${short}${i}`, name: `k${i}` })) as Tier["keys"],
});

describe("policy", () => {
  it("clampNeed clamps to [1, keys.length]", () => {
    expect(clampNeed(tier("C", 5, 3))).toBe(3);
    expect(clampNeed(tier("C", 0, 3))).toBe(1);
    expect(clampNeed(tier("C", 2, 3))).toBe(2);
  });
  it("quorumOf joins per-tier need/total", () => {
    expect(quorumOf([tier("C", 1, 2), tier("M", 2, 3)])).toBe("1/2 + 2/3");
  });
  it("spendOf renders the AND policy string", () => {
    expect(spendOf([tier("C", 1, 2)])).toBe("spend = (1 of 2 C)");
  });
});
```

- [ ] **Step 2: Run the tests → expect fail (modules missing)**

Run: `bun run test app/ui/wallet/lib/format.test.ts app/ui/wallet/lib/policy.test.ts`
Expected: FAIL — cannot resolve `./format` / `./policy`.

- [ ] **Step 3: Create the modules by moving the helper bodies**

Create `app/ui/wallet/lib/format.ts` — move `fmtBtc`, `relTime`, `initialsOf`, `shortHex` verbatim from `wallet.tsx`, each as `export function`.
Create `app/ui/wallet/lib/policy.ts` — move `clampNeed`, `quorumOf`, `spendOf`, `chatToPolicyConfig` verbatim from `wallet.tsx`, each as `export function`; add `import type { Chat, PolicyConfig, Tier } from "../types";`.

- [ ] **Step 4: Rewire `wallet.tsx`**

Delete the moved helper definitions from `wallet.tsx`. Add:
```ts
import { fmtBtc, relTime, initialsOf, shortHex } from "./lib/format";
import { clampNeed, quorumOf, spendOf, chatToPolicyConfig } from "./lib/policy";
```
(`challengeTemplate` stays in `wallet.tsx` — it's login-flow-specific, not a shared util.)

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run test app/ui/wallet/lib/format.test.ts app/ui/wallet/lib/policy.test.ts` → PASS.
Run: `bun run typecheck` → clean. Run: `bun run test` → 172 passing (166 + 6 new).

- [ ] **Step 6: Commit**

```bash
git add app/ui/wallet/lib/format.ts app/ui/wallet/lib/format.test.ts app/ui/wallet/lib/policy.ts app/ui/wallet/lib/policy.test.ts app/ui/wallet/wallet.tsx
git commit -m "refactor(wallet): extract pure format + policy helpers with tests

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 3: Extract leaf components

Small presentational components with simple props. Extract each to its own file under `components/`.

**Files:**
- Create: `app/ui/wallet/components/stat.tsx` (`Stat`), `tab-button.tsx` (`TabButton`), `address-chip.tsx` (`AddressChip` + `MetaAddressChip`), `field.tsx` (`Field`), `live-vault-card.tsx` (`LiveVaultCard`), `vault-balance.tsx` (`VaultBalance`)
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Produces (exact prop shapes taken from current usage in `wallet.tsx`):
  - `Stat({ label, value, color }: { label: string; value: string; color?: string })`
  - `TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number })`
  - `AddressChip({ address }: { address: string })`, `MetaAddressChip()` (no props; fetches `/api/stealth`)
  - `Field({ label, children }: { label: string; children: React.ReactNode })`
  - `LiveVaultCard({ wstate }: { wstate: WalletState })`
  - `VaultBalance({ address }: { address: string })`

- [ ] **Step 1: Extract each component to its file**

For each component above: cut its function from `wallet.tsx` into the named file with `"use client";` at the top (these use hooks/`fetch`), `export function <Name>`, and import what it references — `{ C, MONO, inputStyle }` from `../lib/theme`, `fmtBtc`/`shortHex` from `../lib/format` as needed, and types from `../types`. `MetaAddressChip`/`VaultBalance`/`AddressChip` use `useState`/`useEffect`/`fetch` — keep that logic verbatim. `shortHex` currently sits between components in `wallet.tsx`; it already moved to `lib/format` in Task 2, so import it.

- [ ] **Step 2: Rewire `wallet.tsx`**

Delete the moved functions. Add imports:
```ts
import { Stat } from "./components/stat";
import { TabButton } from "./components/tab-button";
import { AddressChip, MetaAddressChip } from "./components/address-chip";
import { Field } from "./components/field";
import { LiveVaultCard } from "./components/live-vault-card";
import { VaultBalance } from "./components/vault-balance";
```

- [ ] **Step 3: Typecheck + tests**

Run: `bun run typecheck` → clean (fix any missing prop-type or import). Run: `bun run test` → 172 passing.

- [ ] **Step 4: Commit**

```bash
git add app/ui/wallet/components/ app/ui/wallet/wallet.tsx
git commit -m "refactor(wallet): extract leaf presentational components

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 4: Extract panel components

**Files:**
- Create: `app/ui/wallet/components/sidebar.tsx` (`Sidebar`), `overview.tsx` (`Overview`), `approvals.tsx` (`Approvals`), `ongoing-proposals.tsx` (`OngoingProposals`), `audit-panel.tsx` (`AuditPanel`), `vault-panel.tsx` (`VaultPanel`), `plan.tsx` (`Plan`)
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Produces each panel as `export function` with a `Props` interface inferred from its current destructured params + usage in `wallet.tsx`. Each imports `{ C, MONO, SANS, inputStyle }` from `../lib/theme`, `fmtBtc`/`relTime`/`initialsOf` from `../lib/format`, `clampNeed`/`quorumOf`/`spendOf` from `../lib/policy`, leaf components from `./` (e.g. `Overview` uses `Stat`, `LiveVaultCard`, `VaultBalance`; `Approvals` uses `TabButton`, `ApprovalCard`; `VaultPanel` uses `Field`, `PolicyEditor`), and types from `../types`.

- [ ] **Step 1: Extract each panel**

Cut `Sidebar`, `Overview`, `Approvals`, `OngoingProposals`, `AuditPanel`, `VaultPanel`, `Plan` from `wallet.tsx` into their files, each with `"use client";`, an explicit `interface <Name>Props` (declare the exact props the function currently destructures, using existing types from `../types`), and the imports listed above. Move code verbatim; only add the `Props` interface + imports.

- [ ] **Step 2: Rewire `wallet.tsx`**

Delete the moved functions. Add:
```ts
import { Sidebar } from "./components/sidebar";
import { Overview } from "./components/overview";
import { Approvals } from "./components/approvals";
import { OngoingProposals } from "./components/ongoing-proposals";
import { AuditPanel } from "./components/audit-panel";
import { VaultPanel } from "./components/vault-panel";
import { Plan } from "./components/plan";
```

- [ ] **Step 3: Typecheck + tests**

Run: `bun run typecheck` → clean (resolve prop-type mismatches — the `Props` interfaces must match how `wallet.tsx` calls each panel). Run: `bun run test` → 172 passing.

- [ ] **Step 4: Commit**

```bash
git add app/ui/wallet/components/ app/ui/wallet/wallet.tsx
git commit -m "refactor(wallet): extract panel components (sidebar/overview/approvals/audit/vault/plan)

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 5: Extract ChatDetail + send-form

`ChatDetail` is the largest sub-component (~327 lines) and embeds the propose/send form. Split the form into its own component.

**Files:**
- Create: `app/ui/wallet/components/chat-detail.tsx` (`ChatDetail`), `app/ui/wallet/components/send-form.tsx` (`SendForm`)
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- Produces `ChatDetail` (`export function`) with a `ChatDetailProps` interface inferred from its current params. It imports `AddressChip`/`MetaAddressChip` from `./address-chip`, `SendForm` from `./send-form`, `OngoingProposals` from `./ongoing-proposals`, theme/format/policy from `../lib/*`, types from `../types`.
- Produces `SendForm` (`export function`) — the propose/send form currently inline in `ChatDetail`/`VaultPanel` (the `<select value={sendForm.module}>` + dest/amount inputs + submit). Props: the `sendForm` state + `setSendForm` setter + the submit handler, exactly as currently wired. Preserve the modeled-Arkade `<option disabled>Arkade (modeled · Phase 2)</option>`.

- [ ] **Step 1: Extract `SendForm`**

Identify the send-form JSX in `wallet.tsx` (the block with `sendForm.module`/`sendForm.dest`/`sendForm.amount` inputs and the `<option disabled>Arkade (modeled · Phase 2)</option>`). Cut it into `components/send-form.tsx` as `export function SendForm(props: SendFormProps)` with `"use client";`, `interface SendFormProps { sendForm: {...}; setSendForm: (f: {...}) => void; onSubmit: () => void; /* + any other referenced props */ }` (match the exact shape from `wallet.tsx`'s `sendForm` state type). Import `{ C, MONO, inputStyle }` from `../lib/theme`.

- [ ] **Step 2: Extract `ChatDetail`**

Cut `ChatDetail` into `components/chat-detail.tsx` with `"use client";`, an explicit `ChatDetailProps` interface, and imports (address-chip, send-form, ongoing-proposals, lib/*, types). Replace the inline form JSX with `<SendForm … />` passing the same state/handlers.

- [ ] **Step 3: Rewire `wallet.tsx`**

Delete `ChatDetail` (and any now-inline form remnants). Add:
```ts
import { ChatDetail } from "./components/chat-detail";
```
(If `VaultPanel` also rendered the form, have it use `<SendForm />` too — import it there.)

- [ ] **Step 4: Typecheck + tests**

Run: `bun run typecheck` → clean. Run: `bun run test` → 172 passing.

- [ ] **Step 5: Commit**

```bash
git add app/ui/wallet/components/ app/ui/wallet/wallet.tsx
git commit -m "refactor(wallet): extract ChatDetail + SendForm components

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 6: Backend — `/api/wallet/overview` (server balances + totals + policy)

Move the chatty per-vault balance fetching + aggregation to the server.

**Files:**
- Create: `app/api/wallet/overview/route.ts`
- Create: `app/api/wallet/overview/route.test.ts`

**Interfaces:**
- Consumes: `addressBalance` from `app/api/_lib/esplora` (returns `{ totalSats, … }`); `clampNeed`/`quorumOf`/`spendOf` from `app/ui/wallet/lib/policy` (pure, client-safe — importable server-side); `Tier` from `app/ui/wallet/types`.
- Produces: `POST /api/wallet/overview` with request body `{ vaults: Array<{ id: string; name: string; receiveAddress: string | null; tiers: Tier[] }> }` → response `{ vaults: Array<{ id: string; name: string; receiveAddress: string | null; balanceSats: number; balanceBtc: string; threshold: number; quorum: string; spend: string }>; totals: { totalSats: number; totalBtc: string; totalKeys: number } }`. A vault whose address is null or whose Esplora lookup fails contributes `balanceSats: 0` (never a 500 for the whole payload).

- [ ] **Step 1: Write the failing test**

Create `app/api/wallet/overview/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../_lib/esplora", () => ({
  addressBalance: vi.fn(),
}));
import { addressBalance } from "../../_lib/esplora";
import { POST } from "./route";
import type { Tier } from "../../../ui/wallet/types";

const tier = (short: string, minNeed: number, n: number): Tier => ({
  id: short, name: short, short, minNeed,
  keys: Array.from({ length: n }, (_, i) => ({ id: `${short}${i}`, name: `k${i}` })) as Tier["keys"],
});

function req(body: unknown): Request {
  return new Request("http://t/api/wallet/overview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /api/wallet/overview", () => {
  beforeEach(() => vi.mocked(addressBalance).mockReset());

  it("aggregates server-side balances, totals, and derived policy", async () => {
    vi.mocked(addressBalance).mockImplementation(async (addr: string) => ({
      address: addr, confirmedSats: 0, mempoolSats: 0,
      totalSats: addr === "bcrt1pA" ? 100_000_000 : 50_000_000, txCount: 1,
    }));
    const res = await POST(req({ vaults: [
      { id: "treasury", name: "Treasury", receiveAddress: "bcrt1pA", tiers: [tier("C", 1, 2), tier("M", 2, 3)] },
      { id: "cold", name: "Cold", receiveAddress: "bcrt1pB", tiers: [tier("C", 1, 1)] },
    ] }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.vaults[0]).toMatchObject({ id: "treasury", balanceSats: 100_000_000, balanceBtc: "1.00000000", threshold: 3, quorum: "1/2 + 2/3" });
    expect(j.totals).toMatchObject({ totalSats: 150_000_000, totalBtc: "1.50000000", totalKeys: 6 });
  });

  it("treats a null address or failed lookup as 0, never 500", async () => {
    vi.mocked(addressBalance).mockRejectedValue(new Error("esplora down"));
    const res = await POST(req({ vaults: [
      { id: "a", name: "A", receiveAddress: null, tiers: [tier("C", 1, 1)] },
      { id: "b", name: "B", receiveAddress: "bcrt1pX", tiers: [tier("C", 1, 1)] },
    ] }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.vaults.every((v: { balanceSats: number }) => v.balanceSats === 0)).toBe(true);
    expect(j.totals.totalSats).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test → expect fail**

Run: `bun run test app/api/wallet/overview/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement the route**

Create `app/api/wallet/overview/route.ts`:
```ts
import { NextResponse } from "next/server";
import { addressBalance } from "../../_lib/esplora";
import { clampNeed, quorumOf, spendOf } from "../../../ui/wallet/lib/policy";
import type { Tier } from "../../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface VaultIn {
  id: string;
  name: string;
  receiveAddress: string | null;
  tiers: Tier[];
}

const toBtc = (sats: number): string => (sats / 1e8).toFixed(8);

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { vaults?: VaultIn[] } | null;
  const vaultsIn = Array.isArray(body?.vaults) ? body!.vaults : [];

  const vaults = await Promise.all(
    vaultsIn.map(async (v) => {
      let balanceSats = 0;
      if (v.receiveAddress) {
        try {
          balanceSats = (await addressBalance(v.receiveAddress)).totalSats;
        } catch {
          balanceSats = 0; // unreachable/invalid address → 0, never fail the payload
        }
      }
      const threshold = v.tiers.reduce((a, t) => a + clampNeed(t), 0);
      return {
        id: v.id,
        name: v.name,
        receiveAddress: v.receiveAddress,
        balanceSats,
        balanceBtc: toBtc(balanceSats),
        threshold,
        quorum: quorumOf(v.tiers),
        spend: spendOf(v.tiers),
      };
    }),
  );

  const totalSats = vaults.reduce((s, v) => s + v.balanceSats, 0);
  const totalKeys = vaultsIn.reduce((s, v) => s + v.tiers.reduce((a, t) => a + t.keys.length, 0), 0);
  return NextResponse.json({
    vaults,
    totals: { totalSats, totalBtc: toBtc(totalSats), totalKeys },
  });
}
```

- [ ] **Step 4: Run the test → pass**

Run: `bun run test app/api/wallet/overview/route.test.ts` → PASS (2 tests).
Run: `bun run typecheck` → clean. Run: `bun run test` → 174 passing (172 + 2).

- [ ] **Step 5: Commit**

```bash
git add app/api/wallet/overview/route.ts app/api/wallet/overview/route.test.ts
git commit -m "feat(api): /api/wallet/overview — server-side balances, totals, policy derivation

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 7: Extract hooks + api-client; slim wallet.tsx; use the overview endpoint

The final structural move: pull the god-component's state/effects into hooks that call a typed api-client, and replace the client-side balance loop with one `/api/wallet/overview` call.

**Files:**
- Create: `app/ui/wallet/lib/api-client.ts`
- Create: `app/ui/wallet/hooks/use-session.ts`, `use-chats.ts`, `use-approvals.ts`, `use-audit.ts`, `use-wallet-overview.ts`
- Modify: `app/ui/wallet/wallet.tsx`

**Interfaces:**
- `api-client.ts`: one typed async wrapper per `/api/*` endpoint the wallet uses (auth: `getChallenge()`, `login(evt,nonce)`, `me()`, `logout()`, `personas()`; chats: `getChats()`, `getMembers(id)`, `provision(id)`; approvals: `getApprovals()`, `propose(body)`, `sign(id)`, `broadcast(id)`; audit: `getAudit(id)`; overview: `getOverview(vaults)` → POSTs to `/api/wallet/overview`; stealth `getStealth()`). Each returns typed data or throws on non-OK.
- `use-wallet-overview.ts`: `useWalletOverview(vaults): { overview: OverviewResp | null; loading: boolean }` — POSTs the vault list to `/api/wallet/overview` and returns balances/totals/policy; re-fetches when the vault address set changes (key on a stable string of `[id, receiveAddress]` pairs, like the current activity effect).
- Other hooks encapsulate the corresponding `useState`/`useEffect`/handlers currently in `Wallet()`, returning state + actions.

- [ ] **Step 1: Create the typed api-client**

Create `app/ui/wallet/lib/api-client.ts` with one function per endpoint, wrapping the exact `fetch` calls currently in `wallet.tsx` (same URLs, methods, bodies), each typed and throwing on `!res.ok` where the current code does. Include:
```ts
import type { Tier } from "../types";
export interface OverviewVaultIn { id: string; name: string; receiveAddress: string | null; tiers: Tier[] }
export interface OverviewVault { id: string; name: string; receiveAddress: string | null; balanceSats: number; balanceBtc: string; threshold: number; quorum: string; spend: string }
export interface OverviewResp { vaults: OverviewVault[]; totals: { totalSats: number; totalBtc: string; totalKeys: number } }
export async function getOverview(vaults: OverviewVaultIn[]): Promise<OverviewResp> {
  const r = await fetch("/api/wallet/overview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vaults }) });
  if (!r.ok) throw new Error(`overview ${r.status}`);
  return (await r.json()) as OverviewResp;
}
// …one wrapper per other endpoint, mirroring the current wallet.tsx fetches…
```

- [ ] **Step 2: Create `use-wallet-overview.ts` and swap the balance loop**

Create the hook:
```ts
import { useEffect, useState } from "react";
import { getOverview, type OverviewResp, type OverviewVaultIn } from "../lib/api-client";

export function useWalletOverview(vaults: OverviewVaultIn[]): { overview: OverviewResp | null; loading: boolean } {
  const [overview, setOverview] = useState<OverviewResp | null>(null);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(vaults.map((v) => [v.id, v.receiveAddress]));
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getOverview(vaults)
      .then((o) => { if (!cancelled) setOverview(o); })
      .catch(() => { /* leave prior overview in place */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { overview, loading };
}
```
In `wallet.tsx`, DELETE the per-vault balance loop (the `for (const c of targets) { … fetch(`/api/chain/address/…`) … }` effect) and the client `reduce` totals; consume `useWalletOverview(...)` instead, mapping `overview.vaults[i].balanceBtc` onto the displayed chats and using `overview.totals` for the Overview panel. Keep the separate activity effect (`/api/chain/activity`) unchanged.

- [ ] **Step 3: Extract the remaining hooks**

Move the auth/chats/approvals/audit `useState`+`useEffect`+handlers from `Wallet()` into `use-session.ts`, `use-chats.ts`, `use-approvals.ts`, `use-audit.ts`, each calling the api-client. `wallet.tsx` calls these hooks and wires their state/actions to the panels. Preserve behavior exactly (same triggers, same optimistic updates, same relay wiring — the relay/NIP-44 code in `nostr-chat.ts`/`nostr-signer.ts` is untouched and still invoked from `wallet.tsx` or a `use-chat-messages` hook if natural).

- [ ] **Step 4: Typecheck + tests**

Run: `bun run typecheck` → clean. Run: `bun run test` → 174 passing. Confirm `wallet.tsx` is now ≤ ~250 lines (`wc -l app/ui/wallet/wallet.tsx`).

- [ ] **Step 5: Commit**

```bash
git add app/ui/wallet/lib/api-client.ts app/ui/wallet/hooks/ app/ui/wallet/wallet.tsx
git commit -m "refactor(wallet): extract hooks + typed api-client; slim orchestrator; use /api/wallet/overview

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 8: End-to-end verification (browser smoke)

Prove behavior is preserved before declaring done. No code changes unless a regression is found (then fix + re-verify).

**Files:** none (verification).

- [ ] **Step 1: Full suite + typecheck**

Run: `bun run typecheck && bun run test && echo GREEN`
Expected: `GREEN` (174 tests).

- [ ] **Step 2: Start the app and smoke the core flows**

Run `bun run dev`, open `http://localhost:3000` (NOT `127.0.0.1` — HMR WS quirk gives a blank UI). With `vaultd` + a relay reachable (or the CLI fallback), verify:
- Log in with a demo persona → the console renders.
- Overview shows vault balances + `TOTAL ACROSS VAULTS` (now from `/api/wallet/overview` — confirm one POST to it in the network tab, and NO per-vault `/api/chain/address` loop).
- Open a channel → propose a transfer → switch signer → Approve & sign to quorum.
- Send a chat message (🔒 NIP-44) → it appears; audit log updates.

- [ ] **Step 3: Record evidence**

Note in the commit/PR description: `wallet.tsx` line count before/after, the single overview POST replacing N address calls, and that login/propose/sign/chat/audit all work.

- [ ] **Step 4: Commit (if any regression fix was needed)**

```bash
git add -A
git commit -m "test(wallet): verify decomposition preserves behavior (browser smoke)

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```
(If no fix was needed, skip the commit — Step 1/2 evidence is the deliverable.)

---

## Self-Review

**1. Spec coverage:**
- Decompose `wallet.tsx` into components/hooks/lib → Tasks 1–5, 7. ✅
- Server data consolidation (`/api/wallet/overview`, balances+totals+policy) → Task 6, consumed in Task 7. ✅
- Policy derivation server-side (shared pure `lib/policy` imported by the route) → Tasks 2, 6. ✅
- Activity stays its own endpoint → explicit in Tasks 6, 7 (unchanged). ✅
- NIP-44 + relay stay client-side; `relTime` stays client-side → Global Constraints + Task 2. ✅
- Behavior preserved; browser smoke gate → Task 8. ✅
- No whole-app overhaul (non-goal) → scope limited to `app/ui/wallet/` + one endpoint. ✅

**2. Placeholder scan:** Extraction steps intentionally say "move verbatim" rather than paste large bodies (the code exists; the convention is stated up front) — this is a relocation instruction, not a deferred-work placeholder. New modules (theme skeleton, format/policy tests, the overview route, api-client, hooks) carry complete code. No TBD/TODO.

**3. Type consistency:** `C`/`MONO`/`SANS`/`inputStyle` (Task 1) are imported by all components (Tasks 3–5). `clampNeed`/`quorumOf`/`spendOf` (Task 2) are used identically by the overview route (Task 6) and panels. `OverviewResp`/`OverviewVault`/`OverviewVaultIn` are defined once in `api-client.ts` (Task 7) and match the route's response shape (Task 6). `Tier`/`Chat`/`PolicyConfig` come from the existing `types.ts`. Test counts thread consistently: 166 → 172 (Task 2, +6) → 174 (Task 6, +2).
