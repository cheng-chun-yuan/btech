# Members-only channels + propose-picks-signers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate channel chats to members-or-signers, and replace the "any signer votes" approval flow with a propose-picks-signers flow where each chosen signer submits a pre-committed HTSS nonce on approve and round 2 (sign + aggregate) fires automatically once the whole chosen set has submitted.

**Architecture:** Channel visibility reuses the existing `isMember` helper as a one-line route filter (Part 1). The signing change (Part 2) splits the Rust `VaultService.sign_approval` atomic round into `htss_precommit` (round 1, stores the secret local nonce in a per-session map) and `htss_finalize` (round 2, consumes the stored nonces, aggregates, BIP340-verifies, drops the session). `btech-vaultd` exposes these as `/vault/sign/precommit` and `/vault/sign/finalize`. The Next API stores the chosen `signerSet` on the approval, gates signing to selected signers, calls precommit on each approve, and calls finalize when the set is complete. Secret nonce material never leaves vaultd; the web DB stores only the public nonce package.

**Tech Stack:** Rust (axum vaultd, dkgkit-sdk HTSS primitives), Next.js App Router API routes (Node runtime), better-sqlite3, React (wallet UI), vitest, cargo test.

## Global Constraints

- **Vault crypto is uniform:** every vault (treasury and every created channel) is a `(1,2,3)-of-(2,3,5)` grouped HTSS vault with 10 participants (ids 1–10), regardless of the cosmetic `tiers` shown in the UI. A valid signer set is exactly 1 of {1,2} + 2 of {3,4,5} + 3 of {6,7,8,9,10} = 6 signers. The canonical default valid set is `[1,3,4,6,7,8]`.
- **Signer roster lives under one vault id:** the `signers` table maps npub→participant_id under `vault_id = "treasury"` (`app/api/_lib/identity.ts:6`). Propose-picks-signers therefore targets the treasury vault's roster (`listSigners(db)`); vaults with no signer rows fall through to the existing flow.
- **`threshold = signerSet.length`** and **all chosen signers must sign** (chosen count *is* the quorum).
- **Single-use nonces:** a finalize consumes and drops its session's nonces; reuse must be structurally impossible.
- **Secret nonces stay in vaultd**; the web DB stores only the public nonce package (for audit/display).
- **vaultd-optional:** when `BTECH_VAULTD_URL` is unset, the collapsed two-round can't run; signing falls back to the existing one-shot `runSignApproval`, but the selected-signer governance gate still applies.
- Tests: TS uses `vitest run` with `openTestDb()` for `_lib` helpers and `installTestDb()` + a `next/headers` mock for route handlers. Rust uses `cargo test`.
- The existing `sign_payment(nonce, …)` argument is the *approval-binding id*, NOT the cryptographic nonce — keep the two distinct in code and comments.

---

## File Structure

- `app/api/_lib/dm.ts` — add `filterVisibleChats` (Part 1 visibility helper). Consumed by the chats route.
- `app/api/chats/route.ts` — use `filterVisibleChats` so channels are gated.
- `src/domain/vault.rs` — add per-session nonce storage + `htss_precommit` / `htss_finalize`.
- `src/app.rs` — add `WalletApp::htss_precommit` / `WalletApp::htss_finalize` wrappers (+ `NoncePackage` re-export type).
- `src/bin/vaultd.rs` — add `/vault/sign/precommit` and `/vault/sign/finalize` routes.
- `app/ui/wallet/types.ts` — add `SelectedSigner` + `Approval.signerSet`.
- `app/api/_lib/db.ts` — add `precommit` column to `approval_signatures`; bump schema version.
- `app/api/_lib/btech.ts` — add `runPrecommit` / `runFinalize` vaultd clients.
- `app/api/_lib/governance.ts` (new) — signer-set resolution, default set, selected-signer gate, signed-count helpers. Consumed by both approval routes.
- `app/api/_lib/governance.test.ts` (new) — unit tests for the above.
- `app/api/approvals/route.ts` — validate + persist `signerSet` on propose; derive `threshold`.
- `app/api/approvals/[id]/sign/route.ts` — selected-signer gate + collapsed two-round orchestration + fallback.
- `app/api/approvals/[id]/sign/route.test.ts` (new) — gate + finalize-on-completion route test.
- `app/ui/wallet/wallet.tsx` — signer picker in the send dialog; "needs you" filter by `signerSet`.
- `app/ui/wallet/approval-card.tsx` — show chosen signers and their `Selected → Pre-committed → Signed` state.

---

## Task 1: Channel visibility gate (Part 1)

**Files:**
- Modify: `app/api/_lib/dm.ts` (add `filterVisibleChats`)
- Modify: `app/api/chats/route.ts:57-60`
- Test: `app/api/_lib/dm.test.ts`

**Interfaces:**
- Consumes: `isChatMember(db, chatId, npub)` and `isMember(db, chatId, npub)` (existing).
- Produces: `filterVisibleChats<T extends { id: string; type: string }>(db: DB, viewerNpub: string | null, chats: T[]): T[]` — keeps a `direct` chat only if the viewer is a strict member; keeps any other chat (channel) only if `isMember` (member OR registered signer); drops everything when `viewerNpub` is null.

- [ ] **Step 1: Write the failing test**

Add to `app/api/_lib/dm.test.ts`:

```ts
import { filterVisibleChats } from "./dm";
import { addMember } from "./audit";

describe("filterVisibleChats", () => {
  it("hides channels from non-member non-signers, shows them to signers and explicit members", () => {
    const db = openTestDb();
    // Two signers (rows in `signers`) + one plain observer user.
    syncSigners(db, [
      { participant_id: 1, label: "Maya", role: "CEO" },
      { participant_id: 6, label: "Opie", role: "Operator" },
    ]);
    const [signer] = db.prepare("SELECT npub FROM signers ORDER BY participant_id").all() as { npub: string }[];
    db.prepare("INSERT INTO users (npub, label, role, created_at) VALUES (?,?,?,?)").run("npub-observer", "Obs", "Observer", 0);

    db.prepare("INSERT INTO chats (id, type, name, data_json) VALUES ('ch1','channel','#ops','{}')").run();
    const chats = [{ id: "ch1", type: "channel" }];

    // Signer sees it; unauthenticated sees nothing; observer does not (until added).
    expect(filterVisibleChats(db, signer.npub, chats).map((c) => c.id)).toEqual(["ch1"]);
    expect(filterVisibleChats(db, null, chats)).toEqual([]);
    expect(filterVisibleChats(db, "npub-observer", chats)).toEqual([]);

    addMember(db, "ch1", "npub-observer");
    expect(filterVisibleChats(db, "npub-observer", chats).map((c) => c.id)).toEqual(["ch1"]);
  });

  it("keeps the strict-membership rule for direct chats", () => {
    const db = openTestDb();
    db.prepare("INSERT INTO chats (id, type, name, data_json) VALUES ('dm1','direct','dm','{}')").run();
    db.prepare("INSERT INTO signers (vault_id, participant_id, npub, label, role) VALUES ('treasury',1,'npub-signer','S','CEO')").run();
    const chats = [{ id: "dm1", type: "direct" }];
    // A signer is NOT auto-member of a DM they're not in.
    expect(filterVisibleChats(db, "npub-signer", chats)).toEqual([]);
    addMember(db, "dm1", "npub-signer");
    expect(filterVisibleChats(db, "npub-signer", chats).map((c) => c.id)).toEqual(["dm1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- app/api/_lib/dm.test.ts`
Expected: FAIL — `filterVisibleChats is not a function`.

- [ ] **Step 3: Implement `filterVisibleChats`**

Add to `app/api/_lib/dm.ts` (import `isMember` at top: `import { addMember, isMember, recordAudit } from "./audit";` — extend the existing import):

```ts
/** Visibility gate for the chat list. A `direct` chat is shown only to its
 * strict members; any other chat (channel) is shown to members OR registered
 * signers (`isMember`). An unauthenticated viewer (null) sees nothing. */
export function filterVisibleChats<T extends { id: string; type: string }>(
  db: DB,
  viewerNpub: string | null,
  chats: T[],
): T[] {
  if (viewerNpub == null) return [];
  return chats.filter((c) =>
    c.type === "direct"
      ? isChatMember(db, c.id, viewerNpub)
      : isMember(db, c.id, viewerNpub),
  );
}
```

> `dm.ts` currently imports `{ addMember, recordAudit }` from `./audit` — add `isMember` to that import. `isChatMember` is already defined in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- app/api/_lib/dm.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the route**

In `app/api/chats/route.ts`, replace the current `visible` filter (lines ~57–60) so channels are gated too. Import `filterVisibleChats` from `../_lib/dm` (add to the existing dm import). Replace:

```ts
  const viewer = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  const visible = chats.filter(
    (c) => c.type !== "direct" || (viewer != null && isChatMember(db, c.id, viewer.npub)),
  );
```

with:

```ts
  const viewer = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  const visible = filterVisibleChats(db, viewer?.npub ?? null, chats);
```

The DM-relabel loop below it is unchanged.

- [ ] **Step 6: Run the full TS suite + typecheck**

Run: `bun run test && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add app/api/_lib/dm.ts app/api/_lib/dm.test.ts app/api/chats/route.ts
git commit -m "feat(gov): gate channels to members-or-signers in GET /api/chats"
```

---

## Task 2: Rust — split signing into precommit + finalize

**Files:**
- Modify: `src/domain/vault.rs` (session storage + two methods)
- Modify: `src/app.rs` (`WalletApp` wrappers + test)

**Interfaces:**
- Consumes: existing `htss_nonce`, `htss_sign_share`, `aggregate_htss_signature_shares`, `validate_grouped_threshold_signer_set`, `ParticipantId`, `HtssLocalNonce`, `HtssNoncePackage`, `SessionId` from `dkgkit_sdk`; `ApprovalRequest`.
- Produces:
  - `VaultService::htss_precommit(&mut self, signing_session_id: &str, participant_id: ParticipantId) -> anyhow::Result<HtssNoncePackage>`
  - `VaultService::htss_finalize(&mut self, signing_session_id: &str, approval: &ApprovalRequest, signer_set: Vec<ParticipantId>) -> anyhow::Result<SigningResult>`
  - `WalletApp::htss_precommit(&mut self, session: &str, participant_id: u16) -> anyhow::Result<HtssNoncePackage>`
  - `WalletApp::htss_finalize(&mut self, session: &str, nonce: &str, recipient: &str, amount_sats: u64, memo: &str, signer_set: Vec<u16>) -> anyhow::Result<DemoReport>`

- [ ] **Step 1: Add session storage + imports to `VaultService`**

In `src/domain/vault.rs`, extend the `dkgkit_sdk` import to include the nonce types and add a field. Update the import block to add `HtssLocalNonce, HtssNoncePackage`:

```rust
use dkgkit_sdk::{
    aggregate_htss_signature_shares, aggregate_htss_signature_shares_for_output,
    hierarchical_config_from_grouped_threshold, htss_nonce, htss_sign_share,
    htss_sign_share_for_output, validate_grouped_threshold_signer_set, DkgKitError,
    FrostCoordinator, GroupKey, GroupedThresholdConfig, HtssDkgRound1State, HtssDkgService,
    HtssLocalKeyShare, HtssLocalNonce, HtssNoncePackage, ParticipantId, Result, SessionId,
};
```

Add a field to the `VaultService` struct (after `group_key`):

```rust
    /// Per-signing-session secret local nonces collected during the
    /// pre-commit round (round 1), keyed by signing session id then participant.
    /// Consumed and dropped by `htss_finalize` so a nonce is never reused.
    sign_sessions: BTreeMap<String, BTreeMap<ParticipantId, HtssLocalNonce>>,
```

Initialize it in `VaultService::new` (add `sign_sessions: BTreeMap::new(),` to the struct literal).

- [ ] **Step 2: Implement `htss_precommit` and `htss_finalize`**

Add these methods to the `impl VaultService` block (e.g. just after `sign_approval`):

```rust
    /// Round 1 for one signer: generate that participant's single-use nonce,
    /// publish its public package over the coordinator, and stash the secret
    /// local nonce under `signing_session_id`. Idempotent per (session,
    /// participant) — re-calling returns the already-published package. Returns
    /// the public nonce package (safe to store/display).
    pub fn htss_precommit(
        &mut self,
        signing_session_id: &str,
        participant_id: ParticipantId,
    ) -> anyhow::Result<HtssNoncePackage> {
        if let Some(existing) = self
            .sign_sessions
            .get(signing_session_id)
            .and_then(|s| s.get(&participant_id))
        {
            return Ok(existing.package.clone());
        }
        let session = SessionId::new(signing_session_id)?;
        let share = self
            .local_shares
            .get(&participant_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing local share for signer {}", participant_id.0))?;
        let nonce = htss_nonce(session, &share)?;
        self.coordinator.publish_htss_nonce(&nonce.package)?;
        let package = nonce.package.clone();
        self.sign_sessions
            .entry(signing_session_id.to_string())
            .or_default()
            .insert(participant_id, nonce);
        Ok(package)
    }

    /// Round 2: every member of `signer_set` must already have pre-committed.
    /// Drain the public nonces, compute each signer's share from its stored
    /// local nonce, aggregate, BIP340-verify, then DROP the session so its
    /// nonces can never be reused.
    pub fn htss_finalize(
        &mut self,
        signing_session_id: &str,
        approval: &ApprovalRequest,
        signer_set: Vec<ParticipantId>,
    ) -> anyhow::Result<SigningResult> {
        validate_grouped_threshold_signer_set(&signer_set, &self.grouped_config)?;
        let group_key = self
            .group_key
            .clone()
            .ok_or_else(|| anyhow::anyhow!("vault DKG is not finalized"))?;
        let local_nonces = self
            .sign_sessions
            .get(signing_session_id)
            .ok_or_else(|| anyhow::anyhow!("no pre-commit session '{signing_session_id}'"))?;
        let session = SessionId::new(signing_session_id)?;
        let digest = approval.digest();

        // Pair each selected signer with its share + pre-committed local nonce.
        let mut selected = Vec::with_capacity(signer_set.len());
        for pid in &signer_set {
            let share = self
                .local_shares
                .get(pid)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("missing local share for signer {}", pid.0))?;
            let nonce = local_nonces
                .get(pid)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("signer {} has not pre-committed", pid.0))?;
            selected.push((share, nonce));
        }

        let public_nonces = self.coordinator.drain_htss_nonces(&session)?;
        for (share, nonce) in &selected {
            let signature_share = htss_sign_share(
                &group_key,
                digest,
                share,
                nonce,
                &public_nonces,
                &signer_set,
                &self.dkg.config,
            )?;
            self.coordinator.publish_htss_signature_share(&signature_share)?;
        }
        let signature_shares = self.coordinator.drain_htss_signature_shares(&session)?;
        let aggregate = aggregate_htss_signature_shares(
            &group_key,
            digest,
            &public_nonces,
            &signature_shares,
            &signer_set,
            &self.dkg.config,
        )?;
        let verified = verify_aggregate_signature_digest(&group_key, &digest, &aggregate)?;
        // Single-use: drop the session's nonces no matter the outcome.
        self.sign_sessions.remove(signing_session_id);
        anyhow::ensure!(verified, "aggregate signature failed Bitcoin verification");

        Ok(SigningResult {
            signature_hex: hex::encode(aggregate.signature_bytes),
            digest_hex: hex::encode(digest),
            signer_ids: signer_set.iter().map(|id| id.0).collect(),
            verified,
        })
    }
```

- [ ] **Step 3: Add `WalletApp` wrappers**

In `src/app.rs`, add a re-export for the package type near the top (so `vaultd.rs` can name it):

```rust
pub use dkgkit_sdk::HtssNoncePackage;
```

Add `use dkgkit_sdk::ParticipantId;` if not present (used to map ids). Then add to `impl WalletApp`:

```rust
    /// Round 1 wrapper: ensure the vault is initialized, then pre-commit the
    /// given participant's nonce for `session`. Returns the public package.
    pub fn htss_precommit(
        &mut self,
        session: &str,
        participant_id: u16,
    ) -> anyhow::Result<HtssNoncePackage> {
        self.init()?;
        self.vault.htss_precommit(session, ParticipantId::new(participant_id)?)
    }

    /// Round 2 wrapper: build the same payment authorization `sign_payment`
    /// binds (recipient + amount + nonce + memo), then finalize `session` with
    /// the chosen signer set. `nonce` here is the approval-binding id, not the
    /// cryptographic nonce.
    pub fn htss_finalize(
        &mut self,
        session: &str,
        nonce: &str,
        recipient: &str,
        amount_sats: u64,
        memo: &str,
        signer_set: Vec<u16>,
    ) -> anyhow::Result<DemoReport> {
        self.init()?;
        let approval = ApprovalRequest::payment(
            nonce.to_string(),
            self.vault.network.clone(),
            recipient.to_string(),
            amount_sats,
            memo.to_string(),
        );
        let ids = signer_set
            .into_iter()
            .map(ParticipantId::new)
            .collect::<Result<Vec<_>, _>>()?;
        let signing = self.vault.htss_finalize(session, &approval, ids)?;
        let address = self.vault.derive_receive_address(0, 0, 0)?;
        Ok(DemoReport {
            vault_id: self.vault.vault_id.clone(),
            network: self.vault.network.clone(),
            group_xonly_public_key: self.vault.group_xonly_public_key_hex()?,
            receive_path: address.path.display_path(),
            receive_address: address.address,
            signers: signing.signer_ids,
            authorization_digest: signing.digest_hex,
            aggregate_signature: signing.signature_hex,
            verified: signing.verified,
            remaining_relay_events: self.vault.remaining_relay_events(),
        })
    }
```

- [ ] **Step 4: Write the failing Rust test**

Add to the `#[cfg(test)] mod tests` in `src/app.rs`:

```rust
    #[test]
    fn collapsed_two_round_precommit_then_finalize_verifies() {
        let mut app = WalletApp::demo().unwrap();
        app.init().unwrap();
        let set: Vec<u16> = vec![1, 3, 4, 6, 7, 8];
        for pid in &set {
            app.htss_precommit("tx-collapsed-1", *pid).unwrap();
        }
        let report = app
            .htss_finalize("tx-collapsed-1", "tx-collapsed-1", "bcrt1qexample", 100_000, "memo", set.clone())
            .unwrap();
        assert!(report.verified);
        assert_eq!(report.signers, set);
        assert_eq!(report.aggregate_signature.len(), 128);
    }

    #[test]
    fn finalize_is_single_use_and_rejects_invalid_sets() {
        let mut app = WalletApp::demo().unwrap();
        app.init().unwrap();
        let set: Vec<u16> = vec![1, 3, 4, 6, 7, 8];
        for pid in &set {
            app.htss_precommit("tx-su", *pid).unwrap();
        }
        // Invalid set (missing a manager): rejected, session NOT yet consumed.
        assert!(app
            .htss_finalize("tx-su", "tx-su", "bcrt1qx", 1, "m", vec![1, 3, 6, 7, 8])
            .is_err());
        // Valid finalize succeeds and consumes the session.
        assert!(app
            .htss_finalize("tx-su", "tx-su", "bcrt1qx", 1, "m", set.clone())
            .unwrap()
            .verified);
        // Second finalize on the same session has no nonces → error (single-use).
        assert!(app
            .htss_finalize("tx-su", "tx-su", "bcrt1qx", 1, "m", set)
            .is_err());
    }
```

- [ ] **Step 5: Run the Rust tests to verify they fail then pass**

Run: `cargo test --lib collapsed_two_round_precommit_then_finalize_verifies finalize_is_single_use_and_rejects_invalid_sets`
Expected: after Steps 1–3, both PASS. (Before implementing, they fail to compile / fail at runtime.)

- [ ] **Step 6: Run the full Rust suite**

Run: `cargo test`
Expected: PASS (existing `demo_flow_runs_end_to_end`, `settle_taproot_spend_builds_a_verified_keypath_transaction`, etc. unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/domain/vault.rs src/app.rs
git commit -m "feat(htss): split signing into precommit + finalize (single-use nonce sessions)"
```

---

## Task 3: Rust — vaultd `/vault/sign/precommit` + `/vault/sign/finalize`

**Files:**
- Modify: `src/bin/vaultd.rs`

**Interfaces:**
- Consumes: `WalletApp::htss_precommit`, `WalletApp::htss_finalize`, `HtssNoncePackage` (re-exported from `btech`), existing `with_vault`, `err500`, `VaultQuery`.
- Produces HTTP:
  - `POST /vault/sign/precommit?id=<vault>` body `{ "session": string, "participant_id": u16 }` → `{ "participant_id": u16, "nonce_package": <json> }`
  - `POST /vault/sign/finalize?id=<vault>` body `{ "session": string, "signer_set": [u16], "recipient": string, "amountSats": u64, "nonce": string, "memo": string }` → `DemoReport`

- [ ] **Step 1: Add request structs + handlers**

In `src/bin/vaultd.rs`, extend the `btech` import to include `HtssNoncePackage`:

```rust
use btech::{DemoReport, HtssNoncePackage, SettlementReport, SettlementRequest, VaultKeyMaterial, WalletApp};
```

Add request structs near `SignReq`:

```rust
#[derive(Deserialize)]
struct PrecommitReq {
    session: String,
    participant_id: u16,
}

#[derive(Deserialize)]
struct FinalizeReq {
    session: String,
    signer_set: Vec<u16>,
    recipient: String,
    #[serde(rename = "amountSats")]
    amount_sats: u64,
    nonce: String,
    memo: String,
}
```

Add handlers near `vault_sign`:

```rust
async fn vault_sign_precommit(
    State(state): State<Arc<AppState>>,
    Query(q): Query<VaultQuery>,
    Json(req): Json<PrecommitReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let id = q.id.unwrap_or_else(|| "treasury".to_string());
    let package: HtssNoncePackage = with_vault(&state, &id, |app| {
        app.htss_precommit(&req.session, req.participant_id)
    })
    .map_err(err500)?;
    let nonce_package = serde_json::to_value(&package).map_err(|e| err500(e.into()))?;
    Ok(Json(serde_json::json!({
        "participant_id": req.participant_id,
        "nonce_package": nonce_package,
    })))
}

async fn vault_sign_finalize(
    State(state): State<Arc<AppState>>,
    Query(q): Query<VaultQuery>,
    Json(req): Json<FinalizeReq>,
) -> Result<Json<DemoReport>, (StatusCode, String)> {
    let id = q.id.unwrap_or_else(|| "treasury".to_string());
    let report = with_vault(&state, &id, |app| {
        app.htss_finalize(
            &req.session,
            &req.nonce,
            &req.recipient,
            req.amount_sats,
            &req.memo,
            req.signer_set.clone(),
        )
    })
    .map_err(err500)?;
    Ok(Json(report))
}
```

- [ ] **Step 2: Register the routes**

In `main()`, add to the router builder (after `.route("/vault/sign", post(vault_sign))`):

```rust
        .route("/vault/sign/precommit", post(vault_sign_precommit))
        .route("/vault/sign/finalize", post(vault_sign_finalize))
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build --bin btech-vaultd`
Expected: builds cleanly. (Binary name per `Cargo.toml`; if it differs, use the declared `[[bin]]` name for `vaultd.rs`.)

- [ ] **Step 4: Smoke test the endpoints (manual, optional)**

With a vaultd running (`cargo run --bin btech-vaultd`):

```bash
curl -s -X POST 'http://127.0.0.1:8787/vault/sign/precommit?id=treasury' -H 'content-type: application/json' -d '{"session":"tx-smoke","participant_id":1}'
# → {"participant_id":1,"nonce_package":{...}}
```

Repeat for participant_ids 3,4,6,7,8, then:

```bash
curl -s -X POST 'http://127.0.0.1:8787/vault/sign/finalize?id=treasury' -H 'content-type: application/json' \
  -d '{"session":"tx-smoke","signer_set":[1,3,4,6,7,8],"recipient":"bcrt1qexample","amountSats":100000,"nonce":"tx-smoke","memo":"smoke"}'
# → DemoReport with "verified": true
```

- [ ] **Step 5: Commit**

```bash
git add src/bin/vaultd.rs
git commit -m "feat(vaultd): /vault/sign/precommit + /vault/sign/finalize routes"
```

---

## Task 4: Web types + DB migration

**Files:**
- Modify: `app/ui/wallet/types.ts`
- Modify: `app/api/_lib/db.ts`
- Test: `app/api/_lib/db.test.ts`

**Interfaces:**
- Produces: `SelectedSigner = { participantId: number; npub: string; label: string }`; `Approval.signerSet?: SelectedSigner[]`; `approval_signatures.precommit TEXT` column.

- [ ] **Step 1: Add the types**

In `app/ui/wallet/types.ts`, add above `Approval`:

```ts
/** One signer the proposer picked for an approval. Its participantId aligns
 * with the Rust signer_set and the `signers` table; npub gates who may sign. */
export type SelectedSigner = { participantId: number; npub: string; label: string };
```

Add to the `Approval` type (after `total: number;`):

```ts
  /** The exact signers the proposer assembled. Length is the threshold; all
   * must sign. Absent on legacy/no-roster approvals (existing flow applies). */
  signerSet?: SelectedSigner[];
```

- [ ] **Step 2: Write the failing migration test**

Add to `app/api/_lib/db.test.ts`:

```ts
it("approval_signatures has a precommit column", () => {
  const db = openTestDb();
  const cols = (db.prepare("PRAGMA table_info(approval_signatures)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("precommit");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run test -- app/api/_lib/db.test.ts`
Expected: FAIL — `precommit` not in columns.

- [ ] **Step 4: Add the column + schema bump**

In `app/api/_lib/db.ts`: bump `SCHEMA_VERSION` by one (find the `const SCHEMA_VERSION = N;` line and increment). Add the column to the `CREATE TABLE approval_signatures` body so fresh DBs get it:

```sql
    CREATE TABLE IF NOT EXISTS approval_signatures (
      approval_id TEXT NOT NULL,
      npub TEXT NOT NULL,
      aggregate_signature TEXT,
      precommit TEXT,
      signed_at INTEGER NOT NULL,
      PRIMARY KEY (approval_id, npub)
    );
```

For existing DBs, add a guarded `ALTER TABLE` inside `migrate`'s upgrade branch (alongside the other versioned steps, before the `UPDATE schema_meta SET version` line):

```ts
    // vN: per-signer pre-commit nonce package for the collapsed two-round flow.
    const sigCols = (db.prepare("PRAGMA table_info(approval_signatures)").all() as { name: string }[]).map((c) => c.name);
    if (!sigCols.includes("precommit")) {
      db.prepare("ALTER TABLE approval_signatures ADD COLUMN precommit TEXT").run();
    }
```

> Replace `vN` with the new schema version number you set.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- app/api/_lib/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `bunx tsc --noEmit`

```bash
git add app/ui/wallet/types.ts app/api/_lib/db.ts app/api/_lib/db.test.ts
git commit -m "feat(gov): Approval.signerSet type + approval_signatures.precommit column"
```

---

## Task 5: Web — vaultd two-round clients

**Files:**
- Modify: `app/api/_lib/btech.ts`

**Interfaces:**
- Consumes: `VAULTD_URL`, `DemoReport` (existing).
- Produces:
  - `runPrecommit(p: { session: string; participantId: number }, vaultId?: string): Promise<{ participant_id: number; nonce_package: unknown }>`
  - `runFinalize(p: { session: string; signerSet: number[]; recipient: string; amountSats: number; nonce: string; memo: string }, vaultId?: string): Promise<DemoReport>`
  - `VAULTD_CONFIGURED: boolean`

- [ ] **Step 1: Add the clients**

In `app/api/_lib/btech.ts`, after `runSignApproval`, add:

```ts
/** True when btech-vaultd is configured (enables the collapsed two-round). */
export const VAULTD_CONFIGURED = !!VAULTD_URL;

export type PrecommitResult = { participant_id: number; nonce_package: unknown };

/** Round 1: pre-commit one signer's nonce for `session`. Returns the public
 * nonce package (store it for audit; the secret nonce stays in vaultd). */
export async function runPrecommit(
  p: { session: string; participantId: number },
  vaultId = "treasury",
): Promise<PrecommitResult> {
  if (!VAULTD_URL) throw new Error("BTECH_VAULTD_URL is required for pre-commit");
  const res = await fetch(`${VAULTD_URL}/vault/sign/precommit?id=${encodeURIComponent(vaultId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: p.session, participant_id: p.participantId }),
  });
  if (!res.ok) {
    throw new Error(`vaultd precommit failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as PrecommitResult;
}

/** Round 2: finalize `session` once every chosen signer has pre-committed. */
export async function runFinalize(
  p: { session: string; signerSet: number[]; recipient: string; amountSats: number; nonce: string; memo: string },
  vaultId = "treasury",
): Promise<DemoReport> {
  if (!VAULTD_URL) throw new Error("BTECH_VAULTD_URL is required for finalize");
  const res = await fetch(`${VAULTD_URL}/vault/sign/finalize?id=${encodeURIComponent(vaultId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: p.session,
      signer_set: p.signerSet,
      recipient: p.recipient,
      amountSats: Math.max(0, Math.round(p.amountSats)),
      nonce: p.nonce,
      memo: p.memo,
    }),
  });
  if (!res.ok) {
    throw new Error(`vaultd finalize failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as DemoReport;
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/_lib/btech.ts
git commit -m "feat(gov): vaultd runPrecommit/runFinalize clients + VAULTD_CONFIGURED"
```

---

## Task 6: Web — governance helpers

**Files:**
- Create: `app/api/_lib/governance.ts`
- Test: `app/api/_lib/governance.test.ts`

**Interfaces:**
- Consumes: `DB`, `listSigners` (`./identity`), `SelectedSigner` (`../../ui/wallet/types`).
- Produces:
  - `DEFAULT_VALID_PARTICIPANT_IDS: number[]` (= `[1,3,4,6,7,8]`)
  - `resolveSignerSet(db: DB, npubs: string[]): SelectedSigner[]` — every npub must be a registered signer; throws `Error` otherwise.
  - `defaultSignerSet(db: DB): SelectedSigner[]` — the canonical valid set resolved from the roster (empty if roster absent).
  - `isSelectedSigner(signerSet: SelectedSigner[] | undefined, npub: string): boolean`
  - `signedNpubs(db: DB, approvalId: string): Set<string>`
  - `allSelectedSigned(signerSet: SelectedSigner[], signed: Set<string>): boolean`

- [ ] **Step 1: Write the failing tests**

Create `app/api/_lib/governance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import { syncSigners } from "./identity";
import {
  DEFAULT_VALID_PARTICIPANT_IDS,
  resolveSignerSet,
  defaultSignerSet,
  isSelectedSigner,
  signedNpubs,
  allSelectedSigned,
} from "./governance";

function seedRoster(db: ReturnType<typeof openTestDb>) {
  syncSigners(
    db,
    Array.from({ length: 10 }, (_, i) => ({ participant_id: i + 1, label: `S${i + 1}`, role: "r" })),
  );
  const rows = db.prepare("SELECT npub, participant_id FROM signers ORDER BY participant_id").all() as
    { npub: string; participant_id: number }[];
  return rows;
}

describe("governance", () => {
  it("defaultSignerSet returns the canonical policy-valid set", () => {
    const db = openTestDb();
    seedRoster(db);
    const set = defaultSignerSet(db);
    expect(set.map((s) => s.participantId)).toEqual(DEFAULT_VALID_PARTICIPANT_IDS);
  });

  it("resolveSignerSet maps npubs to participant ids and rejects non-signers", () => {
    const db = openTestDb();
    const rows = seedRoster(db);
    const picked = [rows[0].npub, rows[2].npub];
    const resolved = resolveSignerSet(db, picked);
    expect(resolved.map((s) => s.participantId)).toEqual([1, 3]);
    expect(() => resolveSignerSet(db, ["npub-not-a-signer"])).toThrow();
  });

  it("isSelectedSigner / allSelectedSigned track the chosen quorum", () => {
    const db = openTestDb();
    const rows = seedRoster(db);
    const set = resolveSignerSet(db, [rows[0].npub, rows[2].npub]);
    expect(isSelectedSigner(set, rows[0].npub)).toBe(true);
    expect(isSelectedSigner(set, rows[5].npub)).toBe(false);
    expect(isSelectedSigner(undefined, rows[0].npub)).toBe(false);

    db.prepare("INSERT INTO approvals (id, vault, kind, data_json, status, is_live, created_at) VALUES ('tx1','#x','send','{}','pending',1,0)").run();
    db.prepare("INSERT INTO approval_signatures (approval_id, npub, signed_at) VALUES ('tx1',?,0)").run(rows[0].npub);
    const signed1 = signedNpubs(db, "tx1");
    expect(allSelectedSigned(set, signed1)).toBe(false);
    db.prepare("INSERT INTO approval_signatures (approval_id, npub, signed_at) VALUES ('tx1',?,0)").run(rows[2].npub);
    expect(allSelectedSigned(set, signedNpubs(db, "tx1"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test -- app/api/_lib/governance.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `governance.ts`**

Create `app/api/_lib/governance.ts`:

```ts
import type { DB } from "./db";
import { listSigners } from "./identity";
import type { SelectedSigner } from "../../ui/wallet/types";

/** Canonical policy-valid minimal set for the (1,2,3)-of-(2,3,5) vault:
 * 1 C-level + 2 managers + 3 operators. */
export const DEFAULT_VALID_PARTICIPANT_IDS = [1, 3, 4, 6, 7, 8];

/** Resolve picked npubs to a signer set. Every npub must be a registered signer
 * (a row in `signers`); otherwise this throws. Order follows participant id. */
export function resolveSignerSet(db: DB, npubs: string[]): SelectedSigner[] {
  const roster = new Map(listSigners(db).map((s) => [s.npub, s]));
  const picked = npubs.map((npub) => {
    const s = roster.get(npub);
    if (!s) throw new Error(`not a registered signer: ${npub}`);
    return { participantId: s.participant_id, npub: s.npub, label: s.label };
  });
  return picked.sort((a, b) => a.participantId - b.participantId);
}

/** The default selection offered at propose time: the canonical valid set,
 * resolved from the live roster. Empty when the vault has no signer roster. */
export function defaultSignerSet(db: DB): SelectedSigner[] {
  const roster = new Map(listSigners(db).map((s) => [s.participant_id, s]));
  return DEFAULT_VALID_PARTICIPANT_IDS.flatMap((pid) => {
    const s = roster.get(pid);
    return s ? [{ participantId: s.participant_id, npub: s.npub, label: s.label }] : [];
  });
}

export function isSelectedSigner(signerSet: SelectedSigner[] | undefined, npub: string): boolean {
  return !!signerSet?.some((s) => s.npub === npub);
}

export function signedNpubs(db: DB, approvalId: string): Set<string> {
  const rows = db
    .prepare("SELECT npub FROM approval_signatures WHERE approval_id = ?")
    .all(approvalId) as { npub: string }[];
  return new Set(rows.map((r) => r.npub));
}

export function allSelectedSigned(signerSet: SelectedSigner[], signed: Set<string>): boolean {
  return signerSet.length > 0 && signerSet.every((s) => signed.has(s.npub));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test -- app/api/_lib/governance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/_lib/governance.ts app/api/_lib/governance.test.ts
git commit -m "feat(gov): governance helpers (signer-set resolution, selected-signer gate, signed-count)"
```

---

## Task 7: Web API — propose stores the signer set

**Files:**
- Modify: `app/api/approvals/route.ts` (POST)
- Test: `app/api/approvals/route.test.ts` (new)

**Interfaces:**
- Consumes: `resolveSignerSet`, `defaultSignerSet` (`../_lib/governance`).
- Produces: persisted `Approval.signerSet` + `threshold = signerSet.length` when a signer set is supplied or defaultable; otherwise the existing behavior (numeric threshold, no signer set).

- [ ] **Step 1: Update the POST handler**

In `app/api/approvals/route.ts`, import the helpers (`import { resolveSignerSet, defaultSignerSet } from "../_lib/governance";`). After parsing `body` and before building `approval`, resolve the signer set:

```ts
  // Propose-picks-signers: the proposer may send explicit `signerNpubs`; else we
  // default to the vault's canonical valid set (when it has a signer roster).
  let signerSet = body.signerSet;
  try {
    if (Array.isArray((body as { signerNpubs?: string[] }).signerNpubs)) {
      signerSet = resolveSignerSet(db, (body as { signerNpubs: string[] }).signerNpubs);
    } else if (!signerSet) {
      const def = defaultSignerSet(db);
      if (def.length > 0) signerSet = def;
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "invalid signer set" },
      { status: 400 },
    );
  }
```

Then in the `approval` literal, set the signer set and derive the threshold from it when present:

```ts
  const approval: Approval = {
    kind: "send",
    threshold: signerSet ? signerSet.length : 1,
    total: signerSet ? signerSet.length : 1,
    signed: 0,
    youSigned: false,
    status: "pending",
    policy: "",
    time: "just now",
    ...body,
    id: body.id ?? `tx_${randomBytes(5).toString("hex")}`,
    title: body.title,
    vault: body.vault,
    signerSet,
    threshold: signerSet ? signerSet.length : (body.threshold ?? 1),
    total: signerSet ? signerSet.length : (body.total ?? 1),
  } as Approval;
```

> The explicit `signerSet` / `threshold` / `total` after the `...body` spread ensure they win over whatever the client sent.

- [ ] **Step 2: Write the route test**

Create `app/api/approvals/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, seed } from "../_lib/db";
import { syncSigners } from "../_lib/identity";

const h = vi.hoisted(() => ({ token: "t" as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}));

import { POST } from "./route";

function install() {
  const db = new Database(":memory:");
  migrate(db);
  seed(db);
  syncSigners(
    db,
    Array.from({ length: 10 }, (_, i) => ({ participant_id: i + 1, label: `S${i + 1}`, role: "r" })),
  );
  db.prepare("INSERT INTO sessions (token, npub, created_at, expires_at) VALUES ('t', (SELECT npub FROM signers WHERE participant_id=1), 0, 4102444800000)").run();
  (globalThis as unknown as { __btechDb?: unknown }).__btechDb = db;
  return db;
}

describe("POST /api/approvals", () => {
  beforeEach(() => { h.token = "t"; });
  afterEach(() => { (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined; });

  it("defaults to the canonical valid signer set and derives threshold = 6", async () => {
    install();
    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({ title: "Transfer", vault: "#treasury-ops", live: true }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const { approval } = (await res.json()) as { approval: { signerSet: { participantId: number }[]; threshold: number } };
    expect(approval.signerSet.map((s) => s.participantId)).toEqual([1, 3, 4, 6, 7, 8]);
    expect(approval.threshold).toBe(6);
  });

  it("rejects an explicit signer set containing a non-signer with 400", async () => {
    install();
    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({ title: "Transfer", vault: "#treasury-ops", signerNpubs: ["npub-bogus"] }),
    });
    expect((await POST(req)).status).toBe(400);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `bun run test -- app/api/approvals/route.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck + commit**

Run: `bunx tsc --noEmit`

```bash
git add app/api/approvals/route.ts app/api/approvals/route.test.ts
git commit -m "feat(gov): propose persists chosen signerSet, derives threshold = chosen count"
```

---

## Task 8: Web API — selected-signer gate + collapsed two-round

**Files:**
- Modify: `app/api/approvals/[id]/sign/route.ts`
- Test: `app/api/approvals/[id]/sign/route.test.ts` (new)

**Interfaces:**
- Consumes: `isSelectedSigner`, `signedNpubs`, `allSelectedSigned` (`../../../_lib/governance`); `runPrecommit`, `runFinalize`, `runSignApproval`, `VAULTD_CONFIGURED` (`../../../_lib/btech`).
- Produces: signing semantics — only `signerSet` members may sign; each approve pre-commits (vaultd) and stores the public package; finalize runs once all chosen signers have submitted; fallback to one-shot when vaultd is unconfigured.

- [ ] **Step 1: Replace the signer gate**

In `app/api/approvals/[id]/sign/route.ts`, after parsing `approval`, add the selected-signer check (keep the existing `signers`-table lookup so we still have `participant_id`). Replace the block that rejects non-signers so it ALSO requires membership of the approval's `signerSet` when one is present:

```ts
  const signer = db
    .prepare("SELECT participant_id FROM signers WHERE npub = ? LIMIT 1")
    .get(user.npub) as { participant_id: number } | undefined;
  if (!signer) {
    recordAudit(db, { chatId: auditChatId, actorNpub: user.npub, actorLabel: user.label, action: "sign", outcome: "failed", detail: `${approval.title}: not a signer of this vault` });
    return NextResponse.json({ error: "You are not a signer of this vault." }, { status: 403 });
  }
  if (approval.signerSet && !isSelectedSigner(approval.signerSet, user.npub)) {
    recordAudit(db, { chatId: auditChatId, actorNpub: user.npub, actorLabel: user.label, action: "sign", outcome: "failed", detail: `${approval.title}: not a selected signer for this approval` });
    return NextResponse.json({ error: "You are not a selected signer for this approval." }, { status: 403 });
  }
```

Add the import: `import { isSelectedSigner, signedNpubs, allSelectedSigned } from "../../../_lib/governance";` and `import { runSignApproval, runPrecommit, runFinalize, VAULTD_CONFIGURED } from "../../../_lib/btech";`

- [ ] **Step 2: Pre-commit on approve, then record the vote**

Replace the current `INSERT OR IGNORE INTO approval_signatures …` block. For live approvals with a signer set and vaultd configured, pre-commit first and store the package:

```ts
  // Round 1 (collapsed two-round): a selected signer pre-commits their nonce as
  // they approve. The secret nonce stays in vaultd; we store only the public
  // package. Falls through to a plain vote when vaultd/ signerSet is absent.
  let precommitJson: string | null = null;
  if (live && approval.signerSet && VAULTD_CONFIGURED) {
    try {
      const pc = await runPrecommit(
        { session: approval.id, participantId: signer.participant_id },
        auditChatId,
      );
      precommitJson = JSON.stringify(pc.nonce_package);
    } catch (err) {
      recordAudit(db, { chatId: auditChatId, actorNpub: user.npub, actorLabel: user.label, action: "sign", outcome: "failed", detail: `${approval.title}: pre-commit failed` });
      return NextResponse.json({ error: err instanceof Error ? err.message : "pre-commit failed" }, { status: 502 });
    }
  }
  db.prepare(`
    INSERT OR IGNORE INTO approval_signatures (approval_id, npub, aggregate_signature, precommit, signed_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(id, user.npub, precommitJson, Date.now());
```

- [ ] **Step 3: Quorum + finalize**

Replace the `signed` count + `quorumReached` + the live one-shot block. Quorum is now "all chosen signers have submitted"; finalize uses the two-round when available, else the one-shot fallback:

```ts
  const signed = (
    db.prepare("SELECT COUNT(*) c FROM approval_signatures WHERE approval_id = ?").get(id) as { c: number }
  ).c;
  const quorumReached = approval.signerSet
    ? allSelectedSigned(approval.signerSet, signedNpubs(db, id))
    : signed >= approval.threshold;

  let proof: SigningProof | undefined = approval.proof;
  if (live && quorumReached && !approval.proof?.verified) {
    const recipient = approval.recipientAddress ?? approval.dest ?? "";
    const amountSats = approval.amountSats ?? Math.round(parseFloat(approval.btc ?? "0") * 1e8);
    try {
      const report =
        approval.signerSet && VAULTD_CONFIGURED
          ? await runFinalize(
              {
                session: approval.id,
                signerSet: approval.signerSet.map((s) => s.participantId),
                recipient,
                amountSats,
                nonce: approval.id,
                memo: approval.title,
              },
              auditChatId,
            )
          : await runSignApproval({ recipient, amountSats, nonce: approval.id, memo: approval.title }, auditChatId);
      if (!report.verified) throw new Error("aggregate signature failed verification");
      proof = {
        digest: report.authorization_digest,
        signature: report.aggregate_signature,
        groupKey: report.group_xonly_public_key,
        signers: report.signers,
        verified: report.verified,
      };
      db.prepare("UPDATE approval_signatures SET aggregate_signature = ? WHERE approval_id = ? AND npub = ?")
        .run(report.aggregate_signature, id, user.npub);
    } catch (err) {
      recordAudit(db, { chatId: auditChatId, actorNpub: user.npub, actorLabel: user.label, action: "sign", outcome: "failed", detail: `${approval.title}: ${err instanceof Error ? err.message : "signing failed"}` });
      return NextResponse.json({ error: err instanceof Error ? err.message : "Signing failed" }, { status: 502 });
    }
  }
```

The rest of the handler (`ready`, the `updated` object — which now also carries `signed` and the existing `proof`/`status` logic — the `UPDATE approvals` and final audit/`NextResponse.json`) is unchanged.

- [ ] **Step 4: Write the route test (gate + finalize-on-completion)**

Create `app/api/approvals/[id]/sign/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, seed } from "../../../_lib/db";
import { syncSigners } from "../../../_lib/identity";

const h = vi.hoisted(() => ({ npub: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "tok" }) }),
}));
// vaultd two-round stubbed: precommit is a no-op package; finalize verifies.
vi.mock("../../../_lib/btech", () => ({
  VAULTD_CONFIGURED: true,
  runPrecommit: vi.fn(async () => ({ participant_id: 1, nonce_package: { c: "pkg" } })),
  runFinalize: vi.fn(async () => ({
    authorization_digest: "d".repeat(64),
    aggregate_signature: "a".repeat(128),
    group_xonly_public_key: "g".repeat(64),
    signers: [1, 3, 4, 6, 7, 8],
    verified: true,
  })),
  runSignApproval: vi.fn(),
}));

import { POST } from "./route";

let db: Database.Database;
function asUser(participantId: number) {
  const row = db.prepare("SELECT npub FROM signers WHERE participant_id = ?").get(participantId) as { npub: string };
  db.prepare("INSERT OR REPLACE INTO sessions (token, npub, created_at, expires_at) VALUES ('tok', ?, 0, 4102444800000)").run(row.npub);
  return row.npub;
}
const ctx = () => ({ params: Promise.resolve({ id: "tx1" }) });
const post = () => POST(new Request("http://x/api/approvals/tx1/sign", { method: "POST" }), ctx());

describe("POST /api/approvals/[id]/sign — propose-picks-signers", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    seed(db);
    syncSigners(db, Array.from({ length: 10 }, (_, i) => ({ participant_id: i + 1, label: `S${i + 1}`, role: "r" })));
    const set = [1, 3, 4, 6, 7, 8].map((pid) => {
      const r = db.prepare("SELECT npub, label FROM signers WHERE participant_id = ?").get(pid) as { npub: string; label: string };
      return { participantId: pid, npub: r.npub, label: r.label };
    });
    db.prepare("INSERT INTO approvals (id, vault, kind, data_json, status, is_live, created_at) VALUES ('tx1','#treasury-ops','send',?, 'pending',1,0)").run(
      JSON.stringify({ id: "tx1", title: "Transfer", vault: "#treasury-ops", live: true, threshold: 6, signerSet: set, recipientAddress: "bcrt1qx", amountSats: 100000 }),
    );
    (globalThis as unknown as { __btechDb?: unknown }).__btechDb = db;
  });
  afterEach(() => { (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined; });

  it("rejects a signer who is not in the chosen set (participant 2)", async () => {
    asUser(2);
    expect((await post()).status).toBe(403);
  });

  it("finalizes once all six chosen signers have pre-committed", async () => {
    for (const pid of [1, 3, 4, 6, 7]) { asUser(pid); expect((await post()).status).toBe(200); }
    // Not ready until the sixth signs.
    let row = db.prepare("SELECT status FROM approvals WHERE id='tx1'").get() as { status: string };
    expect(row.status).toBe("pending");
    asUser(8);
    const res = await post();
    const { approval } = (await res.json()) as { approval: { status: string; proof?: { verified: boolean } } };
    expect(approval.status).toBe("ready");
    expect(approval.proof?.verified).toBe(true);
  });
});
```

- [ ] **Step 5: Run the test**

Run: `bun run test -- app/api/approvals/[id]/sign/route.test.ts`
Expected: PASS — participant 2 gets 403; the set finalizes only on the sixth approval.

- [ ] **Step 6: Full suite + typecheck + commit**

Run: `bun run test && bunx tsc --noEmit`

```bash
git add "app/api/approvals/[id]/sign/route.ts" "app/api/approvals/[id]/sign/route.test.ts"
git commit -m "feat(gov): selected-signer gate + collapsed two-round signing (precommit on approve, finalize on completion)"
```

---

## Task 9: UI — signer picker + approval-card signer states

**Files:**
- Modify: `app/ui/wallet/wallet.tsx` (send dialog picker + "needs you" filter)
- Modify: `app/ui/wallet/approval-card.tsx` (signer state display)

**Interfaces:**
- Consumes: `GET /api/auth/personas` (already fetched as `personas` in `wallet.tsx`) for the roster; `Approval.signerSet`, `SelectedSigner` types.
- Produces: the proposer picks signers (default = canonical valid set), POST sends `signerNpubs`; the approval card shows each chosen signer's state.

> The wallet has no unit tests (only `nostr-signer.test.ts`); verification here is typecheck + the manual run in Step 5. Keep edits minimal and follow the existing inline-style conventions in `wallet.tsx`.

- [ ] **Step 1: Add picker state to the send dialog**

In `app/ui/wallet/wallet.tsx`, where `sendForm` state lives, add a selected-signers set seeded from the personas that match the canonical valid set. Near the other `useState` hooks add:

```tsx
  const VALID_DEFAULT_IDS = [1, 3, 4, 6, 7, 8];
  const [signerPick, setSignerPick] = useState<Set<number>>(new Set(VALID_DEFAULT_IDS));
```

When the send dialog opens, reset it: `setSignerPick(new Set(VALID_DEFAULT_IDS));`.

- [ ] **Step 2: Render the picker**

Inside the send dialog JSX (where the form fields are), add a roster checklist grouped by role, driven by `personas` (already loaded). Each row toggles membership in `signerPick`:

```tsx
  <div style={{ marginTop: 10 }}>
    <div style={{ fontSize: 11, color: C.faint, marginBottom: 6 }}>
      Signers ({signerPick.size} chosen · all must sign)
    </div>
    {personas.map((p) => {
      const on = signerPick.has(p.participant_id);
      return (
        <label key={p.participant_id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={on}
            onChange={() =>
              setSignerPick((prev) => {
                const next = new Set(prev);
                if (on) next.delete(p.participant_id);
                else next.add(p.participant_id);
                return next;
              })
            }
          />
          <span>{p.label}</span>
          <span style={{ color: C.faint }}>· {p.role} · #{p.participant_id}</span>
        </label>
      );
    })}
  </div>
```

- [ ] **Step 3: Send the chosen npubs on propose**

In `submitSend`, map `signerPick` ids → npubs via `personas`, derive `threshold` from the count, and include `signerNpubs` in the POST body. Replace the `threshold`/`policy` derivation and the POST body:

```tsx
    const chosen = personas.filter((p) => signerPick.has(p.participant_id));
    const signerNpubs = chosen.map((p) => p.npub);
    const threshold = chosen.length;
    const policy = `${chosen.length} chosen signers`;
```

and add `signerNpubs` to the `proposal` object literal and the POST body:

```tsx
      // ...existing proposal fields...
      threshold,
      total: threshold,
      live: !!chat.receiveAddress,
    };
    // include signerNpubs so the server resolves + persists the signer set
    const body = { ...proposal, signerNpubs };
```

and change the fetch to `body: JSON.stringify(body)`.

> If `personas` is empty (no roster), `signerNpubs` is `[]` and the server falls back to its default/threshold path — the existing behavior. Guard the submit so it still works: if `chosen.length === 0`, omit `signerNpubs` from the body.

- [ ] **Step 4: Show signer states on the approval card**

In `app/ui/wallet/approval-card.tsx`, when `approval.signerSet` is present, render the chosen signers and their state. A signer is `Signed` when present in the approval's persisted signatures (the card already receives `approval.signed`/`youSigned`; extend the props if needed to pass the set of signed npubs, or display the count). Minimal version — list the chosen signers with the running count:

```tsx
{approval.signerSet && (
  <div style={{ marginTop: 8, fontSize: 11 }}>
    <div style={{ color: "#8a8f98", marginBottom: 4 }}>
      Chosen signers — {approval.signed}/{approval.signerSet.length} signed
    </div>
    {approval.signerSet.map((s) => (
      <span key={s.npub} style={{ display: "inline-block", marginRight: 8, opacity: 0.9 }}>
        {s.label} · #{s.participantId}
      </span>
    ))}
  </div>
)}
```

- [ ] **Step 5: Typecheck + manual verification**

Run: `bunx tsc --noEmit && bun run test`
Expected: no type errors; suite green.

Manual (with vaultd running and `BTECH_VAULTD_URL` set): log in as a signer, open `#treasury-ops`, propose a transfer — confirm the picker defaults to 6 signers; sign as each chosen signer (switch persona) and confirm the approval only flips to `ready`/verified after the sixth; sign as a non-chosen signer (participant 2) and confirm the 403 message surfaces.

- [ ] **Step 6: Commit**

```bash
git add app/ui/wallet/wallet.tsx app/ui/wallet/approval-card.tsx
git commit -m "feat(gov): signer picker in send dialog + chosen-signer state on approval card"
```

---

## Self-Review

**Spec coverage:**
- Part 1 channel visibility → Task 1 (`filterVisibleChats` + route). ✓ Includes unauthenticated=none, signers-see-all, DM rule unchanged.
- Part 2 data model (`signerSet`, `precommit` column) → Task 4. ✓
- Collapsed two-round Rust split (precommit/finalize, single-use) → Tasks 2–3. ✓
- vaultd clients → Task 5. ✓
- Governance helpers (selected-signer gate, signed count) → Task 6. ✓
- Propose-picks-signers persistence + threshold = count → Task 7. ✓
- Selected-signer gate + collapsed orchestration + one-shot fallback → Task 8. ✓
- Signer picker UI + card states → Task 9. ✓

**Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"similar to". The only intentional variables are `vN`/schema-version increment (Task 4 Step 4) and the `Cargo.toml` bin name (Task 3 Step 3) — both call out the exact thing to read and substitute.

**Type consistency:** `SelectedSigner { participantId, npub, label }` used identically in Tasks 4/6/7/8/9. `runPrecommit`/`runFinalize` signatures match between Task 5 (definition) and Task 8 (use). `htss_precommit`/`htss_finalize` names match across Tasks 2 (impl) and 3 (vaultd). `signerSet`/`signerNpubs` distinction (stored object vs. wire input) is consistent: client sends `signerNpubs`, server resolves to `signerSet`.

**Known scope notes (carried from spec):** propose-picks-signers targets the treasury roster; created channels with no signer rows fall through to the existing threshold path. Stage-2 on-chain Taproot sighash in finalize is out of scope (finalize binds the Stage-1 authorization digest).
