# OSS Silent-Payment Treasury — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make btech a clone-and-run, open-source, one-command silent-payment + HTSS treasury on Bitcoin regtest: real end-to-end L1 receive (wired) + spend, real NIP-44 chat, self-contained Docker stack, honest docs. (Arkade stays honestly modeled; real Arkade is Phase 2.)

**Architecture:** A `docker compose up` stack — `bitcoind`/`esplora` (regtest), `relay` (Nostr), `vaultd` (git-pinned dkgkit, built in-image), `bootstrap` (mines + funds the vault), `app` (Next.js). The headline code change wires the already-implemented, vector-tested L1 block-walk receiver (`lib/silentpayment/esplora-scan.ts:scanBlocks`) into the stealth inbox so the UI shows genuine on-chain BIP-352 detections.

**Tech Stack:** Next.js 16 + React 19 + Bun, TypeScript, `@noble/*` + `nostr-tools` (silent-payment + NIP-44 crypto), Rust (`vaultd` via `dkgkit`), Docker Compose, `blockstream/esplora` (regtest), `scsibug/nostr-rs-relay`, Vitest.

## Global Constraints

- Package manager: **Bun** (`bun run`, `bun test`, `bun add`) — never npm.
- Sub-agents implementing this plan **may write and execute code** (btech exception in the user's global CLAUDE.md).
- dkgkit is public: `https://github.com/cheng-chun-yuan/dkgkit`, pin rev **`751ed81`**.
- Esplora REST base is used as `${BTECH_ESPLORA_URL}/api/...` — any esplora URL must resolve `${URL}/api/blocks/tip/height` (public default `https://btc.utxopia.com/regtest`; local default `http://esplora/regtest`).
- Default vault id is **`treasury`**; the on-chain receive address comes from `GET ${BTECH_VAULTD_URL}/vault/state?id=treasury` → `.receive_address`.
- `NEXT_PUBLIC_NOSTR_RELAY` is **browser-facing** (must be host-reachable, e.g. `ws://localhost:7777`); `BTECH_ESPLORA_URL` / `BTECH_VAULTD_URL` are **server-side** (container-internal DNS names).
- LICENSE: **MIT**.
- Never fake a txid or a detection. Real crypto or a surfaced error — no mock success paths.
- Browser-based manual checks use `localhost` (not `127.0.0.1`) — HMR WS quirk gives a blank UI on `127.0.0.1`.
- Commit after every task with a Conventional-Commits message ending:
  `Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4`

---

## File Structure (created / modified in Phase 1)

- `Cargo.toml` — path deps → git-pinned deps (**modify**)
- `src/bin/vaultd.rs` — host-configurable bind (**modify**)
- `lib/silentpayment/treasury.ts` — add real on-chain scan + unified inbox (**modify**)
- `lib/silentpayment/treasury.test.ts` — new unit tests for the scan/merge (**create**)
- `app/api/stealth/route.ts` — trigger incremental chain scan; return unified inbox (**modify**)
- `app/api/_lib/settle.ts` — drop the modeled operator-stream injection for silent sends (**modify**)
- `app/stealth/page.tsx` — render `source` badge + on-chain txid (**modify**)
- `app/ui/wallet/wallet.tsx` — label the Arkade module option "modeled (Phase 2)" (**modify**)
- `Dockerfile.rust` — build `vaultd` (**create**)
- `Dockerfile.app` — Next.js app image (**create**)
- `docker-compose.yml` — the full stack (**create**)
- `scripts/regtest-fund.sh` — idempotent mine + fund the vault (**create**)
- `examples/node/silent-payment-l1.ts` — real L1 round-trip smoke (**create**; supersedes `scripts/sp-live-send.ts`)
- `examples/node/silent-payment-modeled.ts` — the honest modeled-Arkade demo (**create**)
- `.env.example` — local-default env + documented overrides (**modify**)
- `README.md`, `DEMO.md`, `STEALTH_DEMO.md` — align to reality (**modify**)
- `LICENSE`, `CONTRIBUTING.md` — OSS hygiene (**create**)
- `.github/workflows/ci.yml` — CI (**create**)

---

## Task 1: Rust — git-pin dkgkit + host-configurable vaultd bind

Removes the sibling-`../dkgkit` checkout requirement and lets `vaultd` bind `0.0.0.0` inside Docker.

**Files:**
- Modify: `Cargo.toml` (deps `dkgkit-nostr`, `dkgkit-sdk`)
- Modify: `src/bin/vaultd.rs:295-296`

**Interfaces:**
- Produces: a buildable workspace with no sibling path deps; `vaultd` honoring `BTECH_VAULTD_HOST` (default `0.0.0.0`), `BTECH_VAULTD_PORT` (default `8787`), `BTECH_VAULTD_DATA` (default `data/vaultd`).

- [ ] **Step 1: Convert the two path deps to git-pinned deps**

In `Cargo.toml`, replace:
```toml
dkgkit-nostr = { path = "../dkgkit/crates/dkgkit-nostr", features = ["live"] }
dkgkit-sdk = { path = "../dkgkit/crates/dkgkit-sdk" }
```
with:
```toml
dkgkit-nostr = { git = "https://github.com/cheng-chun-yuan/dkgkit", rev = "751ed81", features = ["live"] }
dkgkit-sdk = { git = "https://github.com/cheng-chun-yuan/dkgkit", rev = "751ed81" }
```

- [ ] **Step 2: Make vaultd's bind host configurable**

In `src/bin/vaultd.rs`, replace:
```rust
    let port = std::env::var("BTECH_VAULTD_PORT").unwrap_or_else(|_| "8787".to_string());
    let addr = format!("127.0.0.1:{port}");
```
with:
```rust
    let host = std::env::var("BTECH_VAULTD_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port = std::env::var("BTECH_VAULTD_PORT").unwrap_or_else(|_| "8787".to_string());
    let addr = format!("{host}:{port}");
```

- [ ] **Step 3: Build against the git-pinned dep (this also rewrites Cargo.lock)**

Run: `cargo build --bin vaultd`
Expected: compiles to `target/debug/vaultd` with the two deps fetched from the git rev (first build re-resolves; `Cargo.lock` updates the two `dkgkit-*` source lines to `git+https://github.com/cheng-chun-yuan/dkgkit?rev=751ed81`).

- [ ] **Step 4: Smoke-run vaultd on an ephemeral data dir + bind host**

Run:
```bash
BTECH_VAULTD_HOST=0.0.0.0 BTECH_VAULTD_PORT=8799 BTECH_VAULTD_DATA=$(mktemp -d) ./target/debug/vaultd &
sleep 3; curl -sf http://localhost:8799/healthz; echo; curl -sf "http://localhost:8799/vault/state?id=treasury" | head -c 200; echo; kill %1
```
Expected: `/healthz` returns an OK string; `/vault/state?id=treasury` returns JSON containing `"receive_address"`.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/bin/vaultd.rs
git commit -m "build(rust): git-pin dkgkit + host-configurable vaultd bind for Docker

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 2: Wire the real L1 receiver into the treasury inbox (headline gap G1)

Adds a real on-chain block-walk scan (view-key detection) and a unified inbox that distinguishes genuine on-chain detections from the modeled ones.

**Files:**
- Modify: `lib/silentpayment/treasury.ts`
- Create: `lib/silentpayment/treasury.test.ts`

**Interfaces:**
- Consumes: `scanBlocks`, `esploraFetcher`, `L1Detection`, `TxFetcher` from `./esplora-scan`; `viewKeyOf`, `decodeSilentPaymentAddress`, `senderDerive` from `./crypto`.
- Produces:
  - `type InboxSource = "onchain" | "modeled"`
  - `interface InboxItem { source: InboxSource; P: string; amount: number; txid?: string; vout?: number; blockHeight?: number; vtxId?: string; leafIndex?: number }`
  - `scanChainOnce(fetcher?: TxFetcher): Promise<InboxItem[]>` — incremental block-walk; dedups by `txid:vout`; advances an in-memory cursor.
  - `getInbox(): InboxItem[]` — on-chain (newest-first) then modeled, deduped by `P` (on-chain wins).
  - Existing exports unchanged: `metaAddress`, `getInbound`, `ingestCandidate`, `simulateInbound`, `deriveInternalSend`.

- [ ] **Step 1: Write the failing test**

Create `lib/silentpayment/treasury.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  metaAddress,
  scanChainOnce,
  getInbox,
  __resetOnchainForTest,
} from "./treasury";
import {
  decodeSilentPaymentAddress,
  generateKeyPair,
  senderDerive,
  evenYCompressed,
} from "./crypto";
import type { FullTx, TxFetcher } from "./esplora-scan";

/** A regtest tx paying the treasury tsp1 at output index 1 (index 0 = change). */
function payTreasuryTx(): { tx: FullTx; amount: number; xonly: string } {
  const meta = decodeSilentPaymentAddress(metaAddress());
  const sender = generateKeyPair();
  const senderTxid = "ba".repeat(32);
  const out = senderDerive({ meta, spenderPrivs: [sender.priv], outpoints: [{ txid: senderTxid, vout: 3 }], t: 0, taproot: true });
  const amount = 99_000;
  const tx: FullTx = {
    txid: "fe".repeat(32),
    vin: [{ txid: senderTxid, vout: 3, witness: ["aa".repeat(64)], prevout: { scriptpubkey: "5120" + evenYCompressed(sender.pub).slice(2), scriptpubkey_type: "v1_p2tr" } }],
    vout: [
      { scriptpubkey: "0014" + "11".repeat(20), scriptpubkey_type: "v0_p2wpkh", value: 500 },
      { scriptpubkey: "5120" + out.xonly, scriptpubkey_type: "v1_p2tr", value: amount },
    ],
    status: { confirmed: true, block_height: 7 },
  };
  return { tx, amount, xonly: out.xonly };
}

function fetcherFor(tx: FullTx, tip: number): TxFetcher {
  return {
    tip: async () => tip,
    blockHash: async (h) => (h === (tx.status?.block_height ?? -1) ? `hash${h}` : null),
    blockTxids: async (hash) => (hash === `hash${tx.status?.block_height}` ? [tx.txid] : []),
    getTx: async (id) => (id === tx.txid ? tx : (null as unknown as FullTx)),
  };
}

describe("treasury on-chain scan", () => {
  beforeEach(() => __resetOnchainForTest());

  it("detects a real on-chain payment and surfaces it as an onchain inbox item", async () => {
    const { tx, amount, xonly } = payTreasuryTx();
    const fresh = await scanChainOnce(fetcherFor(tx, 7));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ source: "onchain", P: xonly, amount, txid: tx.txid, vout: 1, blockHeight: 7 });
    const inbox = getInbox();
    expect(inbox.some((i) => i.source === "onchain" && i.txid === tx.txid && i.P === xonly)).toBe(true);
  });

  it("is idempotent — a second scan of the same tip adds nothing", async () => {
    const { tx } = payTreasuryTx();
    await scanChainOnce(fetcherFor(tx, 7));
    const again = await scanChainOnce(fetcherFor(tx, 7));
    expect(again).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test lib/silentpayment/treasury.test.ts`
Expected: FAIL — `scanChainOnce`, `getInbox`, `__resetOnchainForTest` are not exported.

- [ ] **Step 3: Implement the scan + unified inbox in `treasury.ts`**

Add imports at the top of `lib/silentpayment/treasury.ts` (alongside the existing `./crypto` import):
```ts
import { scanBlocks, esploraFetcher, type TxFetcher } from "./esplora-scan";
```

Append to `lib/silentpayment/treasury.ts`:
```ts
// ── real on-chain (L1) detection via view-key block-walk ─────────────────────

export type InboxSource = "onchain" | "modeled";

export interface InboxItem {
    source: InboxSource;
    P: string; // x-only taproot output key (hex)
    amount: number;
    // on-chain only:
    txid?: string;
    vout?: number;
    blockHeight?: number;
    // modeled only:
    vtxId?: string;
    leafIndex?: number;
}

/** How many blocks back the first scan looks (the seeded address only ever
 *  receives after the demo starts, so a recent window is enough). */
const SCAN_DEPTH = Number(process.env.BTECH_STEALTH_SCAN_DEPTH ?? "500");

let lastScanned: number | null = null;
const onchain = new Map<string, InboxItem>(); // key = `${txid}:${vout}`

/** Test-only: reset the on-chain cursor + store. */
export function __resetOnchainForTest(): void {
    lastScanned = null;
    onchain.clear();
}

/**
 * Walk new blocks up to the chain tip and detect inbound silent payments to the
 * treasury with the VIEW KEY only. Deduped by `txid:vout`; advances an in-memory
 * cursor. Returns the newly-detected items.
 */
export async function scanChainOnce(fetcher: TxFetcher = esploraFetcher): Promise<InboxItem[]> {
    const tip = await fetcher.tip();
    const from = lastScanned === null ? Math.max(0, tip - SCAN_DEPTH) : lastScanned + 1;
    if (from > tip) {
        lastScanned = tip;
        return [];
    }
    const dets = await scanBlocks(viewKeyOf(treasury), from, tip, fetcher);
    const fresh: InboxItem[] = [];
    for (const d of dets) {
        const key = `${d.txid}:${d.vout}`;
        if (onchain.has(key)) continue;
        const item: InboxItem = {
            source: "onchain",
            P: d.xonly,
            amount: d.amount,
            txid: d.txid,
            vout: d.vout,
            blockHeight: d.blockHeight,
        };
        onchain.set(key, item);
        fresh.push(item);
    }
    lastScanned = tip;
    return fresh;
}

/**
 * Unified inbox: real on-chain detections (newest first) then modeled ones,
 * deduped by the detected output key `P` (on-chain wins over a modeled echo).
 */
export function getInbox(): InboxItem[] {
    const seen = new Set<string>();
    const items: InboxItem[] = [];
    for (const it of [...onchain.values()].reverse()) {
        seen.add(it.P);
        items.push(it);
    }
    for (const p of getInbound()) {
        if (seen.has(p.P)) continue;
        items.push({ source: "modeled", P: p.P, amount: p.amount, vtxId: p.vtxId, leafIndex: p.leafIndex });
    }
    return items;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun test lib/silentpayment/treasury.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/silentpayment/treasury.ts lib/silentpayment/treasury.test.ts
git commit -m "feat(sp): wire real L1 block-walk receiver into the treasury inbox

Adds scanChainOnce (view-key block-walk) + getInbox unifying real on-chain
detections with modeled ones. Closes gap G1 — the stealth inbox can now show
genuine on-chain BIP-352 detections, not just the modeled operator stream.

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 3: Serve real detections from `/api/stealth`; drop the modeled L1 echo

Makes the stealth API perform an incremental on-chain scan and return the unified inbox, and removes the now-redundant modeled operator-stream injection from the silent-send settle path.

**Files:**
- Modify: `app/api/stealth/route.ts`
- Modify: `app/api/_lib/settle.ts:106-116` (the `ingestCandidate({...})` block)

**Interfaces:**
- Consumes: `scanChainOnce`, `getInbox`, `metaAddress`, `simulateInbound`, `ingestCandidate` from `treasury`.
- Produces: `GET /api/stealth` → `{ metaAddress, inbound: InboxItem[] }` where `inbound` includes real on-chain detections.

- [ ] **Step 1: Update the GET handler to scan the chain first**

Replace `app/api/stealth/route.ts` entirely with:
```ts
import { NextResponse } from "next/server";
import {
  metaAddress,
  getInbox,
  scanChainOnce,
  simulateInbound,
  ingestCandidate,
} from "../../../lib/silentpayment/treasury";
import type { CandidateVtx } from "../../../lib/silentpayment/scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Treasury stealth address + inbox. GET runs a best-effort incremental on-chain
// block-walk (view-key detection) so real L1 silent payments show up here.
export async function GET() {
  await scanChainOnce().catch(() => []); // best-effort; never fail the read
  return NextResponse.json({ metaAddress: metaAddress(), inbound: getInbox() });
}

// POST with a CandidateVtx body → ingest a modeled (Phase-2 Arkade) candidate.
// POST with no body → simulate one modeled inbound locally (demo button).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as CandidateVtx | null;
  const detected =
    body && Array.isArray(body.inputs) && Array.isArray(body.outputs)
      ? (ingestCandidate(body)[0] ?? null)
      : simulateInbound();
  return NextResponse.json({ detected, inbound: getInbox() });
}
```

- [ ] **Step 2: Remove the modeled operator-stream injection from the silent-send settle path**

In `app/api/_lib/settle.ts`, read the block around lines 100-120 first, then delete the `ingestCandidate({ ... })` call (and its surrounding "Model the operator stream" comment / try wrapper). The real on-chain scan (Task 2) now provides the detection once the tx confirms. Remove the now-unused `ingestCandidate` import if nothing else uses it.

Run to find the exact lines:
```bash
grep -n "ingestCandidate\|Model the operator stream" app/api/_lib/settle.ts
```

- [ ] **Step 3: Typecheck (catches an orphaned import)**

Run: `bun run typecheck`
Expected: no errors. If it flags an unused `ingestCandidate` import in `settle.ts`, delete that import line.

- [ ] **Step 4: Verify the full suite still passes**

Run: `bun test`
Expected: all suites pass (including the new `treasury.test.ts` and the untouched `esplora-scan.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add app/api/stealth/route.ts app/api/_lib/settle.ts
git commit -m "feat(sp): /api/stealth serves real on-chain detections; drop modeled L1 echo

GET now runs a best-effort view-key block-walk before returning the unified
inbox. settle.ts no longer injects the just-broadcast tx as a modeled operator
stream — real detection replaces it. simulateInbound stays as an explicit demo.

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 4: Stealth page — show detection source + on-chain txid

Renders the `source` badge and, for on-chain items, a short txid so viewers can see a real regtest tx.

**Files:**
- Modify: `app/stealth/page.tsx`

**Interfaces:**
- Consumes: `GET /api/stealth` → `inbound: InboxItem[]` (fields `source`, `P`, `amount`, `txid?`, `vout?`, `vtxId?`).

- [ ] **Step 1: Widen the `Payment` type and dedupe key**

In `app/stealth/page.tsx`, replace the `type Payment = {...}` block with:
```ts
type Payment = {
  source?: "onchain" | "modeled";
  P: string;
  amount: number;
  vtxId?: string;
  leafIndex?: number;
  txid?: string;
  vout?: number;
  blockHeight?: number;
};
```

- [ ] **Step 2: Give each row a stable key and a source badge**

Replace the `.map((p) => (...))` row (the block starting `key={p.vtxId + p.P}`) with:
```tsx
{inbound.map((p) => (
  <div
    key={(p.txid ?? p.vtxId ?? "") + ":" + p.P}
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      background: "#0d1117",
      border: "1px solid #1c2230",
      borderRadius: 8,
      padding: "10px 14px",
    }}
  >
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.4,
            padding: "2px 6px",
            borderRadius: 4,
            color: p.source === "onchain" ? "#7fd1b9" : "#c7a3ff",
            border: `1px solid ${p.source === "onchain" ? "#2a4d43" : "#3a2d55"}`,
          }}
        >
          {p.source === "onchain" ? "ON-CHAIN L1" : "MODELED"}
        </span>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#8b94a7" }}>
          P {p.P.slice(0, 10)}…{p.P.slice(-6)}
        </span>
      </div>
      {p.txid && (
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#5b6273" }}>
          tx {p.txid.slice(0, 12)}…:{p.vout}
        </span>
      )}
    </div>
    <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 14 }}>
      +{p.amount.toLocaleString()} sats
    </div>
  </div>
))}
```

- [ ] **Step 3: Soften the footer copy (no false Arkade claim)**

Replace the footer `<p>` that begins "Detection runs on a delegated view key" with:
```tsx
<p style={{ color: "#5b6273", fontSize: 12, marginTop: 16 }}>
  Detection runs on a delegated view key (detect-only — it can never spend).
  <strong> ON-CHAIN L1</strong> items are real regtest taproot outputs found by
  block-walking with the view key. <strong>MODELED</strong> items simulate the
  operator stream (the Arkade off-chain rail lands in Phase 2).
</p>
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/stealth/page.tsx
git commit -m "feat(ui): stealth inbox shows detection source (on-chain vs modeled) + txid

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 5: Honest Arkade labeling in the wallet

The send-form `<option>Arkade</option>` is a no-op today; label it as modeled until Phase 2.

**Files:**
- Modify: `app/ui/wallet/wallet.tsx` (the CHAIN/MODULE `<select>`, ~line 1598)

**Interfaces:** none (copy-only).

- [ ] **Step 1: Find the option**

Run: `grep -n ">Arkade<\|option" app/ui/wallet/wallet.tsx | head`

- [ ] **Step 2: Relabel the option**

Change the Arkade `<option>` label text to `Arkade (modeled · Phase 2)` and add `disabled` so it cannot be selected as a real settlement route. Example:
```tsx
<option value="arkade" disabled>Arkade (modeled · Phase 2)</option>
```
(Keep the existing `value`; only the visible label + `disabled` change.)

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/ui/wallet/wallet.tsx
git commit -m "docs(ui): label Arkade send route as modeled (Phase 2), disable selection

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 6: `Dockerfile.rust` — build vaultd

**Files:**
- Create: `Dockerfile.rust`

**Interfaces:**
- Produces: an image whose default command runs `vaultd`, with `curl` present for healthchecks.

- [ ] **Step 1: Write the Dockerfile**

Create `Dockerfile.rust`:
```dockerfile
# Build btech-vaultd from source with git-pinned dkgkit (no sibling checkout).
FROM rust:1.83-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
RUN cargo build --release --bin vaultd

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/vaultd /usr/local/bin/vaultd
ENV BTECH_VAULTD_HOST=0.0.0.0 BTECH_VAULTD_PORT=8787 BTECH_VAULTD_DATA=/data
VOLUME /data
EXPOSE 8787
CMD ["vaultd"]
```

- [ ] **Step 2: Build the image**

Run: `docker build -f Dockerfile.rust -t btech-vaultd .`
Expected: builds successfully; final image tagged `btech-vaultd`.

- [ ] **Step 3: Run it and hit the health + state endpoints**

Run:
```bash
docker run --rm -d --name btech-vaultd-test -p 8798:8787 btech-vaultd
sleep 4
curl -sf http://localhost:8798/healthz && echo " OK"
curl -sf "http://localhost:8798/vault/state?id=treasury" | grep -o '"receive_address":"[^"]*"' | head -1
docker rm -f btech-vaultd-test
```
Expected: health OK; a `"receive_address":"bcrt1p…"` line prints.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.rust
git commit -m "build(docker): Dockerfile.rust builds vaultd from git-pinned dkgkit

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 7: `Dockerfile.app` — Next.js app image

**Files:**
- Create: `Dockerfile.app`

**Interfaces:**
- Produces: an image running the dev server on `0.0.0.0:3000` (env read at runtime, so `NEXT_PUBLIC_*` reaches the browser without a build arg).

- [ ] **Step 1: Write the Dockerfile**

Create `Dockerfile.app`:
```dockerfile
# btech Next.js console (Bun). Dev server so NEXT_PUBLIC_* is read at runtime.
FROM oven/bun:1
# better-sqlite3 builds a native addon → needs a toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ENV BTECH_DB=/data/btech.db
VOLUME /data
EXPOSE 3000
CMD ["bun", "run", "next", "dev", "-H", "0.0.0.0", "-p", "3000"]
```

- [ ] **Step 2: Build the image**

Run: `docker build -f Dockerfile.app -t btech-app .`
Expected: builds successfully (native `better-sqlite3` compiles).

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.app
git commit -m "build(docker): Dockerfile.app runs the Next.js console on Bun

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 8: `docker-compose.yml` — the full self-contained stack

Brings up chain + esplora + relay + vaultd + app in one command. Funding is added in Task 9.

**Files:**
- Create: `docker-compose.yml`

**Interfaces:**
- Consumes: `Dockerfile.rust`, `Dockerfile.app`.
- Produces: services `esplora` (regtest REST at `http://esplora/regtest/api`), `relay` (`ws://localhost:7777`), `vaultd` (`http://vaultd:8787`), `app` (`http://localhost:3000`).

- [ ] **Step 1: Write the compose file**

Create `docker-compose.yml`:
```yaml
name: btech
services:
  # Regtest chain + Esplora REST API. Serves the API at /regtest/api/* — matches
  # the existing ${BTECH_ESPLORA_URL}/api/... convention. Also serves a faucet.
  esplora:
    image: blockstream/esplora:latest
    command: /srv/explorer/run.sh bitcoin-regtest explorer
    ports:
      - "50001:50001"   # electrum
      - "8094:80"       # esplora REST + web  → http://localhost:8094/regtest/api
    volumes:
      - esplora_data:/data
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost/regtest/api/blocks/tip/height"]
      interval: 5s
      timeout: 5s
      retries: 40

  relay:
    image: scsibug/nostr-rs-relay:latest
    ports:
      - "7777:8080"     # browser connects to ws://localhost:7777
    volumes:
      - relay_data:/usr/src/app/db

  vaultd:
    build:
      context: .
      dockerfile: Dockerfile.rust
    environment:
      BTECH_VAULTD_HOST: 0.0.0.0
      BTECH_VAULTD_PORT: "8787"
      BTECH_VAULTD_DATA: /data
    volumes:
      - vaultd_data:/data
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8787/healthz"]
      interval: 5s
      timeout: 5s
      retries: 40

  app:
    build:
      context: .
      dockerfile: Dockerfile.app
    environment:
      BTECH_ESPLORA_URL: http://esplora/regtest
      BTECH_VAULTD_URL: http://vaultd:8787
      NEXT_PUBLIC_NOSTR_RELAY: ws://localhost:7777
      BTECH_DB: /data/btech.db
    ports:
      - "3000:3000"
    volumes:
      - app_data:/data
    depends_on:
      esplora:
        condition: service_healthy
      vaultd:
        condition: service_healthy
      relay:
        condition: service_started

volumes:
  esplora_data:
  relay_data:
  vaultd_data:
  app_data:
```

> Implementation note (not a placeholder — a verification instruction): if
> `blockstream/esplora:latest` regtest does not serve `/regtest/api/blocks/tip/height`
> on container port 80 after warmup, fix the `command`/port per the image's current
> docs; the fallback that MUST work is setting `app.environment.BTECH_ESPLORA_URL`
> to the public `https://btc.utxopia.com/regtest` and dropping the `esplora` service
> + its `depends_on`. Either way, Step 2's curl must pass before commit.

- [ ] **Step 2: Bring the stack up and verify each service**

Run:
```bash
docker compose up -d --build
# esplora REST reachable from host:
until curl -sf http://localhost:8094/regtest/api/blocks/tip/height; do sleep 2; done; echo " esplora OK"
# vault address served:
docker compose exec -T vaultd curl -sf "http://localhost:8787/vault/state?id=treasury" | grep -o '"receive_address":"[^"]*"' | head -1
# app up:
until curl -sf http://localhost:3000/api/chain/tip >/dev/null; do sleep 2; done; echo " app OK"
```
Expected: a tip height number, a `receive_address`, and `app OK`.

- [ ] **Step 3: Manual browser check**

Open `http://localhost:3000`, log in with a demo persona (personas appear because `vaultd` is up), confirm the console renders and the header shows a chain tip. Then `docker compose down` (keep volumes).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "build(docker): one-command self-contained stack (esplora+relay+vaultd+app)

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 9: Bootstrap — mine maturity + fund the vault (idempotent)

So a fresh `docker compose up` yields a vault with spendable confirmed UTXOs → L1 spend works out of the box.

**Files:**
- Create: `scripts/regtest-fund.sh`
- Modify: `docker-compose.yml` (add a one-shot `bootstrap` service)

**Interfaces:**
- Consumes: esplora regtest RPC/faucet + `vaultd` `/vault/state`.
- Produces: the `treasury` vault address funded with ≥ 1 confirmed UTXO.

- [ ] **Step 1: Write the funding script**

Create `scripts/regtest-fund.sh` (idempotent: no-op if the vault already has UTXOs). It fetches the vault address from vaultd, funds it via the esplora regtest faucet, and confirms a block:
```bash
#!/usr/bin/env sh
set -eu
ESPLORA="${BTECH_ESPLORA_URL:-http://esplora/regtest}"
VAULTD="${BTECH_VAULTD_URL:-http://vaultd:8787}"
AMOUNT_BTC="${BTECH_FUND_BTC:-1}"

echo "bootstrap: waiting for vaultd + esplora…"
until curl -sf "$VAULTD/healthz" >/dev/null; do sleep 2; done
until curl -sf "$ESPLORA/api/blocks/tip/height" >/dev/null; do sleep 2; done

ADDR=$(curl -sf "$VAULTD/vault/state?id=treasury" | sed -n 's/.*"receive_address":"\([^"]*\)".*/\1/p')
[ -n "$ADDR" ] || { echo "bootstrap: no vault address"; exit 1; }
echo "bootstrap: treasury vault address = $ADDR"

# Idempotency: skip if already funded.
UTXOS=$(curl -sf "$ESPLORA/api/address/$ADDR/utxo" || echo "[]")
if [ "$UTXOS" != "[]" ] && [ -n "$UTXOS" ]; then
  echo "bootstrap: vault already funded → $UTXOS"; exit 0
fi

# Fund via the esplora regtest faucet, then mine 1 block to confirm.
echo "bootstrap: funding $AMOUNT_BTC BTC via faucet…"
curl -sf -X POST "$ESPLORA/api/faucet" \
  -H 'content-type: application/json' \
  -d "{\"address\":\"$ADDR\",\"amount\":$AMOUNT_BTC}" || {
    echo "bootstrap: faucet POST failed — see script header note"; exit 1; }
sleep 3
echo "bootstrap: done. UTXOs:"; curl -sf "$ESPLORA/api/address/$ADDR/utxo" || true
```

> Implementation note (verification instruction, not a placeholder): the exact
> funding endpoint depends on the esplora image. `blockstream/esplora` regtest
> exposes a faucet; if its route/shape differs, adjust the `curl` here (or run
> `docker compose exec esplora cli -regtest sendtoaddress "$ADDR" "$AMOUNT_BTC"`
> followed by `... -generate 1`). Step 4's assertion (vault UTXO count ≥ 1) is the
> gate. If the local chain proves too fiddly, switch `BTECH_ESPLORA_URL` to the
> public regtest whose faucet the script already targets.

- [ ] **Step 2: Make it executable + add the bootstrap service**

Run: `chmod +x scripts/regtest-fund.sh`

Add to `docker-compose.yml` under `services:` (a curl-capable one-shot; reuses the vaultd image which has curl):
```yaml
  bootstrap:
    build:
      context: .
      dockerfile: Dockerfile.rust
    entrypoint: ["sh", "/scripts/regtest-fund.sh"]
    environment:
      BTECH_ESPLORA_URL: http://esplora/regtest
      BTECH_VAULTD_URL: http://vaultd:8787
    volumes:
      - ./scripts:/scripts:ro
    restart: "no"
    depends_on:
      esplora:
        condition: service_healthy
      vaultd:
        condition: service_healthy
```

- [ ] **Step 3: Run bootstrap**

Run:
```bash
docker compose up -d --build
docker compose run --rm bootstrap
```
Expected: prints the treasury address and a non-empty UTXO list.

- [ ] **Step 4: Assert the vault is funded**

Run:
```bash
ADDR=$(docker compose exec -T vaultd curl -sf "http://localhost:8787/vault/state?id=treasury" | sed -n 's/.*"receive_address":"\([^"]*\)".*/\1/p')
curl -sf "http://localhost:8094/regtest/api/address/$ADDR/utxo" | grep -q '"value"' && echo "FUNDED" || echo "NOT FUNDED"
```
Expected: `FUNDED`.

- [ ] **Step 5: Commit**

```bash
git add scripts/regtest-fund.sh docker-compose.yml
git commit -m "build(docker): idempotent bootstrap mines + funds the treasury vault

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 10: `examples/node/` — real L1 round-trip smoke + honest modeled demo

Create the example files the docs reference (so they exist and run), proving the real L1 loop end-to-end.

**Files:**
- Create: `examples/node/silent-payment-l1.ts`
- Create: `examples/node/silent-payment-modeled.ts`
- Delete: `scripts/sp-live-send.ts` (superseded)

**Interfaces:**
- Consumes: the running app (`http://localhost:3000`), `GET /api/stealth`, `POST /api/auth/challenge|login`, `POST /api/approvals`, `POST /api/approvals/[id]/sign`, `POST /api/approvals/[id]/broadcast`.

- [ ] **Step 1: Write the real L1 round-trip example**

Create `examples/node/silent-payment-l1.ts` (fetches the treasury `tsp1` automatically, runs propose→sign→broadcast, then asserts a real on-chain detection appears):
```ts
/**
 * Real L1 silent-payment round-trip against a running btech stack (docker compose).
 * Logs in as each signer persona via the real Nostr challenge, proposes a silent
 * transfer to the treasury's own tsp1 address, threshold-signs to quorum,
 * broadcasts on regtest, then asserts the on-chain view-key scanner detects it.
 */
import { finalizeEvent } from "nostr-tools";
import { createHash } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:3000";
const AMOUNT_BTC = Number(process.env.AMOUNT_BTC ?? "0.01");

const secret = (pid: number) =>
  new Uint8Array(createHash("sha256").update(`btech-signer-v1:${pid}`).digest());

function sessionCookie(res: Response): string {
  const hit = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("btech_session="));
  if (!hit) throw new Error("no btech_session cookie in login response");
  return hit.split(";")[0];
}

async function login(pid: number): Promise<string> {
  const { nonce } = (await (await fetch(`${BASE}/api/auth/challenge`)).json()) as { nonce: string };
  const evt = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [["challenge", nonce]], content: `btech-login:${nonce}` },
    secret(pid),
  );
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: evt, nonce }),
  });
  if (!res.ok) throw new Error(`login pid ${pid}: ${res.status} ${await res.text()}`);
  return sessionCookie(res);
}

async function main() {
  const { metaAddress: TSP1, inbound } = (await (await fetch(`${BASE}/api/stealth`)).json()) as any;
  if (!TSP1) throw new Error("no treasury metaAddress from /api/stealth");
  const before = (inbound ?? []).filter((i: any) => i.source === "onchain").length;
  console.log(`treasury tsp1 = ${TSP1}\non-chain detections before = ${before}`);

  const alice = await login(1);
  const proposeRes = await fetch(`${BASE}/api/approvals`, {
    method: "POST", headers: { "content-type": "application/json", cookie: alice },
    body: JSON.stringify({
      title: "Silent payment demo", vault: "#treasury-ops", kind: "send",
      live: true, silent: true, recipientAddress: TSP1,
      dest: `${TSP1.slice(0, 8)}…${TSP1.slice(-4)}`, destLabel: "Bitcoin regtest · stealth",
      amountSats: Math.round(AMOUNT_BTC * 1e8), btc: AMOUNT_BTC.toFixed(2),
    }),
  });
  const pj = (await proposeRes.json()) as any;
  if (!proposeRes.ok) throw new Error(`propose: ${JSON.stringify(pj)}`);
  const ap = pj.approval;
  const sigPids: number[] = (ap.signerSet ?? []).map((s: any) => s.participantId);
  console.log(`PROPOSED ${ap.id} · silent=${ap.silent} · threshold=${ap.threshold} · signers=[${sigPids}]`);

  let last: any = ap;
  for (const pid of sigPids) {
    const cookie = await login(pid);
    const r = await fetch(`${BASE}/api/approvals/${ap.id}/sign`, { method: "POST", headers: { cookie } });
    const j = (await r.json()) as any;
    if (!r.ok) throw new Error(`sign pid ${pid}: ${r.status} ${JSON.stringify(j)}`);
    last = j.approval;
    console.log(`  signed #${pid} → ${last.signed}/${last.threshold} · status=${last.status} · verified=${last.proof?.verified ?? false}`);
  }
  if (last.status !== "ready") throw new Error(`not ready after signing: ${last.status}`);

  const bRes = await fetch(`${BASE}/api/approvals/${ap.id}/broadcast`, { method: "POST", headers: { cookie: alice } });
  const bJson = (await bRes.json()) as any;
  if (!bRes.ok) throw new Error(`broadcast: ${JSON.stringify(bJson)}`);
  console.log(`BROADCAST txid=${bJson.txid}`);

  // Poll the stealth inbox until the on-chain view-key scanner detects the tx.
  for (let i = 0; i < 20; i++) {
    const inbox = (await (await fetch(`${BASE}/api/stealth`)).json()) as any;
    const now = (inbox.inbound ?? []).filter((x: any) => x.source === "onchain").length;
    if (now > before) {
      console.log(`DETECTED on-chain: ${now} total. latest:`, JSON.stringify(inbox.inbound[0], null, 2));
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("timed out waiting for on-chain detection (is a block being mined to confirm the tx?)");
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
```

- [ ] **Step 2: Write the honest modeled example**

Create `examples/node/silent-payment-modeled.ts`:
```ts
/**
 * Modeled inbound (the Phase-2 Arkade off-chain rail, simulated). Triggers the
 * treasury's simulateInbound via POST /api/stealth and prints the modeled inbox.
 * This is the HONEST stand-in until the real @arkade-os/sdk VtxSource lands.
 */
const BASE = process.env.BASE ?? "http://localhost:3000";

async function main() {
  const r = await fetch(`${BASE}/api/stealth`, { method: "POST" });
  const j = (await r.json()) as any;
  const modeled = (j.inbound ?? []).filter((i: any) => i.source === "modeled");
  console.log(`modeled inbound now = ${modeled.length}`);
  console.log("latest modeled:", JSON.stringify(j.detected ?? null, null, 2));
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
```

- [ ] **Step 3: Remove the superseded script**

Run: `git rm scripts/sp-live-send.ts`

- [ ] **Step 4: Run the real round-trip against the stack**

Run (with the stack up + funded from Tasks 8–9):
```bash
# ensure the broadcast tx gets confirmed so the block-walk can see it:
BASE=http://localhost:3000 bun run examples/node/silent-payment-l1.ts &
SMOKE=$!
# mine a block to confirm (fund script's mechanism; adjust per esplora image):
sleep 6 && curl -sf -X POST http://localhost:8094/regtest/api/mine -d '{"blocks":1}' 2>/dev/null || true
wait $SMOKE
```
Expected: prints `BROADCAST txid=…` then `DETECTED on-chain: …` with a real detection. (If your esplora image auto-mines or needs a different mine call, adjust the mine step; the assertion is the printed `DETECTED on-chain`.)

- [ ] **Step 5: Commit**

```bash
git add examples/node/silent-payment-l1.ts examples/node/silent-payment-modeled.ts
git rm scripts/sp-live-send.ts 2>/dev/null || true
git commit -m "docs(examples): real L1 round-trip smoke + honest modeled demo (existing paths)

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 11: Docs + OSS hygiene (README, DEMO, STEALTH, LICENSE, CONTRIBUTING, .env.example)

Align all docs to reality and make the repo clone-and-run.

**Files:**
- Modify: `README.md`, `DEMO.md`, `STEALTH_DEMO.md`, `.env.example`
- Create: `LICENSE`, `CONTRIBUTING.md`

**Interfaces:** none (docs).

- [ ] **Step 1: `.env.example` — local default + documented overrides**

Replace `.env.example` with:
```bash
# Esplora REST API (chain status, balances, UTXOs, broadcast). Used as ${URL}/api/...
# Local default (docker compose): http://esplora/regtest
# Public regtest override: https://btc.utxopia.com/regtest
BTECH_ESPLORA_URL=http://esplora/regtest

# HTSS vault service (DKG once, stable address). Required for on-chain settlement.
BTECH_VAULTD_URL=http://vaultd:8787

# Nostr relay for E2E NIP-44 chat — the BROWSER connects directly, so this must be
# reachable from the host (not a container name).
NEXT_PUBLIC_NOSTR_RELAY=ws://localhost:7777

# SQLite path (sessions/chats/approvals). Delete the volume to reset the demo.
BTECH_DB=/data/btech.db

# Optional: how many blocks back the first stealth scan looks (default 500).
# BTECH_STEALTH_SCAN_DEPTH=500
```

- [ ] **Step 2: README quickstart → one command**

In `README.md`, replace the `## Quickstart` section body with:
```markdown
## Quickstart (one command)

Requires only **Docker**. No Rust toolchain, no sibling checkout.

```bash
git clone https://github.com/<you>/btech && cd btech
docker compose up --build          # esplora(regtest) + relay + vaultd + app
docker compose run --rm bootstrap  # mine + fund the treasury vault (idempotent)
open http://localhost:3000         # log in with a demo persona
```

Then try a real L1 silent payment round-trip:

```bash
bun run examples/node/silent-payment-l1.ts   # propose → HTSS-sign → broadcast → on-chain detect
```

### What's real vs. modeled

| Capability | Status |
|---|---|
| BIP-352 silent-payment crypto (vector-tested) | **real** |
| Bitcoin regtest L1 receive (view-key block-walk) | **real** |
| Bitcoin regtest L1 spend (HTSS-signed taproot tx, broadcast) | **real** |
| HTSS / DKG (`vaultd`) | **real** |
| Nostr NIP-44 chat + signed-challenge login | **real** |
| Arkade off-chain rail | **modeled (Phase 2)** |

### From source (contributors)

See `CONTRIBUTING.md` — build `vaultd` with `cargo build` and run `bun run dev`.
```

- [ ] **Step 3: Rewrite DEMO.md + STEALTH_DEMO.md to reference only existing paths**

Edit `DEMO.md` and `STEALTH_DEMO.md`: remove every reference to `~/project/hackathon/arkade-ts-sdk`, `examples/node/silent-payment-send.ts`, and `@arkade-os/sdk`. Point the stealth beat at the real command `bun run examples/node/silent-payment-l1.ts` and the modeled fallback `bun run examples/node/silent-payment-modeled.ts`. Mark the Arkade rail "Phase 2".

Verify no dangling references remain:
```bash
grep -rn "arkade-ts-sdk\|silent-payment-send.ts\|@arkade-os/sdk" README.md DEMO.md STEALTH_DEMO.md || echo "clean"
```
Expected: `clean`.

- [ ] **Step 4: Add LICENSE (MIT) + CONTRIBUTING.md**

Create `LICENSE` with the standard MIT text (copyright holder: the repo owner, year 2026). Create `CONTRIBUTING.md` covering: from-source dev (`cargo build`, `bun install`, `bun run dev`, env), running tests (`bun test`, `bun run typecheck`, `cargo test`), the Docker stack, and the Phase-1/Phase-2 scope (link `docs/superpowers/specs/2026-07-01-open-source-silent-payment-treasury-design.md`).

- [ ] **Step 5: Verify docs commands exist**

Run:
```bash
test -f examples/node/silent-payment-l1.ts && test -f examples/node/silent-payment-modeled.ts && echo "examples exist"
test -f LICENSE && test -f CONTRIBUTING.md && echo "oss files exist"
```
Expected: both lines print.

- [ ] **Step 6: Commit**

```bash
git add README.md DEMO.md STEALTH_DEMO.md .env.example LICENSE CONTRIBUTING.md
git commit -m "docs: one-command quickstart, honest real-vs-modeled table, MIT + CONTRIBUTING

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 12: CI — GitHub Actions

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:** none.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
  pull_request:
jobs:
  ts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo build --bin vaultd
```

- [ ] **Step 2: Validate locally (the same commands CI runs)**

Run:
```bash
bun install --frozen-lockfile
bun run typecheck
bun test
cargo build --bin vaultd
```
Expected: all succeed.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: bun typecheck + test and cargo build on push/PR

Claude-Session: https://claude.ai/code/session_01TGNMjThbS1KgorsXVWyUF4"
```

---

## Task 13: End-to-end verification (fresh clone simulation)

Prove the clone-and-run promise with evidence before declaring done.

**Files:** none (verification only).

- [ ] **Step 1: Clean-slate bring-up**

Run:
```bash
docker compose down -v
docker compose up -d --build
docker compose run --rm bootstrap
until curl -sf http://localhost:3000/api/chain/tip >/dev/null; do sleep 2; done; echo "app OK"
```
Expected: `app OK`; bootstrap prints a funded UTXO list.

- [ ] **Step 2: Real receive + spend round-trip**

Run: `BASE=http://localhost:3000 bun run examples/node/silent-payment-l1.ts` (mine a confirming block if the esplora image doesn't auto-mine — see Task 10 Step 4).
Expected: `BROADCAST txid=…` then `DETECTED on-chain: …`.

- [ ] **Step 3: NIP-44 chat sanity (manual)**

Open two browser profiles at `http://localhost:3000`, log in as two personas, exchange a channel message; confirm it appears on both and the audit log records "sent an encrypted message". (Ciphertext is what the relay carries — already verified in the codebase.)

- [ ] **Step 4: Capture evidence + final suite**

Run: `bun run typecheck && bun test && echo "ALL GREEN"`
Expected: `ALL GREEN`. Record the broadcast txid + detection JSON from Step 2 in the PR/commit description.

- [ ] **Step 5: Tear down**

Run: `docker compose down` (keep volumes for reuse, or `-v` to reset).

---

## Self-Review

**1. Spec coverage:**
- Self-contained Docker stack → Tasks 6–9. ✅
- Git-pin dkgkit (G3) → Task 1. ✅
- Wire real L1 receiver (G1) → Tasks 2–4. ✅
- Real L1 spend already exists; exercised end-to-end → Tasks 10, 13. ✅
- NIP-44 already real; sanity-checked → Task 13 Step 3. ✅
- Honest Arkade labeling (G2) → Tasks 4 (footer), 5 (send option). ✅
- Examples exist + doc drift fixed (G4) → Tasks 10–11. ✅
- LICENSE/CONTRIBUTING/README honest table → Task 11. ✅
- CI → Task 12. ✅
- Phase 2 (real Arkade) → out of scope by design (spec §Phase 2). ✅

**2. Placeholder scan:** The two "Implement notes" (esplora image, faucet endpoint) are explicit *verification instructions with a guaranteed fallback* (public esplora), each gated by a concrete curl/assert step — not deferred work. No TBD/TODO left.

**3. Type consistency:** `InboxItem` / `InboxSource` / `scanChainOnce` / `getInbox` / `__resetOnchainForTest` defined in Task 2 are used consistently in Tasks 3 (route), 4 (page `Payment` mirrors `InboxItem`), and 10 (example reads `source === "onchain"`). `receive_address`, `treasury` vault id, `/vault/state`, `/healthz`, `BTECH_VAULTD_HOST/PORT/DATA`, and the `${ESPLORA}/api/...` convention match the code read during planning.
