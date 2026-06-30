# Trustless threshold signing over a live Nostr relay (sub-project A)

Status: approved design · 2026-06-30

## Context

The decentralized vision: a Nostr-relay-powered system where no central server
holds keys; peers form group/p2p sessions, coordinate threshold signing
peer-to-peer, exchange value, and verify each other. The full vision decomposes
into four sub-projects:

- **A — Trustless signing core** (this spec): DKG → pre-committed nonce round →
  sign + aggregate over the relay, every peer verifying the others.
- B — Nostr group/p2p chat substrate.
- C — Bind chat ↔ signing + governance (RBAC, propose-picks-signers).
- D — Wallet UI driven by real Nostr identities; multi-user browser.

Today `relaydemo` proves the seed: N participants, each its own Nostr keypair,
run a real grouped HTSS **DKG** over a live relay (round-1 broadcast, round-2
NIP-44-encrypted P2P), each finalizing its own share and agreeing on the group
key. It does **DKG only** — no signing, no pre-committed round, no on-chain
exchange.

Key enabling fact: `FrostCoordinator<T: Transport>` is transport-generic and
already exposes the signing primitives over any transport, including the live
relay: `publish_htss_nonce` / `drain_htss_nonces` and
`publish_htss_signature_share` / `drain_htss_signature_shares`. So slice A is
mostly **orchestration** of existing primitives — minimal new plumbing.

## Goal

Extend the relay path from DKG-only to full threshold signing: N peers (each
holding only its own share) pre-commit nonces over the relay, then sign +
aggregate an agreed message, each peer independently verifying the others.

- **Stage 1:** sign a generic agreed 32-byte digest (protocol proof, testable).
- **Stage 2:** point the digest at a real Taproot key-path **sighash** built from
  a proposed transfer, then finalize + broadcast on regtest — a genuine
  trustless on-chain exchange, reusing the tweaked-signing + tx-build +
  broadcast already shipped.

## Topology (decision)

One binary `relaysign` spawns N independent relay clients — each a distinct
Nostr keypair + its own finalized HTSS share, communicating **only** via the
relay (a dumb message bus; no privileged coordinator authority). The relay is
the decentralization point; each peer is a self-contained unit, so splitting
into real separate OS processes / browsers is a mechanical later step. Mirrors
the proven `relaydemo` shape.

## Flow (per signing session)

1. **Bootstrap** — run the relaydemo DKG over the relay → each peer holds its
   own share + the shared group key. *(reuse relaydemo)*
2. **Pre-committed round (round 1)** — each peer generates one nonce
   (`htss_nonce`) and **publishes** its public nonce over the relay
   (`publish_htss_nonce`); peers drain the full set (`drain_htss_nonces`). This
   happens before the message is known. **Each nonce is single-use** — reuse
   across messages leaks the key, so it is consumed and discarded after one
   sign share.
3. **Agree on the message** — Stage 1: an agreed 32-byte digest. Stage 2: a real
   Taproot sighash from a proposed transfer (single input to start).
4. **Sign (round 2)** — each peer computes its share from its pre-committed nonce
   + the message (`htss_sign_share` for Stage 1; `htss_sign_share_for_output`
   for Stage 2's tweaked output key) and **publishes** it
   (`publish_htss_signature_share`); peers drain.
5. **Aggregate + verify (every peer)** — each peer independently aggregates
   (`aggregate_htss_signature_shares` / `_for_output`) and **verifies** the
   BIP340 signature under the group/output key. No privileged aggregator — all
   peers converge on the same verified signature, or it fails. *This realizes
   "verify each other."*
6. **Stage 2 exchange** — finalize the Taproot tx with the aggregate signature
   and broadcast to regtest → coins move, fully peer-to-peer.

## Peer verification ("verify each other")

- Relay-delivered nonces and sign shares are checked against the known
  `ParticipantDirectory` of participant pubkeys (as relaydemo does for DKG).
- Every peer runs the aggregate BIP340 verification itself, so no peer trusts
  another's claim — all converge on the same verified signature or the session
  fails.
- DKG round-2 shares stay NIP-44 P2P-encrypted; nonces and sign shares are
  public over the relay (they leak nothing on their own).

## Components & boundaries

- **`relaysign` binary** — the orchestration/proof harness driving the N peers
  through bootstrap → pre-commit → sign → aggregate/verify (→ broadcast in
  Stage 2). One clear purpose: prove trustless signing over the relay.
- **Reuses, no new transport plumbing:**
  - `dkgkit-sdk`: `FrostCoordinator` (transport-generic publish/drain),
    HTSS sign/aggregate fns incl. the tweaked `_for_output` variants.
  - `dkgkit-nostr`: `LiveNostrTransport`, `LiveNostrTransportConfig`,
    `ParticipantDirectory`.
  - `dkgkit-bitcoin` (Stage 2): `taproot_child_key_tweak`,
    `taproot_keyspend_sighashes`, `finalize_taproot_keyspend`.
  - esplora broadcast (Stage 2): reuse the existing regtest broadcast path.

## Pre-committed nonce safety (critical)

One nonce per signature; never reused across messages; consumed and discarded
after producing a sign share. A second signing session pre-commits fresh
nonces. The implementation must make reuse structurally impossible (e.g., take
ownership of the nonce when signing).

## Testing

- **Stage 1:** N peers DKG → pre-commit → sign an agreed digest → every peer
  aggregates + verifies the same BIP340 signature under the group key; assert
  all peers agree and verification passes. Run against the local relay.
- **Stage 2:** digest = a real single-input Taproot sighash → tweaked aggregate
  verifies under the output key (rust-bitcoin secp, already proven in unit
  tests) → finalize + broadcast to regtest; assert the node accepts the tx and
  coins move.

## Dependencies

- A running relay: the self-hosted docker relay from the dkgkit examples
  (`ws://127.0.0.1:7777`), same as `relaydemo`. Confirm it is up as step one.
- Stage 2 also needs a funded vault address on regtest (as in the settlement
  work) to have a UTXO to spend.

## Out of scope for A (later sub-projects)

Chat (B), RBAC / propose-picks-signers (C), wallet UI / browser multi-user (D),
real separate OS processes / browsers per participant.
