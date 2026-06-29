# Truthful Vault Service — wiring DKGKit for real (design)

- **Date:** 2026-06-29
- **Status:** Approved (design); implementation plan pending
- **Target tier:** "Truthful demo" + real Nostr relay transport
- **Local-only doc:** working artifact; not intended to be committed/pushed unless asked.

## 1. Goal

Make the BTech demo *honest and load-bearing* without faking: signatures bound to
the real approval transaction, DKG + signing genuinely coordinated over a real
Nostr relay (NIP-44 encrypted), the vault persisted (DKG once), and login that
proves key ownership. Per-device custody and on-chain broadcast are explicitly
the next tiers, not this one.

## 2. Why this is needed (gaps closed)

| Gap | Today | After |
|---|---|---|
| #2 signature ⊥ shown tx | signs a fixed `approval-001` (100k sats to own addr) | signs the approval's real recipient + amount |
| #6 in-memory transport | `LocalNostrEventTransport` (shared RAM bus) | `LiveNostrTransport` over a self-hosted relay |
| #4 stateless re-run | full DKG from seed `[42u8;32]` every request | DKG once; vault persisted; signing reuses it |
| #7 login is a claim | trust any posted npub | NIP-07 / nsec challenge-response |

Not in scope (next tiers): #1 per-device share custody, #5 on-chain PSBT/broadcast,
#9 reshare/recovery.

## 3. Architecture

```
Next.js (UI + auth + SQLite)  ──HTTP/JSON──▶  btech-vaultd (Rust, axum, long-running)
                                                  │   N participant agents, each:
                                                  │     FrostCoordinator<LiveNostrTransport>
                                                  ▼
                                       self-hosted Nostr relay (ws://127.0.0.1:7777)
```

- **`btech-vaultd`** — a new standalone Rust binary (axum HTTP service) that owns
  the vault, runs DKG once over the relay, persists the result, and serves
  state/sign requests. Replaces the per-request `cargo run`.
- **Relay** — DKGKit's `examples/self-hosted-relay` (docker, `ws://127.0.0.1:7777`).
- **Next** — `app/api/_lib/btech.ts` swaps from spawning `cargo` to `fetch`ing
  `btech-vaultd` (base URL from `BTECH_VAULTD_URL`, default `http://127.0.0.1:8787`).

Leverages DKGKit as-is: `LiveNostrTransport` + `LiveNostrTransportConfig` +
`ParticipantDirectory` (feature `live`), `FrostCoordinator<T>` (generic over
transport), `BitcoinAuthorizationMessage` (`recipient`/`amount_sats`/`nonce`/
`.digest()`), and the `vault-service` example flow.

## 4. Components

### 4.1 Transaction binding (gap #2) — *do first, smallest, biggest credibility win*

Today `WalletApp::run_demo` signs a hardcoded `ApprovalRequest`. Replace the
signed message with a `BitcoinAuthorizationMessage` built from the **caller's**
approval:

```rust
let authorization = BitcoinAuthorizationMessage {
    network,                 // "regtest"
    action: "approve-payment".into(),
    recipient: Some(req.recipient),   // approval.dest (full address)
    amount_sats: Some(req.amount_sats),
    memo: Some(req.memo),             // approval.title
    nonce: req.approval_id,           // approval.id  -> unique per approval
};
```

`vaultd`'s `POST /vault/sign` takes `{ approvalId, recipient, amountSats, memo }`
and signs `authorization.digest()`. The Next sign route passes the approval's
real fields. Result: the displayed "2.4 BTC → bcrt1q…f4k2 ✓ VERIFIED" is now the
literal message that verified under BIP340. `digest_hex` in the response equals
`authorization.digest()`.

> **Interim shortcut (optional):** the same change can land on the *current* CLI
> by adding `--recipient/--amount/--nonce` flags before `vaultd` exists, so #2
> ships independently of the service work.

### 4.2 Persistent vault service `btech-vaultd` (gap #4)

New crate/binary using `axum`. Holds vault state in memory and persists it to
disk so a restart resumes the same vault (and the same relay topic).

Endpoints (JSON):

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/vault/init` | `{ vaultTag, network, policy? }` | runs DKG once over the relay; persists; returns group key + receive address |
| GET | `/vault/state` | — | group key, receive address, policy, participants, joined status |
| POST | `/vault/sign` | `{ approvalId, recipient, amountSats, memo, signerSet? }` | runs an HTSS signing round over the relay; returns `{ digest, signature, signerSet, verified }` |
| GET | `/healthz` | — | readiness (relay connected, DKG finalized) |

Persistence: a versioned snapshot file `vaultd-state.json` next to the binary
(path via `BTECH_VAULTD_STATE`). Stores the grouped config, group key, each
participant's `HtssLocalKeyShare`, chain code, and vault tag. On boot: load if
present, else wait for `/vault/init`. (Shares on disk in the service is the
known scope line — per-device custody is the next tier.)

### 4.3 Live relay transport (gap #6) — *largest piece; new orchestration*

`LiveNostrTransport` is **one Nostr identity** (`self_id`; only receives DMs to
itself). The current single-bus, all-participants-in-one-loop DKG does **not**
port to one live transport, because round-2 packages are per-recipient DMs.

Therefore `vaultd` runs **one agent per participant**, each with its own
`LiveNostrTransport`:

- Each participant `i` gets a **real keypair** whose secret is
  `sha256("btech-signer-v1:" + i)` (a valid 32-byte secret key) and whose npub is
  the derived public key. A shared `ParticipantDirectory` maps participant → that
  pubkey so DM encryption targets resolve.
  - **Required fix for consistency:** the Next-side `deterministicNpub(id)`
    currently `npubEncode`s the hash *as if it were the pubkey*. Change it to
    derive the pubkey from the secret (`getPublicKey(sha256(...))`) so the
    persona/login npub equals the relay agent's identity. `vaultd` can also expose
    the participant pubkeys via `/vault/state` and Next can consume those instead —
    pick one source of truth (recommended: derive identically on both sides).
- All agents connect to the relay on the vault tag `dkgkit:<vaultTag>`.
- **DKG orchestration:** each agent publishes its round-1; every agent drains
  round-1 from the relay; each agent creates round-2 DMs (NIP-44 encrypted by
  `LiveNostrTransport` for `HtssDkgRound2`) addressed to each recipient; each
  agent drains the round-2 DMs addressed to it; each finalizes its share. The
  service asserts all agents derive the same group key.
- **Signing orchestration:** mirror of `sign_authorization` but driven across
  the per-participant agents for the chosen signer set (nonces published/drained,
  signature shares published/drained, aggregate verified).

This is real protocol traffic over a real relay with encrypted secret shares —
the honest "coordinated over Nostr" claim. It is the heaviest component and is
sequenced last so earlier steps stay demoable.

> **Fallback if orchestration runs long:** ship #2 + persistence on a single
> in-process bus, and additionally publish protocol events to the relay as an
> observable transparency feed (relay not yet load-bearing). Clearly label it as
> such. Prefer the real multi-agent path if time allows.

### 4.4 Next integration

- `app/api/_lib/btech.ts` → an HTTP client (`fetch`) to `BTECH_VAULTD_URL`,
  same return shapes (`DemoReport`, `SessionProofReport`) so routes are unchanged.
- `/api/approvals/[id]/sign` passes the approval's `dest`, `btc`→sats, `title`,
  `id` to `/vault/sign` so the real tx is signed and the stored
  `approval_signatures.aggregate_signature` is the bound signature.
- `/api/wallet/state` → `GET /vault/state`.
- Graceful degrade: if `vaultd` is unreachable, routes return a clear
  "vault service offline" 503 (the existing banner already surfaces errors).

### 4.5 NIP-07 / nsec login proof (gap #7)

- `GET /api/auth/challenge` → `{ nonce }` (random, short-TTL, stored server-side).
- Client signs the nonce: NIP-07 `window.nostr.signEvent` (or, for the nsec
  path, sign in-browser with `nostr-tools`).
- `POST /api/auth/login` now takes `{ npub, nonce, sig }`; the server verifies
  the Schnorr signature over the nonce against the npub before creating a
  session. Demo personas keep a one-tap path (their seeded secret signs the
  challenge client-side) so the demo stays fast.
- Removes the "anyone can post Alice's public npub" impersonation.

## 5. Data flow (sign, end to end)

1. UI "Approve & sign" → `POST /api/approvals/[id]/sign`.
2. Route loads the approval, calls `vaultd POST /vault/sign` with its real
   recipient/amount/id.
3. `vaultd` runs the HTSS round across participant agents over the relay,
   aggregates, verifies under BIP340.
4. Route stores `aggregate_signature` + records the `sign` audit event, returns
   the bound `proof` to the UI.

## 6. Error handling

- `vaultd` unreachable → 503 from Next routes; UI banner.
- Relay unreachable on `/vault/init` → 503 with "relay offline"; nothing persisted.
- Invalid signer set → 422 (DKGKit `validate_grouped_threshold_signer_set`).
- Challenge expired/!verify → 401 on login.

## 7. Testing

- Rust: integration test that `init` → `state` → `sign` against a local relay
  (gated like DKGKit's `--features live -- --ignored`, using `DKGKIT_TEST_RELAY`).
- Rust unit: tx-binding builds the expected digest from an approval.
- Next: vitest for the challenge/verify login helper; route smoke via curl.
- Browser: re-run the existing 11-case suite + verify `digest_hex` matches the
  approval and a wrong signature is rejected.

## 8. Sequencing (each step independently demoable)

1. **Tx-binding (#2)** — flag-on-CLI first, then `/vault/sign`. *(small, high ROI)*
2. **`btech-vaultd` skeleton + persistence (#4)** — axum, state snapshot, Next HTTP client. *(medium)*
3. **NIP-07 login proof (#7)** — independent, can run in parallel. *(small-medium)*
4. **Live relay multi-agent transport (#6)** — the heavy piece; fallback noted. *(large)*

## 9. Non-goals

Per-device share custody (#1), on-chain PSBT/UTXO/broadcast (#5), reshare/recovery
(#9), mainnet, NIP-44 for non-secret messages, production relay auth/rate limits.
