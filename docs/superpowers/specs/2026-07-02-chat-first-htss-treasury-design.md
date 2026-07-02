# Chat-first HTSS company treasury on Nostr — greenfield architecture

**Status:** Approved (design) · 2026-07-02
**Author:** brainstormed with the maintainer
**Relationship to btech:** greenfield design; btech is the reference prototype
whose validated pieces (BIP-352 TS crypto, Esplora scanner, dkgkit FROST,
collapsed two-round signing UX) are reused as libraries, not as architecture.
**Repository:** a new repo, **`bChannel`** — btech is never refactored; see
"Repository strategy" below.

---

## Goal

A **self-hosted, open-source company treasury whose entire control surface is a
Slack-like chat**: channels are NIP-29 Nostr groups, vault operations are signed
Nostr events rendered as interactive cards, custody is real HTSS/FROST threshold
signing with **shares held only on members' devices**, and **BIP-352 silent
payments are the default** for both sending and receiving — on Bitcoin L1
(regtest first; signet/testnet4/mainnet by configuration) and on Arkade.

## Decisions locked during brainstorming

1. **Greenfield** — not an evolution of the btech codebase; btech is the
   reference prototype.
2. **Self-hosted per company** — each company runs its own relay, steward, and
   chain backends (`docker compose up`), like self-hosted Mattermost.
3. **Per-member device custody** — FROST shares live in members' browsers;
   signing rounds run over Nostr; no server ever holds a share.
4. **Chat-first** — everything is a message; the wallet panel is secondary.
5. **Rail abstraction, regtest + Arkade first** — signet/testnet4/mainnet are
   configuration of the L1 rail, not new code.
6. **Web client + local key vault** — one PWA; shares generated in-browser,
   passkey-wrapped at rest; device loss handled by HTSS reshare.
7. **NIP-29 groups + custom vault event kinds** — Nostr-standard group
   structure; NIP-44 encryption.
8. **All channel content is encrypted** (user revision to the initial
   public/private split): every channel — plain or vault — encrypts content
   with NIP-44 to a per-channel key. There is no plaintext channel flavor.
9. **Pilot-grade quality bar** — a 5–50-member company can self-host and govern
   a real vault on regtest/signet with genuine threshold security; mainnet is
   designed-for but not certified at v1.
10. **Architecture A: event-sourced on the relay with an untrusted steward** —
    chosen over a fat-backend (DB source of truth) and pure P2P (no
    coordinator).
11. **New repository `bChannel`** (user, 2026-07-02) — no refactoring of the
    btech codebase; a fresh repo, well-organized from the first commit.

---

## Repository strategy — `bChannel`

- **btech is frozen as the reference prototype.** Nothing in it is refactored
  or moved for this project; it stays runnable as-is.
- **Reuse by extraction, not by import.** Validated code is copied into
  `bChannel` packages together with its tests and vectors — the BIP-352 TS
  crypto + official vectors, the Esplora block-walk scanner, and the collapsed
  two-round ceremony semantics. `dkgkit` is consumed as a git-pinned dependency
  and compiled to WASM; it is the one shared artifact between the two repos.
- **Monorepo layout (Bun workspaces):**

  ```
  bChannel/
    packages/
      protocol/     event kinds, schemas, channel-key + gift-wrap helpers (no I/O)
      crypto/       BIP-352 (with vectors), dkgkit-wasm bindings, key-vault
      rails/        Rail interface, L1Rail, ArkadeRail + conformance suite
      steward/      ceremony sequencer, scanner, policy, broadcast (Bun service)
      web/          PWA chat client
    deploy/         docker-compose, relay29 + chain-backend configs
    docs/           this spec (copied at init), plans, ADRs
  ```

  Dependency direction is one-way: `web`/`steward` → `rails` → `crypto` →
  `protocol`. `protocol` and `crypto` are pure (no network, no storage), which
  is what keeps them unit-testable against vectors.
- **Quality gates from the first commit:** CI (typecheck, lint, tests) exists
  before any feature code; conventional commits; every package lands with its
  tests; MIT license, README, and CONTRIBUTING at init. The repo is born the
  way btech had to be retrofitted.

---

## 1. System overview & trust boundaries

One company = one deployment with four component classes:

```
 Member devices (browsers)                    Company infra                     Chains
┌──────────────────────────┐      ┌────────────────────────────────┐   ┌─────────────────┐
│ Web client (PWA)         │◄────►│ Relay (NIP-29 groups)          │   │ bitcoind+electrs │
│ · chat UI (channels/DMs) │ wss  │ · source of truth (events)     │   │  (regtest│signet│
│ · key vault: HTSS share, │      │ · relay-enforced membership    │   │   mainnet=config)│
│   passkey-wrapped, local │      ├────────────────────────────────┤   ├─────────────────┤
│ · signer engine (WASM    │      │ Steward (untrusted coordinator)│◄─►│ arkd (Arkade)   │
│   FROST from dkgkit)     │      │ · ceremony sequencer (DKG/sign)│   └─────────────────┘
│ · BIP-352 send crypto    │      │ · BIP-352 scanner (scan key    │
└──────────────────────────┘      │   ONLY — can watch, not spend) │
                                  │ · rail adapters (L1, Arkade)   │
                                  │ · policy checker, tx broadcast │
                                  └────────────────────────────────┘
```

### Components

- **Relay** — a NIP-29-capable Nostr relay; default implementation is
  `relay29` (the reference NIP-29 relay), swappable for any relay that
  implements NIP-29 group management. It is the **system of record**:
  every proposal, approval, signing contribution, and receipt is a signed event
  stored here. Relay-enforced group membership gates reads/writes as defense in
  depth (encryption is the real barrier — see §2).
- **Steward** — a single TypeScript (Bun) service; "another Nostr client with
  superpowers but no keys." Responsibilities: sequence DKG and signing
  ceremonies (ordering, timeouts, replacement), run the BIP-352 scanner with
  the **delegated scan key only**, evaluate vault policy, build transactions
  via rail adapters, aggregate partial signatures (public math, no key
  material), broadcast, and post status/receipt cards. Its local state is a
  **rebuildable cache**: on restart it replays the relay and resumes the
  scanner from a persisted block cursor.
- **Web client (PWA)** — chat UI, local key vault (Nostr identity key + FROST
  share, encrypted at rest with a passkey/WebAuthn-derived key, never
  transmitted), the signer engine (dkgkit compiled to WASM), and BIP-352 send
  derivation. Requests persistent storage; warns when the browser denies it.
- **Chain backends** — bitcoind + electrs (Esplora REST) for L1;
  `arkd` for Arkade. Regtest images ship in the compose file; signet/mainnet
  deployments point the L1 rail at a hosted Esplora instead.

### Language strategy

Because shares live in browsers, FROST must run in the browser: **dkgkit
compiles to WASM** and is the only Rust in the system. The steward is
TypeScript, natively reusing the prototype's vector-validated BIP-352 crypto,
the Esplora block-walk scanner, and `@arkade-os/sdk`. There is no Rust server
and no vaultd.

### Trust boundaries / compromise matrix

| Compromised | Attacker gets | Funds at risk? |
|---|---|---|
| Steward | incoming-payment visibility (scan key), **vault-channel content** (it holds those channels' keys to post cards), censorship/DoS | No |
| Relay | ciphertext + group metadata, DoS | No |
| < threshold member devices | those shares (reshare rotates them out) | No |
| ≥ threshold member devices | a signing quorum | **Yes — the defined security boundary** |

BIP-352 scan-key delegation is watch-only by construction: the steward can
detect and attribute incoming payments but cannot derive spending keys. The
privacy trade-off (the steward operator sees incoming amounts) is accepted and
documented.

---

## 2. Identity, channels, and the chat-first event model

### Identity & onboarding

A member **is** a Nostr keypair, generated in-browser at onboarding and stored
in the passkey-wrapped key vault. Flow: admin issues an invite link/QR → the
new member's client generates keys → NIP-29 join flow adds them to the
company's groups → kind-0 profile metadata published to the company relay.
App-level roles — **admin / approver / member / observer** — live in the signed
policy event (kind 33401), not in a database.

### Channels

Channels are **NIP-29 groups** on the company relay. Two flavors:

- **Plain channels** (`#general`) — chat only.
- **Vault channels** (`#treasury`) — a channel bound to exactly one vault; the
  channel is the vault's entire control surface. Channel roster ⊇ signer set
  (observers can read but not sign).

**All channel content is encrypted** with NIP-44 to a per-channel symmetric
key, distributed to members via gift-wrap on join and **rotated whenever a
member is removed**. Relay-side membership gating is defense in depth.
The steward is a key-holding member of **vault channels only** (it must read
proposals and post cards there); it holds no plain-channel keys and no DMs —
this is reflected in the compromise matrix (§1).
Interop consequence, stated honestly: generic NIP-29 clients (0xchat etc.) can
see that groups exist and participate in the membership protocol, but cannot
read content. Interop is at the protocol layer, not the content layer.

**DMs** are NIP-17 gift-wrapped (NIP-44 inside); the operator cannot read them.

### Event vocabulary

Custom kinds render as interactive cards; unknown-kind fallback is a labeled
placeholder. All application events below are NIP-44-encrypted to the channel
key except where noted.

| Kind | Event | Author | Rendered as |
|---|---|---|---|
| 9 | chat message (NIP-29) | member | normal message |
| 33400 | vault descriptor (addressable, `d`=vault-id) | steward | vault header card: sp1 address, rail, network, threshold, roster |
| 33401 | vault policy (addressable) | admin quorum | policy card: limits, approver set, velocity rules |
| 4400 | payment proposal (`/pay`) | proposer | proposal card with Approve button |
| 4401 | approval **+ FROST round-1 commitment** | approver | "✓ 2 of 3 approved" progress |
| 4402 | partial signature (round 2) | approver | signing progress |
| 4403 | ceremony status (timeout, replacement, broadcasting) | steward | status line on the card |
| 4404 | payment receipt (after N confirmations) | steward | receipt card: txid, amount, confirmations |
| 4405 | receive request (`/receive`) | member | invoice card with the vault's sp1 address |
| 4410 | DKG round envelope (**pairwise NIP-44** — round-2 shares are secret) | members | "vault ceremony in progress" |

Two deliberate couplings:

1. **Approval = round-1 commitment** (kind 4401). Approving *is* committing to
   sign — the prototype's collapsed two-round flow, kept because it makes
   quorum semantics honest: an "approval" that doesn't bind a nonce is just an
   opinion.
2. **Partial signatures are public in-channel.** Standard FROST assumes a
   broadcast channel; a partial reveals nothing without its nonce. In exchange
   the company gets a permanently auditable, member-signed signing transcript.

Slash commands (`/pay`, `/receive`, `/vault create`, `/vault reshare`,
`/policy`) are client-side parsers that emit these events.

---

## 3. Vault lifecycle & the payments layer

### Vault creation — a ceremony in a channel

`/vault create 2-of-3 @alice @bob @carol` posts a ceremony card. Each named
member's browser runs FROST DKG in WASM; round-2 secret shares travel pairwise
NIP-44-encrypted (kind 4410); the steward only sequences rounds and enforces
timeouts. The ceremony ends with the steward publishing the vault descriptor
(kind 33400): group public key, BIP-352 address (`sp1…`/`tsp1…`), rail,
network, threshold, roster. The **scan key**, derived during the ceremony, is
delegated to the steward. The spend key never exists whole anywhere.

### Spending

```
/pay 0.05 to sp1qq… "invoice #341"
  → steward policy check (limits, approver set, velocity)
  → approvers click Approve (kind 4401 = approval + nonce commitment)
  → quorum exactly met → steward builds tx via the vault's rail,
    distributes sighashes
  → approvers' browsers emit partial signatures (kind 4402)
  → steward aggregates (public math), broadcasts, posts kind 4403 status
  → after N confirmations, steward posts the receipt card (kind 4404)
```

The chosen signer set **is** the quorum (all chosen must sign). If a signer
goes silent, the ceremony times out (kind 4403) and the proposal re-opens for a
replacement approver — vaults cannot get stuck.

### Silent payments — default in both directions

- **Send:** `/pay` and the send form accept `sp1…` first-class; the client
  derives the one-time output with the vector-validated BIP-352 code. Plain
  addresses are the fallback and are visually marked "non-private".
- **Receive:** each vault has **one eternal `sp1` address** — safe on invoices
  and email signatures because every payment lands at an unlinkable on-chain
  address. The steward's scanner block-walks Esplora with the delegated scan
  key and posts receipt cards as money arrives.

### Rail abstraction

```ts
interface Rail {
  descriptor(): RailInfo                          // network, layer, explorer URLs
  balance(vault): Promise<Balance>
  buildSpend(vault, outputs): Promise<UnsignedTx> // returns sighashes for FROST
  submit(signedTx): Promise<Txid>
  watchIncoming(scanKey, cb): Subscription        // BIP-352 scanner (L1) / arkd stream
  confirmationsOf(txid): Promise<number>
}
```

- **`L1Rail(chainParams)`** — Esplora-backed. Regtest, signet, testnet4, and
  mainnet are the same class with different parameters and address prefixes.
  Mainnet additionally requires an explicit `allowMainnet` deployment flag and
  a stricter default policy.
- **`ArkadeRail`** — `@arkade-os/sdk` against `arkd`; VTXO balance/spend
  semantics. How BIP-352 derivation applies to Ark's off-chain outputs is a
  documented seam in this rail (the steward still scans Arkade round outputs);
  the M3 implementation plan resolves its exact mechanics against the current
  arkd/SDK behavior.
- A vault binds to exactly **one rail + network at creation**, shown on its
  descriptor card. Cross-rail movement = an ordinary proposal paying vault B's
  sp1 address from vault A. No bridging logic.

### Reshare / recovery

Member leaves or loses a device → admin runs `/vault reshare` → a DKG-reshare
ceremony re-derives shares for the new roster under the **same** vault key.
Funds do not move; the departed share becomes useless; the channel key rotates
in the same step.

---

## 4. Failure modes & operational answers

| Failure | Designed answer |
|---|---|
| Steward down | Chat unaffected (clients ↔ relay directly); proposals queue as events; on restart the steward replays the relay and resumes the scanner from its cursor |
| Malicious steward | Can censor/stall only. Clients recompute quorum state from member-signed events (4401/4402) — steward cards are UX sugar over verifiable data. It cannot forge approvals or spend |
| Signer offline mid-ceremony | Timeout event (4403) → proposal re-opens for a replacement approver. Nonce commitments are single-use and bound to a ceremony id; the browser signer enforces one-commitment-per-ceremony (nonce reuse is the FROST foot-gun) |
| Device loss | No share backup in v1 by design. Recovery = `/vault reshare` with the new device. Consequence stated loudly: thresholds need headroom — 2-of-3 / 3-of-5, never N-of-N |
| Browser storage eviction | PWA requests persistent storage; warns when denied |
| Reorg | Receipts only after N confirmations (per-rail config; default 1 on regtest, 3 on signet/mainnet); scanner cursor rewinds on reorg and re-emits corrected receipts |
| Relay down | Clients reconnect with incremental resubscribe; deployment restart; relay volume is backed up |
| Backup story | One relay data volume + the steward cursor file restore the whole company |

---

## 5. Testing

1. **Crypto vectors** — official BIP-352 send/receive vectors (already passing
   in the prototype) + **FROST WASM/native parity**: the same dkgkit vectors
   must pass compiled natively and to WASM.
2. **Rail conformance suite** — one shared test suite every `Rail`
   implementation must pass; CI runs it against regtest L1 (bitcoind+electrs)
   and Arkade-regtest (Nigiri + arkd containers).
3. **E2E ceremonies** — Playwright, three browser contexts as three members:
   full DKG, `/pay`, approvals, broadcast, receipt against the compose stack.
4. **Chaos & adversarial** — kill the steward mid-round; drop a signer; replay
   old events; submit forged/mis-kinded events and policy-bypass attempts —
   all must fail safe.

---

## 6. Phasing

- **M0 — Repo bootstrap:** `bChannel` monorepo scaffold (workspaces, CI,
  lint/typecheck/test gates, LICENSE/README/CONTRIBUTING), spec copied into
  `docs/`, extracted `crypto` package passing the BIP-352 vectors, dkgkit
  WASM build proven with native/WASM parity tests.
- **M1 — Platform:** relay + NIP-29 encrypted channels/DMs, identity +
  onboarding, docker compose skeleton.
- **M2 — Vaults:** WASM dkgkit, DKG ceremony, L1 regtest rail, silent-payment
  send/receive by default, steward scanner, receipt cards.
- **M3 — Governance + Arkade:** policy engine, reshare ceremony, `ArkadeRail`,
  signet-by-config.

## Non-goals (v1)

- Mainnet custody **claim** (designed-for: `allowMainnet` flag, audit path,
  backup story — but not certified at v1).
- Mobile apps and hardware signers.
- MLS/Marmot forward-secret group messaging.
- Multi-company federation or hosted multi-tenancy.
- Compliance/fiat reporting.
- Share backups / social recovery (reshare is the only recovery path in v1).
