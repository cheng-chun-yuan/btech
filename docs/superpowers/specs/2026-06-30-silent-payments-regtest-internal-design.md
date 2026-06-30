# Silent Payments (BIP-352) — Regtest, Internal Transfers

**Date:** 2026-06-30
**Status:** Approved design → implementation
**Scope:** regtest only; private **receive + spend**; **internal** vault-to-vault send via silent-payment addresses. External SP send is explicitly out of scope.

---

## 1. Motivation

Today a vault exposes a single static BIP86 taproot receive address (`bcrt1p…`, derived at `m/86'/0'/0'/0/0` from the DKG group key). Every payment to the company lands at the same address, so all receipts are trivially linkable on-chain.

We want the company to:

1. **Receive privately** — publish *one* static silent-payment address (`tsp1…`); each payment lands at a unique derived taproot address that only the company can detect, so receipts are unlinkable.
2. **Spend** those privately-received funds through the existing approval → quorum → settle flow.
3. **Transfer internally** — pay another company vault's `tsp1…` address so internal movements are also unlinkable.

## 2. Why this is feasible without new threshold crypto

BIP-352 separates a **scan key** (`b_scan`, detection only) from a **spend key** (`B_spend`, controls funds).

- **Receiving / scanning** uses the *scan key*: `ecdh = b_scan · A_sum`. The scan key is an ordinary single secp256k1 key held hot in `vaultd` — plain ECDH, **no threshold operation**.
- **Spending** a received output `P_k = B_spend + t_k·G` (where `B_spend` = the DKG group key) reuses the existing threshold key-path signing path via DKGKit's silent-payment tweak (see §6). **No new threshold crypto.**
- **Internal send** would normally need the *sender's* ECDH `a · B_scan` where `a` is the threshold input key — a threshold-ECDH we cannot do. But for an **internal** transfer the company holds the recipient's scan key, so we instead compute the mathematically-identical **receiver-side** secret `b_scan · A_sum` from the **public** input keys of the sender vault's UTXOs. The sender's threshold key is then used only for ordinary key-path signing. **No threshold ECDH.**

**Hard boundary:** paying an *external* counterparty's SP address (whose scan key we do not hold) would require threshold ECDH or reconstructing the group secret — both rejected. Sending stays **internal-only**. Receiving is open to any BIP-352-compliant sender.

## 3. What DKGKit provides vs. what btech must build

DKGKit (`../dkgkit/crates/dkgkit-bitcoin/src/lib.rs`) provides **only** the spend-side tweak + the threshold signer:

- `silent_payment_output_tweak(group_key, k)` and `silent_payment_leaf_tweak(group_key, k)` — produce a `TaprootKeyTweak` for `P = B_spend + k·G`. `k` is the **final per-output tweak scalar** (32 BE bytes), i.e. BIP-352's `t_k` already including the ECDH step. `output_tweak` applies a BIP341 tap-tweak on top of `P`; `leaf_tweak` signs under `P` directly (no tap-tweak). **Which one matches an on-chain BIP-352 output is decided by test vectors — see §6.**
- `sign_digest_with_local_grouped_htss_threshold_shares_for_output(...)` — threshold Schnorr signature under the tweaked key (already used by today's settle path).

btech must build **everything else**: SP address encode/decode, scan-key management, the ECDH + `t_k` derivation, eligible-input pubkey extraction, the scanner, the SP-UTXO store, and the internal-send output construction.

## 4. Architecture

```
Browser ── Next API ──┬─ /api/vaults/[id]/sp/*        (address, utxos, scan trigger)
                      └─ /api/approvals/* (settle)    (spend SP UTXOs / internal SP send)
                              │
                          vaultd (Rust, 127.0.0.1:8787)
                              ├─ scan key (per vault, in data/vaultd/<id>.json)
                              ├─ scanner loop  ── Esplora block-walk ──► detect SP UTXOs
                              ├─ sp_utxos store (data/vaultd/<id>.json)
                              └─ settle/build ── DKGKit threshold sign ──► Esplora broadcast
                              │
                  src/domain/silent_payments.rs  (pure BIP-352 math + bech32m codec)
```

### 4.1 New module: `src/domain/silent_payments.rs`

Pure functions over rust-bitcoin 0.32 `secp256k1` + the `bech32` crate. No I/O, no key storage. Declared in `src/domain/mod.rs`.

Responsibilities and (indicative) API:

- `encode_address(b_scan_pub: &PublicKey, b_spend_pub: &PublicKey, network: Network) -> String`
- `decode_address(s: &str) -> Result<SilentPaymentAddress { b_scan, b_spend, hrp }>`
- `eligible_input_pubkey(prevout_spk: &Script, witness: &Witness, script_sig: &Script) -> Option<PublicKey>` — BIP-352 input eligibility (P2TR key-path → x-only lifted even-Y; P2WPKH; P2SH-P2WPKH; P2PKH). For the internal path only P2TR is exercised, but the full set is implemented for open receiving.
- `sum_input_pubkeys(pubkeys: &[PublicKey]) -> Option<PublicKey>` (None if it sums to infinity)
- `input_hash(smallest_outpoint: OutPoint, a_sum: &PublicKey) -> Scalar` — tagged hash `BIP0352/Inputs`
- `shared_secret(scalar: &Scalar, point: &PublicKey) -> PublicKey` — ECDH `scalar · point`
- `output_tweak(ecdh: &PublicKey, k: u32) -> [u8; 32]` — `t_k = tagged_hash("BIP0352/SharedSecret", ecdh_compressed ‖ ser32(k))`, reduced mod n
- `output_pubkey(b_spend: &PublicKey, t_k: &[u8;32]) -> XOnlyPublicKey` — `x(B_spend + t_k·G)` (convention per §6)

HRP: `tsp` for regtest/testnet/signet, `sp` for mainnet (mainnet not built). Address is bech32m, data = `[version(0)] ‖ convertbits(compressed B_scan ‖ compressed B_spend, 8→5, pad)`; the encoder must **not** enforce the 90-char bech32 length cap (SP addresses are ~117 chars).

### 4.2 vaultd changes (`src/bin/vaultd.rs` + supporting domain code)

**Scan-key identity.** On first provision of a vault, generate `scan_secret` (32 random bytes, validated non-zero and < n) and persist it in `data/vaultd/<id>.json` alongside the existing share material. `B_scan = scan_secret·G`; `B_spend` = the vault group key (x-only → lift even-Y → full point). SP address = `encode_address(B_scan, B_spend, regtest)`.

**Persisted state additions** (in the per-vault JSON):
- `scan_secret: [u8;32]`
- `sp_scan_height: u64` (watermark; starts at the block height at provision time so we don't rescan ancient history)
- `sp_utxos: Vec<SpUtxo>` where `SpUtxo { txid, vout, value_sat, derived_address, tweak: [u8;32], k: u32, block_height: u64, spent: bool }`

**Scanner loop.** A background task (tokio) per vault, also runnable on-demand via an endpoint. From `sp_scan_height+1` to the Esplora tip:
1. For each block, list txids → fetch each tx (Esplora `/tx/:txid` gives `vin[].prevout.scriptpubkey`, `vin[].witness`, `vin[].scriptsig`, `vout[].scriptpubkey`, `vout[].value`).
2. Collect eligible input pubkeys → `A_sum` (skip tx if none / infinity). Compute `input_hash` from the lexicographically smallest outpoint and `A_sum`.
3. `ecdh = shared_secret(scan_secret · input_hash, A_sum)`.
4. For `k = 0, 1, …`: `t_k = output_tweak(ecdh, k)`; `P_k = output_pubkey(B_spend, t_k)`. If any taproot `vout` equals `x(P_k)` → record an `SpUtxo` (derived address = the `bcrt1p…` for `x(P_k)`); increment `k` and continue (BIP-352 multi-output rule); else stop at this `k`.
5. Detect spends: if any tx input spends a known `SpUtxo` outpoint, mark it `spent`.
6. Advance `sp_scan_height`.

**Endpoints:**
- `GET /vault/sp/address` → `{ sp_address, b_scan_pub, b_spend_pub }`
- `GET /vault/sp/utxos` → `{ utxos: [{txid, vout, value_sat, derived_address, block_height, spent}], balance_sat }` (tweak/k never leave vaultd)
- `POST /vault/sp/scan` → trigger an immediate scan to tip (used by the API poll)
- The existing `/vault/settle` is extended (see §5) to accept SP UTXOs as inputs and an SP recipient.

### 4.3 Next API + TypeScript (`app/api/_lib/btech.ts`, `app/api/_lib/settle.ts`, new `app/api/vaults/[id]/sp/*`)

- `app/api/_lib/btech.ts`: add `runSpAddress`, `runSpUtxos`, `runSpScan` vaultd clients.
- New routes `app/api/vaults/[id]/sp/address` and `.../sp/utxos` proxy vaultd; a light poll (existing chain-activity poll cadence) calls `runSpScan` then `runSpUtxos`.
- Approval validation (`app/api/approvals/route.ts`): a destination starting with `tsp1` is treated as a **silent-payment send**; it must `decode_address` and match a **known internal company vault's SP identity** (we must hold its scan key). Non-internal `tsp1` destinations are rejected with a clear error. `bcrt1…` destinations behave exactly as today.

### 4.4 UI (`app/ui/wallet/wallet.tsx`)

- **Receive:** show the static `tsp1…` SP address (primary "private receive") alongside the existing `bcrt1p…`. Render detected SP receipts as activity rows with their unique derived `bcrt1p…` address, amount, and confirmations; surface an "SP balance" total.
- **Send:** the destination input accepts a `tsp1…` address (placeholder updated). When the proposer picks an internal vault, offer its `tsp1…` directly. Label SP sends as "private / internal". The amount/quorum/signer-pick flow is unchanged — SP sends are still governed approvals.

## 5. Spend & internal-send data flow

**Spending received SP funds (settle).** Today `settleVault()` pulls the static address's confirmed UTXOs and signs each input under the BIP86 child key. We extend input selection to also include unspent `sp_utxos`. Each input carries its **own** output key and therefore its **own** `TaprootKeyTweak`:
- static-address UTXO → BIP86 child tweak (`taproot_child_key_tweak`, as today)
- SP UTXO → SP tweak from its stored `t_k` (§6)

The multi-input signing loop must apply the correct per-input tweak (call the per-output threshold signer once per input with that input's tweak + sighash). Change returns to the vault's static address as today.

**Internal send to an SP address.** On settle/build for a `tsp1…` recipient:
1. Select the sender vault's input UTXOs (static + SP).
2. Compute `A_sum` and `input_hash` from those inputs' **public** keys + outpoints.
3. Look up the **recipient** vault's `scan_secret` (held by the same multi-vault `vaultd`). Compute `ecdh = shared_secret(scan_secret_recipient · input_hash, A_sum)` (receiver-side — uses the held scan key and public `A_sum`, never the sender's input private keys).
4. `t_0 = output_tweak(ecdh, 0)`; recipient output = `x(B_spend_recipient + t_0·G)` → pay `amount` to that taproot output; change to sender vault's static address.
5. Threshold-sign each sender input (per-input tweak) and broadcast.
6. The recipient vault's scanner detects the payment normally on its next scan.

The chicken-and-egg (output depends on the chosen inputs) is inherent to BIP-352 and already matches our flow: inputs are selected first, then the single recipient output is derived, then signing happens — signing does not change the output.

## 6. The one correctness decision: output-key convention

Standard BIP-352 and DKGKit's two tweak functions differ on whether the on-chain output key is `P_k` directly or `P_k` BIP341-tap-tweaked:

- **Raw `P_k`** → scan compares against `x(P_k)`; spend uses `silent_payment_leaf_tweak(group_key, t_k)`.
- **BIP341-tweaked `P_k`** → scan compares against `x(taproot(P_k))`; spend uses `silent_payment_output_tweak(group_key, t_k)`.

**Resolution (first implementation task):** vendor the official BIP-352 vectors (`bitcoin/bips` `bip-0352/send_and_receive_test_vectors.json`) and make `silent_payments.rs` reproduce them — address encode/decode, `A_sum`, `input_hash`, `t_k`, and the **output pubkey**. Whichever convention reproduces the vectors fixes `output_pubkey(...)` **and** selects the matching DKGKit tweak function used at spend time. Send, scan, and spend must all use that single convention. For internal transfers (we control both ends) any self-consistent choice works; matching the vectors additionally enables open receiving from external BIP-352 wallets.

## 7. Testing

1. **Crypto vectors (linchpin):** `silent_payments.rs` passes the official BIP-352 test vectors — encode/decode, `A_sum`, `input_hash`, `t_k`, output pubkey. This both validates the math and fixes §6.
2. **Address round-trip:** `decode(encode(B_scan,B_spend)) == (B_scan,B_spend)`; reject mainnet HRP, bad checksum, wrong length.
3. **Scanner (regtest, integration):** fund a vault's SP address from another vault, run the scanner, assert detection at the correct derived address and amount; assert a non-matching tx is ignored; assert spend-detection flips `spent`.
4. **Spend (regtest):** spend a detected SP UTXO via the threshold settle path; assert the witness verifies and Esplora accepts the broadcast; assert mixed static+SP inputs sign correctly with per-input tweaks.
5. **Internal transfer (end-to-end):** vault A sends to vault B's `tsp1…`; B's scanner detects it; B then spends it.
6. **API/UI:** SP address renders; approval validation rejects an external/unknown `tsp1…`; SP balance and derived-address activity display correctly.

## 8. Out of scope (v1)

- Mainnet (documented as future; needs `sp` HRP + a scalable indexer instead of the Esplora block-walk).
- Paying **external** SP addresses (needs threshold ECDH).
- BIP-352 **labels / change tags** (single scan/spend pair only).
- A dedicated SP indexer (blindbit-style). The Esplora block-walk is the regtest milestone; the indexer is the explicit mainnet upgrade path.
- Scan-key export / wallet import.

## 9. Risks

- **Convention mismatch (§6):** mitigated by making test vectors the first task.
- **Scanner cost:** O(all txs) — acceptable on regtest with controlled block production; not a mainnet path (see §8).
- **Per-input heterogeneous tweaks in settle:** the signing loop must apply each input's own tweak; covered by test 4.
- **Scan key is hot in vaultd:** consistent with the project's honest-scope caveat that share material currently lives in `vaultd`. The scan key cannot spend; worst case is loss of receive privacy, not funds.
