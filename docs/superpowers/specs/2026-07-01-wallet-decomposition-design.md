# Design: wallet.tsx decomposition + backend data consolidation

**Date:** 2026-07-01
**Status:** Approved (design)
**Scope:** Code-quality refactor of the wallet feature. A distinct sub-project;
runs BEFORE resuming the paused OSS/Docker plan (Tasks 7–13 of
`2026-07-01-oss-silent-payment-treasury-phase1.md`).

---

## Goal

Raise code quality by decomposing the 2135-line `app/ui/wallet/wallet.tsx`
god-file into well-bounded components + hooks + a typed API client, and moving
data aggregation and protocol derivation to the backend so the frontend is thin
and presentational. Behavior is preserved exactly.

### Governing decisions (from brainstorming)
- **Scope:** decompose `wallet.tsx` + its data layer only. Other files are
  already reasonably sized — no whole-app overhaul.
- **Heavy computation → backend:** consolidate the chatty per-vault balance
  fetching into one server endpoint; do protocol derivation/formatting
  server-side; **NIP-44 encrypt/decrypt + the Nostr relay connection stay
  client-side** (E2E security — moving them server-side would break the model).
- **`relTime` ("2m ago") stays client-side** — it must tick with the wall clock;
  server-rendering it makes it stale.
- **Activity stays its own endpoint** (`/api/chain/activity`) — the new overview
  endpoint does NOT fold it in.
- **Sequencing:** refactor now, then resume OSS/Docker.

---

## Problem (current state)

`app/ui/wallet/wallet.tsx` (2135 lines) is a single client module containing:
- `Wallet()` — a ~850-line god-component: **33 `useState`, 15 `useEffect`, 27
  `fetch` calls**, all orchestration + layout.
- ~18 sub-components inlined: `Sidebar`, `Overview`, `Stat`, `LiveVaultCard`,
  `Approvals`, `TabButton`, `ChatDetail` (327 lines), `AddressChip`,
  `MetaAddressChip`, `VaultBalance`, `OngoingProposals`, `AuditPanel`, `Field`,
  `VaultPanel`, `Plan`.
- 9 helpers: `clampNeed`, `quorumOf`, `spendOf`, `chatToPolicyConfig`, `fmtBtc`,
  `relTime`, `challengeTemplate`, `initialsOf`, `shortHex`.

Chatty client compute to move server-side: `wallet.tsx:210-222` loops over vaults
issuing **one `/api/chain/address/${addr}` request per vault** (N round-trips),
then `reduce`s totals client-side (`:805-807`). NIP-44 and the relay
(`nostr-chat.ts`, `nostr-signer.ts`) are correctly client-side and stay.

No direct unit tests exist for `wallet.tsx`; the safety net is `tsc`, the
existing suites (`chat-merge`, `nostr-chat`, `nostr-signer`, `policy-diff`), new
util/endpoint tests, and a browser smoke.

---

## Approach (chosen): incremental in-place decomposition

Keep `app/ui/wallet/` as the feature root; add `components/`, `hooks/`, `lib/`
subdirs. Move each sub-component and helper to its own file (behavior-preserving),
extract the god-component's state into hooks that call a typed API client, and add
one server aggregation endpoint. Each step is independently reviewable, stays
`tsc`-clean, keeps tests green, and leaves the app runnable.

Rejected: **big-bang rewrite** (high regression risk, not YAGNI);
**container/presentational split only** (leaves the god-state untouched).

### Target structure
```
app/ui/wallet/
  wallet.tsx                    # slim orchestrator (~200 lines): layout + compose hooks/panels
  components/
    sidebar.tsx                 # Sidebar (channels/DMs, signer switcher)
    overview.tsx                # Overview + Stat + LiveVaultCard + VaultBalance
    approvals.tsx               # Approvals + OngoingProposals + TabButton
    chat-detail.tsx             # ChatDetail (send-form extracted out)
    send-form.tsx               # propose/send form (incl. the modeled-Arkade option)
    audit-panel.tsx             # AuditPanel
    vault-panel.tsx             # VaultPanel + Field + Plan
    address-chip.tsx            # AddressChip + MetaAddressChip
    approval-card.tsx           # (exists)
    policy-editor.tsx           # (exists)
    profile-popover.tsx         # (exists)
  hooks/
    use-session.ts              # personas, challenge/login, me, logout, signer switch
    use-chats.ts                # chats + DMs, active chat, members, provision
    use-approvals.ts            # approvals list, propose, sign, broadcast
    use-audit.ts                # per-chat audit polling
    use-wallet-overview.ts      # single /api/wallet/overview fetch (balances/totals/derived policy)
    use-btc-price.ts            # (exists)
  lib/
    api-client.ts               # typed wrappers around every /api/* call the wallet uses
    format.ts                   # fmtBtc, relTime, initialsOf, shortHex (client-side display)
    policy.ts                   # thin client mirror ONLY where the propose form must preview pre-submit
  types.ts                      # (exists; extend with API DTOs)
  nostr-chat.ts · nostr-signer.ts · chat-merge.ts · policy-diff.ts   # exist; client crypto/transport — unchanged
```
(Existing `approval-card.tsx`, `policy-editor.tsx`, `profile-popover.tsx` already
live here; new component files join them under `components/` — moving the three
existing ones into `components/` is optional and only if it doesn't churn imports
excessively.)

### Backend (heavy computation → server)
- **NEW `GET /api/wallet/overview`** — for each vault the server fetches its
  on-chain balance from Esplora, aggregates totals (`totalSats`, `totalBtc`,
  `totalKeys`), and derives per-vault `threshold`/`quorum`/`spend`. Returns one
  payload:
  ```ts
  {
    vaults: Array<{ id: string; name: string; receiveAddress: string | null;
                    balanceSats: number; balanceBtc: string;
                    threshold: number; quorum: string; spend: string }>;
    totals: { totalSats: number; totalBtc: string; totalKeys: number };
  }
  ```
  Replaces the client balance loop (`wallet.tsx:210-222`) and the client `reduce`
  totals (`:805-807`). One call, not N.
- **Server policy module** — move `clampNeed`/`quorumOf`/`spendOf`/
  `chatToPolicyConfig` derivation into `app/api/_lib/policy.ts` (or reuse the
  existing `app/api/approvals/policy-*` modules) so the overview/chats/approvals
  routes emit computed fields and the client stops recomputing protocol math.
  Keep a thin client `lib/policy.ts` ONLY for the propose form's pre-submit
  preview (or have the form POST raw inputs and let the server compute).
- **Unchanged:** `/api/chain/activity` (activity stays its own endpoint),
  `/api/wallet/state`, NIP-44 client crypto, the relay connection.

### Data flow
`components → hooks → lib/api-client → /api/* → server (esplora + vaultd + db +
derivation)`. Server computes; components render. Overview is one request;
activity remains its own request; chat content still flows browser↔relay directly.

---

## Error handling
- `use-wallet-overview` surfaces a loading state and, on failure, leaves prior
  balances/`—` rather than crashing (mirrors today's per-address try/catch that
  treats an unreachable address as 0/loading).
- `/api/wallet/overview` fetches per-vault balances defensively (an unreachable
  Esplora address → that vault's balance is `0`/pending, not a 500 for the whole
  payload), matching current client behavior.
- The api-client centralizes non-OK handling (throw typed errors) so hooks handle
  failures uniformly.

## Testing
- **Behavior preservation:** structural moves keep JSX + logic identical, only
  relocated. Gate each step: `bun run typecheck` clean + full `bun run test`
  green (existing suites: `chat-merge`, `nostr-chat`, `nostr-signer`,
  `policy-diff`).
- **New unit tests:** `lib/format.ts` (fmtBtc/relTime/initials/shortHex),
  `lib/policy.ts` + the server policy module (threshold/quorum/spend derivation),
  `lib/api-client.ts` (mocked `fetch`).
- **New endpoint test:** `/api/wallet/overview` aggregation with mocked Esplora +
  DB (follow existing route-test patterns, e.g. `approvals/route.test.ts`).
- **Browser smoke (the real regression gate):** on `http://localhost:3000` (not
  `127.0.0.1` — HMR WS quirk), verify login (persona) → channels render with
  balances → propose a transfer → sign to quorum → send a chat message → audit
  log updates. Run after step 6 and at the end.

---

## Sequencing (each step = one reviewable task)
1. Extract pure helpers → `lib/format.ts` + client `lib/policy.ts` (+ unit tests);
   re-point `wallet.tsx` imports. No behavior change.
2. Extract leaf components → `components/` (`Stat`, `TabButton`, `AddressChip`,
   `MetaAddressChip`, `Field`, `LiveVaultCard`, `VaultBalance`).
3. Extract panels → `components/` (`Sidebar`, `Overview`, `Approvals`,
   `AuditPanel`, `VaultPanel`, `Plan`, `OngoingProposals`).
4. Extract `ChatDetail` + `send-form` → `components/`.
5. Backend: `app/api/_lib/policy.ts` (server derivation) + `GET
   /api/wallet/overview` (+ tests). No client change yet.
6. Extract hooks (`use-session`, `use-chats`, `use-approvals`, `use-audit`,
   `use-wallet-overview`) + `lib/api-client.ts`; slim `wallet.tsx` to an
   orchestrator; swap the balance loop + client totals → `use-wallet-overview`.
7. Final browser smoke + full `bun run test` + `bun run typecheck`.

---

## Success criteria
1. `wallet.tsx` drops from 2135 lines to a thin orchestrator (~≤250 lines); each
   extracted file has one clear responsibility.
2. The browser makes **one** `/api/wallet/overview` call for balances/totals
   instead of N per-vault `/api/chain/address` calls; totals + policy are
   computed server-side.
3. NIP-44 + relay remain client-side and functional.
4. `bun run typecheck` clean; full `bun run test` green (existing + new tests);
   the browser smoke passes end-to-end.
5. No user-visible behavior change.

## Non-goals
- Any whole-app / API / subledger restructure beyond the wallet feature + the one
  overview endpoint + the policy module.
- Visual/design changes. Pixels stay the same.
- Moving NIP-44 or the relay server-side.
