# BTech DKGKit Next App

A Next.js console plus a Rust wallet-service layer that integrates the local
`../dkgkit` crates. Use **Bun** for the web app and **Cargo** for the Rust DKGKit
service. The live vault runs on **regtest**.

It implements the local flow:

```text
create vault -> HTSS DKG complete -> Taproot address derived -> approval signed -> aggregate verifies
```

On top of that core, the app adds:

- **Nostr login** — sign in with a NIP-07 extension, a pasted `nsec`, or a
  one-tap demo persona. Your npub maps to a vault signer.
- **SQLite persistence** — sessions, chats, messages, approvals, and signatures
  survive restarts. The Rust crypto stays stateless and deterministic.
- **Per-chat audit log** — every propose / sign / message is recorded and is
  **visible only to vault members** (outsiders get 403).

## Prerequisites

- The `dkgkit` crates checked out as a sibling: `../dkgkit/crates/{dkgkit-sdk,dkgkit-nostr}`.
- [Bun](https://bun.sh) and a Rust toolchain (`cargo`, rust-version 1.76+).

## Setup & run

```bash
# 1. Build the Rust service (the API routes prefer the prebuilt binary)
cargo build

# 2. Install web deps and start the dev server
bun install
bun run dev
```

Then open <http://localhost:3000>. You'll be redirected to `/login`.

> **Dev tip:** if the auth guard ever stops redirecting after many hot reloads
> (a known Turbopack dev quirk), restart clean with `rm -rf .next && bun run dev`.
> The production build always enforces it.

## Login

You are identified by your Nostr public key (`npub`). Three ways in:

1. **Demo persona** — one-tap "log in as Alice / Bob / …". Each is a seeded
   signer, so role-based views and multi-signer approvals work immediately.
2. **NIP-07 extension** — Alby / nos2x (`window.nostr.getPublicKey()`).
3. **Paste `nsec`** — the secret is decoded **in the browser**; only the derived
   npub is sent to the server.

A logged-in npub that is not a vault signer becomes a read-only **observer**.

Example — log in as the first demo persona over the API:

```bash
NPUB=$(curl -s localhost:3000/api/auth/personas | jq -r '.personas[0].npub')
curl -i -X POST localhost:3000/api/auth/login \
  -H 'content-type: application/json' -d "{\"npub\":\"$NPUB\"}"
# -> 200 { "label": "Alice", "role": "Founder", "signer": true } + Set-Cookie: btech_session=...
```

## Storage

Local SQLite via `better-sqlite3`, seeded from the demo chats/approvals on first
run.

- File: `data/btech.db` (gitignored). Override with `BTECH_DB=/path/to.db`.
- **Reset the demo state:** `rm -f data/btech.db*` and restart.

## API routes

Auth + app data (all require the session cookie except `/api/auth/*`):

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/personas` | GET | list seeded signer identities |
| `/api/auth/login` `/logout` `/me` | POST/POST/GET | session lifecycle |
| `/api/chats` | GET | chats with messages |
| `/api/messages` | POST | post a message `{ chatId, text }` |
| `/api/approvals` | GET / POST | list / create approvals |
| `/api/approvals/[id]/sign` | POST | sign; live vault runs a real HTSS round |
| `/api/chats/[id]/audit` | GET | audit trail — **members only (403 otherwise)** |

Example — sign the live approval (runs a real grouped HTSS round in Rust) and
read the member-only audit log (`$C` is the cookie from login above):

```bash
curl -s -b "$C" -X POST localhost:3000/api/approvals/tx1/sign | jq '.approval.proof.verified'   # -> true
curl -s -b "$C" localhost:3000/api/chats/treasury/audit | jq '.entries[0]'
# -> { "actor_label": "Alice", "action": "sign", "detail": "live HTSS aggregate signature", ... }
```

### Core DKGKit proof routes

`POST /api/demo` invokes `cargo run --quiet -- --json` and returns the vault ID,
regtest receive address, signer set, authorization digest, aggregate signature,
and `verified: true` when the grouped signer set passes policy and the aggregate
BIP340 signature verifies.

`POST /api/session-proof` invokes `cargo run --quiet -- --session-proof-json
--session-id <id>` and returns invited participants, the vault policy per group,
a base `2-of-3` TSS/FROST proof, a grouped HTSS signing proof, confirmation that
an invalid HTSS signer set was rejected, and proof that high-rank signers cannot
replace a missing lower-rank quorum. Base TSS is a separate proof, not merged
into HTSS policy.

## Verify

```bash
cargo fmt --all --check
cargo test
bun run test        # vitest unit tests (db, identity, auth, audit)
bun run typecheck
bun run build
```

## Scope

This is a local demo shell. It intentionally does **not** include production
relay networking, NIP-44 encryption, PSBT construction, transaction broadcast,
recovery, reshare, real `nsec` signature verification, or mainnet custody claims.
