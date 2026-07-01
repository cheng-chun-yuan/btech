# Design: btech → fully-functional, open-source, one-command silent-payment + HTSS treasury

**Date:** 2026-07-01
**Status:** Approved (design); Phase 1 fully specified, Phase 2 sketched
**Author:** brainstormed with the maintainer

---

## Goal

Make btech a **fully functional, open-source, easy-to-setup** Nostr **NIP-44**
silent-payment treasury that works on **Bitcoin regtest** (Phase 1) and **Arkade**
(Phase 2), runnable by anyone with **one command**.

The user's three governing decisions (from brainstorming):

1. **Arkade — both, phased.** Phase 1 makes L1 + NIP-44 + packaging bulletproof
   and clone-and-run; Phase 2 adds a *real* Arkade rail on top of the existing
   seam.
2. **Setup UX — Docker one-command.** `docker compose up` brings up the whole
   self-contained stack; no host Rust toolchain required.
3. **Quality bar — clone-and-run OSS demo.** Every cryptographic step is real and
   verifiable end-to-end; operationally demo-grade (`vaultd` may hold shares). Add
   LICENSE / CONTRIBUTING / honest README.

---

## Ground truth: what is already real vs. simulated

Established by reading the implementations (TS + Rust, incl. the sibling `dkgkit`
crate) during brainstorming.

### Already REAL — do not rebuild, only wire/verify
- **BIP-352 silent-payment crypto** (`lib/silentpayment/crypto.ts`,
  `src/domain/silent_payments.rs`) — validated against the official test vectors
  (`tests/vectors/bip352_send_and_receive.json`).
- **L1 receive detector** (`lib/silentpayment/esplora-scan.ts`) — real Esplora
  block-walk + BIP-352 input-eligibility scan + view-key counter loop. **Tested
  but ORPHANED — not wired into any route** (see gap G1).
- **L1 spend** — `app/api/_lib/settle.ts` selects real confirmed UTXOs from
  Esplora, derives the one-time P2TR output for a `tsp1` recipient
  (`deriveInternalSend`), asks `vaultd` to build + threshold-sign a real key-path
  Taproot tx, and broadcasts it (`broadcastTx` → real `POST /api/tx`). Real txid;
  502 on failure (no fake-txid path). **Requires `BTECH_VAULTD_URL` + a funded
  vault address.**
- **HTSS / DKG** — `vaultd` runs a real FROST grouped-threshold DKG once, persists
  it, and serves a stable vault + `tsp1` address (`src/bin/vaultd.rs`,
  `src/app.rs`, `src/domain/vault.rs`).
- **Nostr NIP-44** — messages are genuinely encrypted **client-side**
  (`app/ui/wallet/nostr-signer.ts` via `nostr-tools/nip44`); the **ciphertext** is
  what is relayed. Only static seeded demo scrollback in SQLite is plaintext.
- **Nostr relay** — the browser connects **directly** over WebSocket
  (`nostr-tools` `SimplePool`) to a real relay (`app/ui/wallet/nostr-chat.ts`);
  URL from `NEXT_PUBLIC_NOSTR_RELAY`.
- **Nostr login** — real signed-challenge (kind 27235, Schnorr-verified
  server-side; challenge consumed one-time).

### SIMULATED / gaps to close
- **G1 — L1 receive not wired.** The stealth inbox (`/api/stealth` →
  `treasury.getInbound()`) is fed only by the in-memory modeled scanner
  (`ingestCandidate` / `simulateInbound`), plus `settle.ts` injecting the
  just-broadcast tx as a *model* of an operator stream. The real block-walk
  detector (`scanBlocks`) is never called by the app. → The UI never shows a
  genuine on-chain silent-payment detection.
- **G2 — Arkade entirely modeled.** No `@arkade-os/sdk`, no `arkd` client
  anywhere. `simulateInbound()` fabricates payments; the `<option>Arkade</option>`
  in the send form is dead (settle ignores `module`). Feasible to make real:
  `@arkade-os/sdk` is on npm (v0.4.40) with a local checkout (v0.4.15).
- **G3 — setup friction.** `Cargo.toml` uses **path deps** to a sibling
  `../dkgkit` checkout + requires a host Rust toolchain. `dkgkit` is a **public
  GitHub repo** (`github.com/cheng-chun-yuan/dkgkit`, rev `751ed81`), so this is
  fixable via git-pinned deps + building inside Docker.
- **G4 — doc drift.** `DEMO.md` / `STEALTH_DEMO.md` reference
  `examples/node/silent-payment-send.ts` and `silent-payment-l1.ts` that **do not
  exist**, point at an external `~/project/hackathon/arkade-ts-sdk` checkout, and
  credit `@arkade-os/sdk` which is not a dependency. Only `scripts/sp-live-send.ts`
  exists.

---

## Non-goals (this spec)

- Production custody hardening (per-device/per-participant shares with no
  server-held key material; unifying the authorization-signature with the on-chain
  spend-signature). Explicitly deferred — quality bar is "clone-and-run OSS demo".
- Mainnet. Regtest only.
- Reshare/recovery UI beyond what already exists.
- Real Arkade *implementation* (that is Phase 2; this spec only sketches it).

---

## Phase 1 — the deliverable

### Architecture: self-contained regtest stack (`docker compose up`)

Six services, one command, no host Rust/toolchain:

| Service | Image / build | Role |
|---|---|---|
| `bitcoind` | upstream bitcoind (regtest) | base chain |
| `electrs` | Blockstream electrs | **Esplora REST API** (blocks, tx, address UTXOs, `POST /api/tx`) → default `BTECH_ESPLORA_URL` |
| `relay` | `nostr-rs-relay` | Nostr relay, port 7777 → `NEXT_PUBLIC_NOSTR_RELAY` |
| `vaultd` | `Dockerfile.rust` (git-pinned dkgkit) | DKG once, persist to volume, serve `:8787`, stable vault + `tsp1` |
| `bootstrap` | one-shot init | wait for chain → mine maturity → **fund the vault address** with confirmed UTXOs → mine to confirm; **idempotent** |
| `app` | `Dockerfile.app` (bun/Next) | console on `:3000` |

**Decisions (approved defaults):**
- Chain stack defaults to **local electrs** (fully self-contained). The public
  `btc.utxopia.com/regtest` remains a documented one-line `BTECH_ESPLORA_URL`
  override for a lighter no-local-chain path.
- **LICENSE = MIT.**
- **`NEXT_PUBLIC_NOSTR_RELAY`** must be browser-reachable from the host; the relay
  port is published and defaults to `ws://127.0.0.1:7777`. The app container runs a
  dev server (or a build-arg-baked production build) so the public env var reaches
  the browser without build gymnastics — chosen at implementation time, dev-server
  preferred for zero-config.

### Component changes

1. **`Cargo.toml`** — convert `dkgkit-nostr` / `dkgkit-sdk` **path deps → git deps
   pinned to `dkgkit@751ed81`** (keep `features = ["live"]`). Removes the sibling
   checkout requirement. Verify `cargo build` succeeds against the git dep.

2. **Docker** — `Dockerfile.rust` (multi-stage: build `vaultd`, slim runtime),
   `Dockerfile.app` (bun + Next), `docker-compose.yml` wiring the six services with
   healthchecks + `depends_on: { condition: service_healthy }`.

3. **Wire the real L1 receiver (G1)** — the stealth inbox must reflect **genuine
   on-chain detections**. Add a scan path that calls
   `scanBlocks(viewKey, fromHeight, toHeight)` over the treasury view key and
   surfaces real `L1Detection`s (real txid/vout/amount/blockHeight) in
   `/api/stealth`. Design:
   - Track a persisted `lastScannedHeight`; on GET (or a dedicated
     `POST /api/stealth/scan`) walk new blocks up to tip and merge detections into
     the inbox, de-duplicated by `txid:vout`.
   - Keep `simulateInbound` as an explicit, clearly-labeled "Simulate inbound
     (demo)" action — not the default source.
   - The inbox distinguishes **real (on-chain)** detections from **modeled** ones
     in its data shape and UI.

4. **`examples/node/`** — make the referenced examples exist and run:
   - `silent-payment-l1.ts` — real L1 round-trip: log in as personas (real Nostr
     challenge), propose a silent transfer to the treasury `tsp1`, threshold-sign
     to quorum, broadcast on regtest, then block-walk-detect and assert the inbox
     grew. (Supersedes / absorbs `scripts/sp-live-send.ts`.)
   - `silent-payment-modeled.ts` — the current `simulateInbound` path, honestly
     named as the Phase-2-placeholder Arkade model.
   - Move `scripts/sp-live-send.ts` into `examples/node/` (or delete once
     superseded).

5. **Honest UI labeling (G2/G4)** — mark the dead `<option>Arkade</option>` and any
   "off-chain VTXO" copy as **"modeled (Phase 2)"** until Phase 2 lands. The L1
   path is presented as real.

### Docs & OSS hygiene

- **README** — quickstart becomes `docker compose up` → open `localhost:3000`;
  add an honest "what's real vs. modeled" table; keep the from-source path for
  contributors.
- **DEMO.md / STEALTH_DEMO.md** — rewrite to reference **only commands/files that
  exist** in this repo (no external SDK checkout, no non-existent examples).
- **LICENSE** (MIT), **CONTRIBUTING.md**, updated **`.env.example`** (local
  electrs default + documented overrides).
- **GitHub Actions CI** — `bun test` + `tsc --noEmit` + `cargo build` on push.

### Data flow (real Phase-1 loop)

```
docker compose up
  → bitcoind → electrs → relay → vaultd (DKG, stable tsp1) → bootstrap funds vault → app

Receive:  payment to treasury tsp1 → real taproot tx on regtest
          → block-walk scanner (view key) detects → inbox shows REAL detection (txid/vout/amount)
Spend:    propose → HTSS threshold-sign (authorization) → settle builds real UTXO-funded
          taproot tx, threshold-signs the sighash, broadcasts → real txid
Chat:     browser ↔ real relay, NIP-44 encrypted client-side
```

### Error handling

- Compose healthchecks + `service_healthy` gating so `app`/`bootstrap` start only
  when deps are ready.
- `bootstrap` retries while services warm up and is idempotent (safe to re-run;
  detects an already-funded vault).
- Existing "`vaultd` required for on-chain settlement" error is preserved and
  documented; Esplora-unreachable surfaces clearly with the override documented.

### Testing / verification

- Keep all existing vitest suites (crypto vectors, esplora-scan, scan, dm, auth,
  governance, subledger, …) + `tsc --noEmit`.
- Add an **integration smoke** — `examples/node/silent-payment-l1.ts` run against
  the live compose stack — asserting a real detection appears.
- `cargo build` (and existing Rust tests) against the git-pinned dkgkit.
- **Verification before completion:** actually run `docker compose up`, reproduce
  receive + spend, and capture evidence before declaring done.

---

## Phase 2 — real Arkade rail (sketch; detailed at Phase-2 start)

- Add `arkd` (regtest) to `docker-compose.yml`.
- `bun add @arkade-os/sdk`.
- Implement a real **`VtxSource`** (the `lib/silentpayment/scanner.ts:58` seam):
  subscribe to the operator's VTXO stream via the SDK, map each spent VTXO tx to a
  `CandidateVtx` (input pubkeys + outpoints + taproot outputs), and feed
  `ingestCandidate` — so the same view-key scanner detects Arkade payments for
  real.
- Implement a real **off-chain send**: spend a VTXO and create an output to the
  BIP-352-derived one-time key `P` (silent payment over Arkade).
- Confirm at Phase-2 start that the SDK exposes the primitives silent payments
  need (spent-VTXO input pubkeys + outpoints for scanning; a VTXO output to an
  arbitrary taproot key `P`). The crypto and the seam already exist; Phase 2 is
  integration, not new cryptography.
- Flip the UI labels from "modeled (Phase 2)" to real; unify the demo examples.

---

## Success criteria (Phase 1)

1. A fresh clone + `docker compose up` yields a working console at
   `localhost:3000` with **no** host Rust toolchain and **no** sibling `../dkgkit`
   checkout.
2. The stealth inbox shows at least one **genuine on-chain** BIP-352 detection
   (real txid), produced by the block-walk scanner over the view key.
3. A propose → threshold-sign → broadcast spend produces a **real regtest txid**.
4. Chat messages are NIP-44-encrypted client-side and relayed over the real relay.
5. Every command/file referenced by README / DEMO.md / STEALTH_DEMO.md **exists
   and runs**.
6. Repo has LICENSE (MIT), CONTRIBUTING, honest README, and green CI.
