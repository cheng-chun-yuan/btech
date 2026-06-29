# BTech — Institutional Bitcoin Treasury, built on DKGKit

BTech is a treasury console for **companies and institutions that want to hold
and use bitcoin themselves** — without handing custody to an exchange, and
without any single person (or device) able to move funds alone.

It is built on top of [**DKGKit**](../dkgkit), which provides the cryptography:
a **Hierarchical Threshold Signature Scheme (HTSS)** where the spending key is
generated and held collectively, and a spend requires a quorum across
organizational tiers — not one signer, not one server.

## Why

Companies increasingly hold bitcoin on their balance sheet, but the options are
poor: trust a custodian, or run a brittle multisig spreadsheet of hardware
wallets. BTech treats the company's signing structure as a first-class object:

- **No single point of failure.** The key is never assembled in one place. DKG
  (distributed key generation) means no party ever sees the full secret.
- **Org-shaped control.** Approvals map to how a company actually decides —
  C-level, managers, operators — each tier contributing its own quorum.
- **Auditable by the people accountable.** Every proposal and signature is
  recorded per vault and visible to its members, not to outsiders.
- **Self-custody.** Your quorum, your coins. BTech holds no keys.

## Built on DKGKit (HTSS)

DKGKit gives BTech the full threshold-signing lifecycle:

- **DKG** — distributed key generation; shares are created collectively, the
  full key is never materialized.
- **Grouped / hierarchical threshold signing** — a policy like
  `(1,2,3)-of-(2,3,5)` across C-level / Managers / Operators tiers. A spend
  needs a quorum from **each** tier; a high-rank signer cannot substitute for a
  missing lower-rank group.
- **Reshare** — rotate the signer set and refresh shares (onboard/offboard a
  signer, recover from a lost device) **without changing the vault address or
  exposing the key**.
- **Taproot + BIP340** — Schnorr aggregate signatures verified on-chain-style;
  funds receive to a single Taproot address.
- **Nostr coordination** — signers are Nostr identities; rounds are coordinated
  as Nostr events.

## What the console does

- **Nostr login** — sign in with a NIP-07 extension, a pasted `nsec`, or a
  one-tap demo persona. Your npub maps to a vault signer (non-signers join as
  read-only observers).
- **Grouped HTSS vault** — a live treasury vault with a real
  `(1,2,3)-of-(2,3,5)` policy across three tiers.
- **Real, verified signing** — "Approve & sign" runs an actual grouped HTSS
  round in Rust and shows the BIP340-verified aggregate signature, signer set,
  group key, and digest.
- **Per-chat audit log** — every propose / sign / message is recorded and is
  **visible only to vault members**; outsiders are denied.
- **Persistent state** — sessions, chats, messages, approvals, and signatures
  persist across restarts (local SQLite).
- **Live regtest chain** — vault addresses, balances, and UTXOs come from a real
  regtest Esplora API; the header shows the live chain tip.
- **Real Nostr relay** — `relaydemo` runs a genuine multi-agent HTSS DKG over a
  self-hosted relay with NIP-44-encrypted round-2 shares.
- **Login by key proof** — sign in via NIP-07 or nsec by signing a one-time
  challenge (knowing a public npub is not enough).

## Quickstart

Requires the [`dkgkit`](../dkgkit) crates as a sibling checkout, plus
[Bun](https://bun.sh) and a Rust toolchain.

```bash
cargo build                 # build the CLI + vaultd + relaydemo binaries
bun install

# Optional but recommended: run the vault service (DKG once, stable address,
# fast signing). The app uses it when BTECH_VAULTD_URL is set.
./target/debug/vaultd       # http://127.0.0.1:8787

cp .env.example .env.local  # BTECH_ESPLORA_URL + BTECH_VAULTD_URL
bun run dev                 # http://localhost:3000  (log in with a demo persona)
```

Config (see `.env.example`):

- `BTECH_ESPLORA_URL` — regtest Esplora API for chain status / balances / UTXOs
  (default `https://btc.utxopia.com/regtest`).
- `BTECH_VAULTD_URL` — vault service URL; unset = CLI fallback (fresh, non-stable
  address per call).
- `BTECH_DB` — SQLite path (default `data/btech.db`; delete to reset the demo).

Run a real DKG over a live relay:

```bash
docker compose -f ../dkgkit/examples/self-hosted-relay/docker-compose.yml up -d
DKGKIT_RELAY=ws://127.0.0.1:7777 cargo run --bin relaydemo
```

The console exposes auth + key-proof (`/api/auth/*`), chat/approval persistence
(`/api/chats`, `/api/messages`, `/api/approvals`, `/api/approvals/[id]/sign`),
the member-only audit log (`/api/chats/[id]/audit`), vault provisioning
(`/api/vaults/[id]/provision`), and chain status (`/api/chain/tip`,
`/api/chain/address/[addr]`). See `app/api/` for shapes.

## Scope & roadmap

This is a demo shell focused on the threshold-control story: DKG → Taproot
address → grouped HTSS approval → BIP340 verification, with key-proof login,
persistence, audit, live regtest chain status, and a real relay-backed DKG demo.

Honest scope line: for the main vault flow the shares live inside the service
(`vaultd`); `relaydemo` shows the per-participant/per-device relay path that
closes that gap. **Reshare/recovery (#9)**, **PSBT construction + broadcast
(#5, real on-chain spends)**, and **mainnet** are the next tiers. Not financial
or custody advice.
