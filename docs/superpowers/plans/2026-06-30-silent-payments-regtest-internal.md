# Silent Payments (regtest, internal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a vault publish a static silent-payment address (`tsp1…`), detect & spend privately-received funds, and make internal vault-to-vault transfers via SP — on regtest.

**Architecture:** A pure BIP-352 math+codec module in btech (`src/domain/silent_payments.rs`, new `bitcoin` 0.32 dep). `vaultd` holds a per-vault hot scan key, runs an Esplora block-walk scanner, stores detected SP UTXOs, and spends them by reusing DKGKit's threshold key-path signer with a per-output silent-payment tweak. Internal sends derive the recipient output from the company-held recipient scan key (receiver-side ECDH over public input keys).

**Tech Stack:** Rust (rust-bitcoin 0.32, dkgkit-sdk/-bitcoin/-frost), axum vaultd, Next.js 16 API routes, React 19 UI, Esplora HTTP.

## Global Constraints

- Network: **regtest only**. HRP for SP addresses: **`tsp`**. No mainnet/testnet switch.
- DKGKit is reached only via `dkgkit_sdk::bitcoin::*` and `dkgkit_sdk::*`; only `[u8;32]` tweak bytes + existing SDK types cross the boundary.
- **Send is internal-only**: a `tsp1…` destination must decode to a known company vault SP identity (we hold its scan key) or be rejected. Receiving is open to any BIP-352 sender.
- Output-key convention (raw `P_k` vs BIP341-tweaked) is **fixed by the official BIP-352 test vectors in Task 1** and used identically in scan, send, and spend.
- The vault scan key is hot in `vaultd`, stored in `data/vaultd/<id>.json` (consistent with existing share storage). It cannot spend.
- Commit after every passing step. Run `cargo test -p btech` (Rust) and `bun run test` (TS) as the test commands. Rust lib crate name is `btech` (see `src/lib.rs`).
- Use `bun`, not npm.

---

### Task 1: BIP-352 crypto module — address codec + math, locked to official test vectors

**Files:**
- Modify: `Cargo.toml` (add `bitcoin = "0.32"`; add `bech32 = "0.11"` only if `bitcoin::bech32` is not re-exported)
- Create: `src/domain/silent_payments.rs`
- Modify: `src/domain/mod.rs` (add `pub mod silent_payments;`)
- Create: `tests/vectors/bip352_send_and_receive.json` (vendored official vectors)
- Test: inline `#[cfg(test)]` in `src/domain/silent_payments.rs`

**Interfaces — Produces:**
```rust
pub struct SilentPaymentAddress { pub b_scan: PublicKey, pub b_spend: PublicKey }
pub fn encode_address(b_scan: &PublicKey, b_spend: &PublicKey) -> String;          // tsp1…, bech32m, no 90-char cap
pub fn decode_address(s: &str) -> anyhow::Result<SilentPaymentAddress>;            // rejects non-tsp HRP / bad checksum / wrong len
pub fn eligible_input_pubkey(spk: &Script, witness: &Witness, script_sig: &Script) -> Option<PublicKey>;
pub fn sum_pubkeys(keys: &[PublicKey]) -> Option<PublicKey>;                       // None on infinity / empty
pub fn input_hash(smallest_outpoint: &OutPoint, a_sum: &PublicKey) -> Scalar;      // tagged hash BIP0352/Inputs
pub fn shared_secret(scalar: &Scalar, point: &PublicKey) -> PublicKey;             // ECDH scalar·point
pub fn output_tweak(ecdh: &PublicKey, k: u32) -> [u8; 32];                         // t_k, BIP0352/SharedSecret, reduced mod n
pub fn output_xonly(b_spend: &PublicKey, t_k: &[u8; 32]) -> XOnlyPublicKey;        // convention fixed by vectors
```

**Steps:**

- [ ] **Step 1: Vendor the test vectors.** `mkdir -p tests/vectors && curl -s -o tests/vectors/bip352_send_and_receive.json https://raw.githubusercontent.com/bitcoin/bips/master/bip-0352/send_and_receive_test_vectors.json`. Verify it is valid JSON and non-empty: `node -e "console.log(require('./tests/vectors/bip352_send_and_receive.json').length+' cases')"`.

- [ ] **Step 2: Add the dep + module.** Add `bitcoin = "0.32"` to `Cargo.toml`, `pub mod silent_payments;` to `src/domain/mod.rs`, and a skeleton `silent_payments.rs` with the signatures above (`unimplemented!()` bodies). Run `cargo build -p btech` — expect it to compile (confirms `bitcoin` resolves; confirm whether `bitcoin::bech32`, `bitcoin::secp256k1`, `bitcoin::hashes` are available — if `bech32` is not re-exported, add `bech32 = "0.11"`).

- [ ] **Step 3: Failing test — address round-trip + a vector.** Write a test that loads one "receiving" case from the JSON, builds `b_scan`/`b_spend` from the vector's keys, asserts `encode_address(...)` equals the vector's expected address, and `decode_address(expected) == (b_scan,b_spend)`. Run: `cargo test -p btech silent_payments::tests::address -- --nocapture`. Expected: FAIL (`unimplemented!`).

- [ ] **Step 4: Implement the address codec.** bech32m over data = `[0u8]` ++ `convert_bits(b_scan.serialize() ++ b_spend.serialize(), 8, 5, true)`; HRP `tsp`; disable the 90-char length check. `decode_address` reverses it, validates HRP `tsp`, version 0, 66-byte payload. Run the Step 3 test → PASS.

- [ ] **Step 5: Failing test — the full receiving pipeline against vectors.** For each "receiving" vector case: parse the given inputs (prevout SPKs, outpoints, pubkeys) → `eligible_input_pubkey`/`sum_pubkeys` → `a_sum`; `input_hash`; `shared_secret(scan_priv·input_hash, a_sum)`; loop `k` computing `output_xonly(b_spend, output_tweak(ecdh,k))`; assert the produced set of output x-only keys equals the vector's `expected.outputs`. Run: `cargo test -p btech silent_payments::tests::receiving`. Expected: FAIL.

- [ ] **Step 6: Implement the math.** Implement `eligible_input_pubkey` (P2TR key-path → x-only even-Y; P2WPKH; P2SH-P2WPKH; P2PKH), `sum_pubkeys`, `input_hash` (tagged hash `BIP0352/Inputs` of `smallest_outpoint ++ a_sum.serialize()` → `Scalar`), `shared_secret` (`point.mul_tweak` / scalar mult), `output_tweak` (tagged hash `BIP0352/SharedSecret` of `ecdh.serialize() ++ k.to_be_bytes()` → reduce mod n → `[u8;32]`), and `output_xonly`. **Determine the convention:** implement `output_xonly` as raw `x(b_spend + t_k·G)` first; if Step 5 fails on the output check, switch to the BIP341-tweaked form. Record which one passes in a doc comment (it selects the DKGKit spend fn in Task 4). Run Step 5 → PASS.

- [ ] **Step 7: Failing test — sending pipeline against vectors.** For each "sending" vector: compute `a = Σ input_privkeys`, `ecdh = input_hash·a·B_scan`, derive outputs, assert equals `expected.outputs`. Run: `cargo test -p btech silent_payments::tests::sending`. Expected: FAIL then implement any missing sender helper (the math is symmetric; likely only a thin `sender_outputs(...)` wrapper) → PASS.

- [ ] **Step 8: Run the whole module + commit.** `cargo test -p btech silent_payments` → all PASS. `git add Cargo.toml src/domain/silent_payments.rs src/domain/mod.rs tests/vectors && git commit -m "feat(sp): BIP-352 math+address codec, verified against official vectors"`.

---

### Task 2: vaultd scan-key identity + SP address endpoint

**Files:**
- Modify: `src/bin/vaultd.rs` (per-vault state struct; persistence; provision hook; routes)
- Modify: `app/api/_lib/btech.ts` (add `runSpAddress`)
- Create: `app/api/vaults/[id]/sp/address/route.ts`
- Test: inline Rust test for key derivation; `app/api/vaults/[id]/sp/address/route.test.ts` (vitest)

**Interfaces — Consumes:** Task 1 `encode_address`. **Produces:** `GET /vault/sp/address -> { sp_address, b_scan_pub, b_spend_pub }`; TS `runSpAddress(id) -> { spAddress, bScanPub, bSpendPub }`.

**Steps:**

- [ ] **Step 1: Persisted state.** Add to the per-vault JSON struct in `vaultd.rs`: `scan_secret: [u8;32]`, `sp_scan_height: u64`, `sp_utxos: Vec<SpUtxo>` (define `SpUtxo { txid:String, vout:u32, value_sat:u64, derived_address:String, tweak:[u8;32], k:u32, block_height:u64, spent:bool }`). Default empty/zero for existing files (serde `#[serde(default)]`). Build: `cargo build -p btech`.

- [ ] **Step 2: Failing test — scan key + address derivation.** Rust test: given a fixed `scan_secret` and a known group key, `B_scan = scan_secret·G`, `B_spend` = group key even-Y, `encode_address` yields a `tsp1…` string that `decode_address` round-trips. Run → FAIL.

- [ ] **Step 3: Generate + persist scan key at provision.** In the provision/load path, if `scan_secret` is unset, generate 32 random bytes (validate non-zero, `< n`), persist. Compute `B_scan`; obtain `B_spend` from the vault group key (x-only → even-Y full point via `bitcoin` or the SDK). Run Step 2 test → PASS.

- [ ] **Step 4: Endpoint + TS client + route.** Add `GET /vault/sp/address` returning `{ sp_address, b_scan_pub(hex), b_spend_pub(hex) }`. Add `runSpAddress` to `btech.ts` and the Next route proxying it. Vitest: the route returns the vaultd payload shape. Run: `bun run test app/api/vaults` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(sp): per-vault scan key + SP address endpoint"`.

---

### Task 3: Esplora block-walk scanner + SP UTXO store

**Files:**
- Modify: `src/bin/vaultd.rs` (scanner fn, `/vault/sp/scan`, `/vault/sp/utxos`)
- Modify: `app/api/_lib/esplora.ts` (block-walk helpers if missing: tip height, block txids, tx detail), `app/api/_lib/btech.ts` (`runSpScan`, `runSpUtxos`)
- Create: `app/api/vaults/[id]/sp/utxos/route.ts`
- Test: Rust integration test against a local/CI regtest Esplora (gated by env var); inline unit test for the match loop with synthetic tx data.

**Interfaces — Consumes:** Task 1 math; Task 2 scan key/state. **Produces:** `POST /vault/sp/scan -> { scanned_to, found }`; `GET /vault/sp/utxos -> { utxos:[{txid,vout,value_sat,derived_address,block_height,spent}], balance_sat }`; TS `runSpScan(id)`, `runSpUtxos(id)`.

**Steps:**

- [ ] **Step 1: Failing unit test — the match loop.** Construct a synthetic "tx" (eligible input pubkeys + outpoints + a list of taproot output xonly keys) where exactly one output is `output_xonly(b_spend, output_tweak(ecdh,0))` for a chosen scan key. Assert `scan_tx(scan_secret, b_spend, inputs, outputs)` returns one `SpUtxo` with `k=0` and the right derived address; assert a tx with no match returns empty; assert two matching outputs return `k=0,1`. Run → FAIL.

- [ ] **Step 2: Implement `scan_tx`.** Pure fn: gather eligible input pubkeys → `a_sum` (return empty if none); `input_hash`; `ecdh = shared_secret(scan_secret·input_hash, a_sum)`; loop `k` while a taproot output matches `output_xonly(...)`, recording `SpUtxo`s (derived address = regtest P2TR for the xonly). Run Step 1 → PASS.

- [ ] **Step 3: Implement the block-walk + spend detection.** `scan_to_tip(vault)`: from `sp_scan_height+1` to Esplora tip, for each block fetch txids then tx detail, build inputs (prevout SPK + witness + scriptsig + outpoint) and outputs, call `scan_tx`, append new `SpUtxo`s (dedupe by `txid:vout`), and mark any stored UTXO `spent` if a later tx input references its outpoint; update `sp_scan_height`. Add Esplora helpers as needed. Add `POST /vault/sp/scan` and `GET /vault/sp/utxos` (balance = Σ unspent).

- [ ] **Step 4: Integration test (regtest, env-gated).** Behind `#[ignore]`/`BTECH_REGTEST=1`: fund the vault SP address, run `scan_to_tip`, assert detection at the right derived address/amount. Document how to run in the test's doc comment.

- [ ] **Step 5: TS clients + route + poll.** Add `runSpScan`/`runSpUtxos` to `btech.ts`, the `sp/utxos` route, and wire a scan trigger into the existing chain-activity poll cadence (call `runSpScan` then `runSpUtxos`). Vitest for the route shape. `bun run test` → PASS.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(sp): Esplora block-walk scanner + SP UTXO store/endpoints"`.

---

### Task 4: Spend received SP UTXOs through settle (per-input tweaks)

**Files:**
- Modify: `src/app.rs` / `src/domain/vault.rs` (settle: per-input tweak signing), `src/bin/vaultd.rs` (`/vault/settle` accepts SP inputs)
- Modify: `app/api/_lib/settle.ts` (include SP UTXOs in selection)
- Test: Rust test signing a synthetic SP UTXO; regtest end-to-end (env-gated).

**Interfaces — Consumes:** Task 1 `output_tweak`/convention; Task 3 `SpUtxo`. DKGKit: `dkgkit_sdk::bitcoin::silent_payment_leaf_tweak` **or** `silent_payment_output_tweak` per the convention recorded in Task 1 Step 6. **Produces:** settle path that signs heterogeneous inputs (BIP86-child + SP) each with its own `TaprootKeyTweak`.

**Steps:**

- [ ] **Step 1: Failing test — spend one SP UTXO.** Build a regtest P2TR output at `output_xonly(group_key, t_k)`, then a spending tx; produce the threshold signature via the SP tweak (`silent_payment_*_tweak(group_key, t_k)`) and the existing `sign_digest_…_for_output` path; assert the witness verifies as a BIP341 key-path spend. Run → FAIL.

- [ ] **Step 2: Implement SP-input signing.** Generalize the settle sighash/sign loop so each input supplies its own `TaprootKeyTweak`: static-address inputs use the BIP86 child tweak (as today); SP inputs use the SP tweak from their stored `t_k`. Use the DKGKit function matching Task 1's recorded convention. Run Step 1 → PASS.

- [ ] **Step 3: Selection.** Extend `settle.ts` + `/vault/settle` so unspent `sp_utxos` join the static-address UTXOs as spendable inputs; change still returns to the static address.

- [ ] **Step 4: Regtest end-to-end (env-gated).** Receive to the SP address (Task 3), then settle spending the detected SP UTXO; assert Esplora accepts the broadcast and the UTXO flips `spent`.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(sp): spend received SP UTXOs via per-input threshold tweaks"`.

---

### Task 5: Internal send to a `tsp1…` address

**Files:**
- Modify: `src/bin/vaultd.rs` (build path: recipient output from held scan key), `src/domain/vault.rs`
- Modify: `app/api/approvals/route.ts` (validate `tsp1…` = known internal vault), `app/api/_lib/settle.ts`
- Test: Rust test deriving recipient output via receiver-side ECDH; regtest A→B end-to-end.

**Interfaces — Consumes:** Task 1 math; Task 2 scan-key store (recipient lookup); Task 4 signing. **Produces:** internal SP send build that derives `x(B_spend_recipient + t_0·G)` from the recipient `scan_secret` + the sender's public `a_sum`/`input_hash`.

**Steps:**

- [ ] **Step 1: Failing test — receiver-side output derivation matches scanner.** Given sender input pubkeys/outpoints and a recipient scan key, derive the output via `shared_secret(scan_secret_recipient·input_hash, a_sum)` → `output_xonly(...)`; assert it equals what the recipient's `scan_tx` (Task 3) would detect for the same tx. Run → FAIL.

- [ ] **Step 2: Implement the internal build.** In the settle build for a `tsp1…` recipient: select sender inputs → `a_sum`,`input_hash`; look up the recipient vault's `scan_secret` in the multi-vault store; derive the recipient output; pay `amount` there, change to sender static address; sign inputs (Task 4). Run Step 1 → PASS.

- [ ] **Step 3: Approval validation.** In `approvals/route.ts`, a destination matching `^tsp1` must `decode_address` and match a known internal vault's SP identity (we hold its scan key) else reject with a clear error. `bcrt1…` unchanged.

- [ ] **Step 4: Regtest end-to-end (env-gated).** Vault A proposes a send to vault B's `tsp1…`; quorum signs; broadcast; B's scanner detects it; B spends it (Task 4).

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(sp): internal vault-to-vault silent-payment send"`.

---

### Task 6: UI — show SP address, render private receipts, accept `tsp1…` in send

**Files:**
- Modify: `app/ui/wallet/wallet.tsx` (receive: SP address chip + SP activity/balance; send: accept `tsp1…`, offer internal vault picker)
- Test: vitest/component test where the existing wallet tests live.

**Interfaces — Consumes:** Task 2 `runSpAddress` route; Task 3 `sp/utxos` route. **Produces:** UI surfaces.

**Steps:**

- [ ] **Step 1: Receive surface.** Add a `tsp1…` AddressChip (labelled "Private receive") beside the existing `bcrt1p…`; fetch `sp/utxos` and render an "SP balance" total + activity rows showing each derived `bcrt1p…` address, amount, confirmations. Follow the existing `AddressChip`/activity patterns (`wallet.tsx:1790-1808`, `:1855`).

- [ ] **Step 2: Send surface.** Update the destination placeholder to mention `tsp1…`; when an internal vault is chosen, prefill its `tsp1…`. Keep amount/quorum/signer-pick unchanged. Show a "private / internal" label when the destination is `tsp1…`.

- [ ] **Step 3: Test + manual check.** Add/extend a wallet test asserting the SP address renders and a `tsp1…` destination is accepted by `submitSend`. Manually verify at `http://localhost:3030` (use `localhost`, not `127.0.0.1`).

- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(sp): wallet UI for private receive + internal SP send"`.

---

### Task 7: Docs + final verification

**Files:** Modify `README.md` (note SP regtest receive/internal-send; reiterate external-send/mainnet are out of scope and the indexer is the mainnet path).

**Steps:**

- [ ] **Step 1:** Update README scope/roadmap lines.
- [ ] **Step 2:** Full suite: `cargo test -p btech` and `bun run test` → all PASS; `cargo build -p btech` clean.
- [ ] **Step 3:** Commit `docs(sp): document regtest silent payments scope`.

---

## Self-Review

- **Spec coverage:** §4.1 codec→T1; §4.2 scan key/scanner/endpoints→T2,T3; §5 spend→T4; §5 internal send→T5; §4.3 API/validation→T2–T5; §4.4 UI→T6; §6 convention→T1.S6 (drives T4); §7 tests→each task's tests; §8 out-of-scope→T7 docs. No gaps.
- **Placeholders:** none — each task names exact files, the convention decision is a concrete branch in T1.S6, and test intents are spelled out. (Exact rust-bitcoin 0.32 call names — e.g. `mul_tweak` vs `mul`, `bech32` re-export — are resolved against the compiler in T1.S2/S6; flagged inline, not left vague.)
- **Type consistency:** `SpUtxo`, `output_xonly`, `output_tweak`, `shared_secret`, `input_hash` names are used consistently across T1–T5; the DKGKit tweak fn is selected once in T1.S6 and referenced by name in T4/T5.
