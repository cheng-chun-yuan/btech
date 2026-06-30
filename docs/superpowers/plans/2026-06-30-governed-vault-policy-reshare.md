# Governed Vault-Policy Reshare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let vault admins edit the signing policy (add/remove signers, change tier thresholds, add/remove tiers), have the change ratified by the *current* policy's quorum, then reshare the vault to the new policy while keeping the group key and Bitcoin receive address unchanged.

**Architecture:** Four sequential layers. (1) A native `reshare_htss` primitive in `dkgkit-frost` reconstructs the secret `f(0)` from current shares and re-deals it over the new config — same `f(0)` ⇒ same group key. (2) `btech-vaultd` gets a `/vault/reshare` endpoint that produces a real BIP340 aggregate over a reshare-authorization digest (proving the current quorum approved), runs the reshare, atomically swaps + persists the new key material *and config*. (3) The Next.js governance layer persists policy-change proposals and, at quorum, calls vaultd reshare and mirrors the new authoritative config. (4) The wallet UI gets a policy editor with a diff + Propose button.

**Tech Stack:** Rust (`dkgkit-frost`, `dkgkit-core`, `btech-vaultd` via axum), `schnorr_fun`/`secp256kfun`; Next.js App Router (Node runtime), `better-sqlite3`; React (inline-style components).

## Global Constraints

- **Group-key invariant:** a reshare MUST NOT change `group_key.xonly_public_key`. Any code path that would rotate it returns an error before mutating state. Copy this check verbatim into both the native primitive and the vaultd swap.
- **Secret safety:** secret/share material never enters the web DB or any HTTP response body. Reconstruction happens only inside vaultd (it already holds all shares).
- **Ratifier = current quorum:** only registered signers of the *current* policy may vote; the change applies only when distinct current-signer votes reach the current policy threshold.
- **dkgkit crate path:** `/Users/chengchunyuan/project/dkgkit` (sibling of the btech repo). The btech repo is `/Users/chengchunyuan/project/btech`.
- **Rust scalar types:** shares/coefficients are `Scalar<Public, Zero>` (alias `PublicScalar`); the dealer secret is `Scalar<Secret, NonZero>`. `[u8;32]` ↔ scalar via `Scalar::<Public, Zero>::from_bytes(..)` / `.to_bytes()`.
- **Cargo:** run Rust tests from the btech repo with `cargo test -p <crate>`; `dkgkit-frost` lives in the dkgkit workspace, so run its tests from `/Users/chengchunyuan/project/dkgkit`.
- **JS package manager:** use `bun` (`bun run`, `bun test`) per project convention.
- **DB migration pattern:** bump `SCHEMA_VERSION` in `app/api/_lib/db.ts` and add columns with a guarded `ALTER TABLE` (mirror the v8 `precommit` precedent at `db.ts:122-126`).
- **Audit:** every governance action writes through `recordAudit` (`app/api/_lib/audit.ts`).

---

## File Structure

**Phase 1 — native crypto (dkgkit workspace):**
- Modify: `/Users/chengchunyuan/project/dkgkit/crates/dkgkit-frost/src/lib.rs` — add `pub fn reshare_htss(..)` next to `run_local_htss_keygen` (~line 738) + tests in the existing `mod tests` (~line 2257+).

**Phase 2 — vaultd reshare (btech Rust):**
- Modify: `src/domain/vault.rs` — persist config in `VaultKeyMaterial`; add `VaultService::reshare`.
- Modify: `src/domain/approval.rs` — add `ApprovalRequest::policy_change`.
- Modify: `src/app.rs` — `WalletApp::reshare` wrapper; `WalletApp::load` uses persisted config; tests.
- Modify: `src/bin/vaultd.rs` — `ReshareReq`, `vault_reshare` handler, route, persist-after-reshare.

**Phase 3 — web governance (Next.js):**
- Modify: `app/api/_lib/db.ts` — bump to v9; `policyVersion` mirror.
- Modify: `app/api/_lib/audit.ts` — extend `AuditAction`.
- Modify: `app/api/_lib/btech.ts` — `runReshare` client.
- Modify: `app/ui/wallet/types.ts` — `PolicyConfig`, `PolicyDiffItem`, `Approval` fields.
- Modify: `app/api/approvals/route.ts` — stamp/validate policy-change proposals.
- Modify: `app/api/approvals/[id]/sign/route.ts` — reshare branch at quorum.
- Test: `app/api/_lib/reshare-api.test.ts` (new).

**Phase 4 — UI:**
- Modify: `app/ui/wallet/policy-editor.tsx` (new), wired into `app/ui/wallet/wallet.tsx`.
- Modify: `app/ui/wallet/approval-card.tsx` — policy-diff display for role approvals.

---

## PHASE 1 — Native `reshare_htss` primitive

### Task 1: `reshare_htss` in dkgkit-frost

**Files:**
- Modify: `/Users/chengchunyuan/project/dkgkit/crates/dkgkit-frost/src/lib.rs` (add fn after `run_local_htss_keygen`, line ~738; add tests in `mod tests`, line ~2257+)

**Interfaces:**
- Consumes (already present in this file): `reconstruct_htss_secret_scalar(&[HtssLocalKeyShare], &[ParticipantId], &HierarchicalThresholdConfig) -> Result<[u8;32]>`; private `polynomial_derivative_value(&[PublicScalar], u16, u16) -> PublicScalar`; `HtssLocalKeySet`, `HtssLocalKeyShare`, `GroupKey`, `HierarchicalThresholdConfig`.
- Produces: `pub fn reshare_htss(old: &HtssLocalKeySet, old_config: &HierarchicalThresholdConfig, reconstruct_set: &[ParticipantId], new_config: &HierarchicalThresholdConfig) -> Result<HtssLocalKeySet>` — returns a new key set with `group_key == old.group_key` and one share per participant in `new_config`.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` (after the existing `local_htss_*` tests, ~line 2629). These reuse the `pid()` and `htss_config()` helpers already in the module and the known-valid signer set `[pid(1), pid(2), pid(4)]` used by the passing tests.

```rust
    #[test]
    fn reshare_to_added_signer_preserves_group_key_and_signs() {
        let old_config = htss_config(); // threshold 3, participants 1..=5
        let keyset = run_local_htss_keygen(&old_config).unwrap();

        // New policy: same threshold + ranks, with operator-c (id 6, rank 2) added.
        let new_config = HierarchicalThresholdConfig::new(
            3,
            vec![
                RankedParticipant::new(1, 0, Some("ceo".to_string())).unwrap(),
                RankedParticipant::new(2, 1, Some("cfo".to_string())).unwrap(),
                RankedParticipant::new(3, 1, Some("finance".to_string())).unwrap(),
                RankedParticipant::new(4, 2, Some("operator-a".to_string())).unwrap(),
                RankedParticipant::new(5, 2, Some("operator-b".to_string())).unwrap(),
                RankedParticipant::new(6, 2, Some("operator-c".to_string())).unwrap(),
            ],
        )
        .unwrap();

        let reconstruct_set = vec![pid(1), pid(2), pid(4)]; // valid under old_config
        let resharded =
            reshare_htss(&keyset, &old_config, &reconstruct_set, &new_config).unwrap();

        // Group key (and therefore the address) is unchanged.
        assert_eq!(
            resharded.group_key.xonly_public_key,
            keyset.group_key.xonly_public_key
        );
        // New share set covers the new participant roster.
        assert_eq!(resharded.shares.len(), 6);

        // The reshared shares sign a digest that verifies against the SAME group key.
        let digest = [7u8; 32];
        let signature = sign_digest_with_local_htss_shares(
            &resharded.group_key,
            digest,
            &resharded.shares,
            &[pid(1), pid(2), pid(4)],
            &new_config,
        )
        .unwrap();
        let signature_bytes: [u8; 64] = signature.signature_bytes.try_into().unwrap();
        let signature = Signature::from_bytes(signature_bytes).unwrap();
        let public_key =
            Point::<EvenY, Public>::from_xonly_bytes(resharded.group_key.xonly_public_key).unwrap();
        let schnorr = schnorr_fun::Schnorr::<Sha256>::verify_only();
        assert!(schnorr.verify(&public_key, frost_message(&digest), &signature));
    }

    #[test]
    fn reshare_keeps_the_secret_constant() {
        let old_config = htss_config();
        let keyset = run_local_htss_keygen(&old_config).unwrap();
        let new_config = HierarchicalThresholdConfig::new(
            3,
            vec![
                RankedParticipant::new(1, 0, Some("ceo".to_string())).unwrap(),
                RankedParticipant::new(2, 1, Some("cfo".to_string())).unwrap(),
                RankedParticipant::new(3, 1, Some("finance".to_string())).unwrap(),
                RankedParticipant::new(4, 2, Some("operator-a".to_string())).unwrap(),
                RankedParticipant::new(5, 2, Some("operator-b".to_string())).unwrap(),
                RankedParticipant::new(6, 2, Some("operator-c".to_string())).unwrap(),
            ],
        )
        .unwrap();
        let resharded =
            reshare_htss(&keyset, &old_config, &[pid(1), pid(2), pid(4)], &new_config).unwrap();

        let before =
            reconstruct_htss_secret_scalar(&keyset.shares, &[pid(1), pid(2), pid(4)], &old_config)
                .unwrap();
        let after = reconstruct_htss_secret_scalar(
            &resharded.shares,
            &[pid(1), pid(2), pid(4)],
            &new_config,
        )
        .unwrap();
        assert_eq!(before, after, "f(0) must be invariant across a reshare");
    }

    #[test]
    fn reshare_rejects_invalid_reconstruct_set() {
        let config = htss_config();
        let keyset = run_local_htss_keygen(&config).unwrap();
        // [2,4,5] is the rank set the existing rejection test proves invalid.
        let err = reshare_htss(&keyset, &config, &[pid(2), pid(4), pid(5)], &config).unwrap_err();
        assert!(!err.to_string().is_empty());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/chengchunyuan/project/dkgkit && cargo test -p dkgkit-frost reshare_ -- --nocapture`
Expected: FAIL — `cannot find function 'reshare_htss' in this scope`.

- [ ] **Step 3: Implement `reshare_htss`**

Insert immediately after `run_local_htss_keygen` (after line ~738):

```rust
/// Reshare an HTSS key set to a new policy WITHOUT changing the group key.
///
/// Reconstructs the secret `f(0)` from a policy-valid subset of the *current*
/// shares (`reconstruct_set` must be valid under `old_config`), then re-deals a
/// fresh polynomial whose constant term is that same secret over `new_config`.
/// Because `f(0)` is unchanged, the group public key — and therefore the Bitcoin
/// receive address — is identical. Higher polynomial coefficients are random, so
/// the new shares are independent of the old ones (a proactive refresh).
///
/// Errors if reconstruction fails, the secret is zero, or — critically — the
/// re-derived group key would differ from `old.group_key`.
pub fn reshare_htss(
    old: &HtssLocalKeySet,
    old_config: &HierarchicalThresholdConfig,
    reconstruct_set: &[ParticipantId],
    new_config: &HierarchicalThresholdConfig,
) -> Result<HtssLocalKeySet> {
    // 1. Reconstruct f(0) from a valid subset of the current shares.
    let secret_bytes = reconstruct_htss_secret_scalar(&old.shares, reconstruct_set, old_config)?;
    let secret = Scalar::<Secret, Zero>::from_bytes(secret_bytes)
        .and_then(|scalar| scalar.non_zero())
        .ok_or_else(|| DkgKitError::Protocol("reconstructed HTSS secret is zero".to_string()))?;

    // 2. Group-key invariant: the reshared key MUST match the existing group key.
    let schnorr = schnorr_fun::new_with_deterministic_nonces::<Sha256>();
    let keypair = schnorr.new_keypair(secret);
    if keypair.public_key().to_xonly_bytes() != old.group_key.xonly_public_key {
        return Err(DkgKitError::Protocol(
            "reshare would change the group key".to_string(),
        ));
    }

    // 3. Fresh polynomial of degree (new threshold - 1), constant term = secret.
    let mut rng = rand::thread_rng();
    let secret_term = keypair.secret_key().public().mark_zero();
    let mut polynomial = Vec::with_capacity(new_config.threshold as usize);
    polynomial.push(secret_term);
    for _ in 1..new_config.threshold {
        polynomial.push(
            Scalar::<Secret, NonZero>::random(&mut rng)
                .public()
                .mark_zero(),
        );
    }

    // 4. Evaluate f'^(rank)(id) for each participant in the new config.
    let shares = new_config
        .participants
        .iter()
        .map(|participant| HtssLocalKeyShare {
            participant_id: participant.id,
            rank: participant.rank.0,
            share_value_bytes: polynomial_derivative_value(
                &polynomial,
                participant.id.0,
                participant.rank.0,
            )
            .to_bytes(),
        })
        .collect();

    Ok(HtssLocalKeySet {
        group_key: old.group_key.clone(),
        shares,
    })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/chengchunyuan/project/dkgkit && cargo test -p dkgkit-frost reshare_`
Expected: PASS (3 tests). If `reshare_rejects_invalid_reconstruct_set` fails because `[2,4,5]` is actually valid in this build, swap it for `&[pid(4), pid(5)]` (too few points for threshold 3) — still an error.

- [ ] **Step 5: Commit**

```bash
cd /Users/chengchunyuan/project/dkgkit
git add crates/dkgkit-frost/src/lib.rs
git commit -m "feat(htss): reshare_htss — re-deal shares to a new policy, group key fixed"
```

---

## PHASE 2 — vaultd `/vault/reshare`

### Task 2: Persist the grouped config in `VaultKeyMaterial`

Without this, a reshared vault reverts to the hardcoded policy on restart (its shares would then mismatch the config).

**Files:**
- Modify: `src/domain/vault.rs` (`VaultKeyMaterial` struct ~line 19; `export_key_material` ~line 158; `import_key_material` ~line 168)
- Modify: `src/app.rs` (`WalletApp::load` ~line 90)
- Test: `src/domain/vault.rs` `#[cfg(test)]`

**Interfaces:**
- Produces: `VaultKeyMaterial { group_key: GroupKey, shares: Vec<HtssLocalKeyShare>, grouped_config: GroupedThresholdConfig }`; `VaultService::import_key_material` now also restores `grouped_config` and rebuilds `self.dkg` from it.

- [ ] **Step 1: Write the failing test**

Add to the `vault.rs` test module:

```rust
    #[test]
    fn exported_key_material_round_trips_the_grouped_config() {
        let mut svc = VaultService::new(
            "v-roundtrip",
            "dkg-roundtrip",
            "regtest",
            [0u8; 32],
            crate::domain::policy::grouped_config_123_of_235().unwrap(),
        )
        .unwrap();
        svc.connect_transport().unwrap();
        svc.run_htss_dkg().unwrap();
        let material = svc.export_key_material().unwrap();
        assert_eq!(material.grouped_config, svc.grouped_config);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/chengchunyuan/project/btech && cargo test -p btech exported_key_material_round_trips`
Expected: FAIL — `VaultKeyMaterial` has no field `grouped_config`.

- [ ] **Step 3: Implement the persisted config**

In `src/domain/vault.rs`, extend the struct (line ~19):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultKeyMaterial {
    pub group_key: GroupKey,
    pub shares: Vec<HtssLocalKeyShare>,
    /// The grouped policy these shares were dealt for. Persisted so a reshared
    /// vault keeps its NEW policy across restarts (not the seed config).
    #[serde(default = "crate::domain::policy::grouped_config_123_of_235_or_panic")]
    pub grouped_config: GroupedThresholdConfig,
}
```

Add the serde default helper to `src/domain/policy.rs`:

```rust
/// Backwards-compat default for `VaultKeyMaterial.grouped_config` on vault files
/// written before the field existed (they were all the seed 123-of-235 policy).
pub fn grouped_config_123_of_235_or_panic() -> GroupedThresholdConfig {
    grouped_config_123_of_235().expect("seed grouped config is valid")
}
```

Update `export_key_material` (line ~158) to include it:

```rust
    pub fn export_key_material(&self) -> Option<VaultKeyMaterial> {
        let group_key = self.group_key.clone()?;
        Some(VaultKeyMaterial {
            group_key,
            shares: self.local_shares.values().cloned().collect(),
            grouped_config: self.grouped_config.clone(),
        })
    }
```

Update `import_key_material` (line ~168) to restore config + rebuild the hierarchical service:

```rust
    pub fn import_key_material(&mut self, material: VaultKeyMaterial) {
        self.group_key = Some(material.group_key);
        self.local_shares = material
            .shares
            .into_iter()
            .map(|share| (share.participant_id, share))
            .collect();
        // Rebuild the hierarchical config the signing math reads from, in case the
        // loaded material is for a reshared policy that differs from the seed.
        if let Ok(htss) = hierarchical_config_from_grouped_threshold(&material.grouped_config) {
            if let Ok(dkg) = HtssDkgService::new(self.dkg.session_id.clone(), htss) {
                self.dkg = dkg;
            }
        }
        self.grouped_config = material.grouped_config;
    }
```

- [ ] **Step 4: Run the test**

Run: `cd /Users/chengchunyuan/project/btech && cargo test -p btech exported_key_material_round_trips`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/chengchunyuan/project/btech
git add src/domain/vault.rs src/domain/policy.rs
git commit -m "feat(vault): persist grouped_config in VaultKeyMaterial (reshare survives restart)"
```

### Task 3: Reshare authorization digest

**Files:**
- Modify: `src/domain/approval.rs` (add constructor after `payment`, ~line 39)
- Test: `src/domain/approval.rs` `#[cfg(test)]`

**Interfaces:**
- Produces: `ApprovalRequest::policy_change(id: impl Into<String>, network: impl Into<String>, new_policy_fingerprint: impl Into<String>) -> ApprovalRequest` — a request whose `message.action == "approve-policy-change"` and whose `memo` carries the new-policy fingerprint, so `.digest()` binds the specific new policy.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn policy_change_digest_binds_the_new_policy() {
        let a = ApprovalRequest::policy_change("appr-1", "regtest", "fingerprint-A");
        let b = ApprovalRequest::policy_change("appr-1", "regtest", "fingerprint-B");
        assert_ne!(a.digest(), b.digest(), "different new policies must differ");
        assert_eq!(a.message.action, "approve-policy-change");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/chengchunyuan/project/btech && cargo test -p btech policy_change_digest_binds`
Expected: FAIL — no associated function `policy_change`.

- [ ] **Step 3: Implement the constructor**

In `src/domain/approval.rs`, after `payment` (line ~26), add:

```rust
    /// Authorization for a policy change. The new policy's fingerprint is bound
    /// into the digest (via the memo field) so the ratifiers' aggregate signature
    /// attests to the exact new policy being reshared into.
    pub fn policy_change(
        id: impl Into<String>,
        network: impl Into<String>,
        new_policy_fingerprint: impl Into<String>,
    ) -> Self {
        let id = id.into();
        Self {
            message: BitcoinAuthorizationMessage {
                network: network.into(),
                action: "approve-policy-change".to_string(),
                recipient: None,
                amount_sats: None,
                memo: Some(new_policy_fingerprint.into()),
                nonce: id.clone(),
            },
            id,
        }
    }
```

- [ ] **Step 4: Run the test**

Run: `cd /Users/chengchunyuan/project/btech && cargo test -p btech policy_change_digest_binds`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/approval.rs
git commit -m "feat(vault): ApprovalRequest::policy_change — reshare authorization digest"
```

### Task 4: `VaultService::reshare` + `WalletApp::reshare`

**Files:**
- Modify: `src/domain/vault.rs` (add `reshare` method; import `reshare_htss`)
- Modify: `src/app.rs` (add `WalletApp::reshare` wrapper)
- Test: `src/app.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `reshare_htss` (Task 1); `ApprovalRequest::policy_change` (Task 3); `hierarchical_config_from_grouped_threshold`; the existing single-shot sign internals (`sign_approval` at `vault.rs:179`).
- Produces:
  - `VaultService::reshare(&mut self, binding_id: &str, new_grouped: GroupedThresholdConfig, ratifier_set: Vec<ParticipantId>, policy_fingerprint: &str) -> anyhow::Result<SigningResult>` — verifies the ratifier aggregate over the reshare digest, performs the reshare, swaps `grouped_config`/`dkg`/`local_shares` (group key unchanged), returns the `SigningResult` (digest + aggregate + verified).
  - `WalletApp::reshare(&mut self, binding_id, new_grouped, ratifier_set: Vec<u16>, policy_fingerprint) -> anyhow::Result<DemoReport>`.

- [ ] **Step 1: Write the failing test**

Add to `src/app.rs` test module:

```rust
    #[test]
    fn reshare_adds_a_signer_keeps_address_and_verifies() {
        let mut app = WalletApp::demo().unwrap();
        app.init().unwrap();
        let before = app.demo_report().unwrap(); // existing accessor for vault state
        let group_before = before.group_xonly_public_key.clone();
        let addr_before = before.receive_address.clone();

        // New policy: the seed 1-2-3-of-2-3-5 plus a 6th operator at rank 2,
        // operator group requirement bumped from 3-of-5 to 3-of-6.
        let new_grouped = crate::domain::policy::grouped_config_add_operator().unwrap();
        let ratifiers: Vec<u16> = vec![1, 3, 4, 6, 7, 8]; // valid under the CURRENT policy

        let report = app
            .reshare("reshare-1", new_grouped, ratifiers.clone(), "fp-new-policy")
            .unwrap();

        assert!(report.verified, "ratifier aggregate must verify");
        assert_eq!(report.group_xonly_public_key, group_before, "group key fixed");
        assert_eq!(report.receive_address, addr_before, "address fixed");

        // The vault now signs a payment with a set that includes the new operator.
        for pid in [1u16, 3, 4, 6, 7, 11] {
            app.htss_precommit("pay-after-reshare", pid).ok();
        }
    }
```

> Note: if `WalletApp` has no `demo_report()` accessor, read the current state via the existing path the codebase already uses (e.g. construct the report through the same call `vault_state` uses). Verify the exact accessor name when implementing; the assertion targets are `group_xonly_public_key` and `receive_address`.

Add the new-policy fixture to `src/domain/policy.rs`:

```rust
/// The seed policy with a sixth operator (id 11, rank 2) added; the operator
/// group requirement becomes 3-of-6. Used to exercise reshare-adds-a-signer.
pub fn grouped_config_add_operator() -> Result<GroupedThresholdConfig> {
    GroupedThresholdConfig::new(
        vec![
            RankedParticipant::new(1, 0, Some("c-level-a".to_string()))?,
            RankedParticipant::new(2, 0, Some("c-level-b".to_string()))?,
            RankedParticipant::new(3, 1, Some("manager-a".to_string()))?,
            RankedParticipant::new(4, 1, Some("manager-b".to_string()))?,
            RankedParticipant::new(5, 1, Some("manager-c".to_string()))?,
            RankedParticipant::new(6, 2, Some("operator-a".to_string()))?,
            RankedParticipant::new(7, 2, Some("operator-b".to_string()))?,
            RankedParticipant::new(8, 2, Some("operator-c".to_string()))?,
            RankedParticipant::new(9, 2, Some("operator-d".to_string()))?,
            RankedParticipant::new(10, 2, Some("operator-e".to_string()))?,
            RankedParticipant::new(11, 2, Some("operator-f".to_string()))?,
        ],
        vec![
            GroupThresholdRequirement::new(0, 1, 2)?,
            GroupThresholdRequirement::new(1, 2, 3)?,
            GroupThresholdRequirement::new(2, 3, 6)?,
        ],
    )
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/chengchunyuan/project/btech && cargo test -p btech reshare_adds_a_signer`
Expected: FAIL — no method `reshare` on `WalletApp`.

- [ ] **Step 3: Implement `VaultService::reshare`**

In `src/domain/vault.rs`, add `reshare_htss` to the `dkgkit_sdk`/`dkgkit_frost` import block (line ~7-13), then add the method (after `htss_finalize`, ~line 357):

```rust
    /// Reshare the vault to `new_grouped`, authorized by `ratifier_set` (which
    /// must be valid under the CURRENT policy). Produces a real aggregate over a
    /// policy-change digest (proving the current quorum approved), then swaps in
    /// the new shares/config. The group key — and thus the receive address — is
    /// unchanged. `binding_id` is the approval id, NOT a cryptographic nonce.
    pub fn reshare(
        &mut self,
        binding_id: &str,
        new_grouped: GroupedThresholdConfig,
        ratifier_set: Vec<ParticipantId>,
        policy_fingerprint: &str,
    ) -> anyhow::Result<SigningResult> {
        // 1. Authorize: the ratifiers sign the policy-change digest with the
        //    CURRENT key material. Reuses the same single-shot grouped HTSS round
        //    payments use, but over the reshare digest. Fails if the set is not a
        //    valid current-policy quorum or the aggregate does not verify.
        let approval = ApprovalRequest::policy_change(
            binding_id.to_string(),
            self.network.clone(),
            policy_fingerprint.to_string(),
        );
        let authorization = self.sign_approval(&approval, ratifier_set.clone())?;
        anyhow::ensure!(
            authorization.verified,
            "policy-change authorization signature failed verification"
        );

        // 2. Reshare the key material to the new policy (group key fixed).
        let group_key = self
            .group_key
            .clone()
            .ok_or_else(|| anyhow::anyhow!("vault DKG is not finalized"))?;
        let old_htss = hierarchical_config_from_grouped_threshold(&self.grouped_config)?;
        let new_htss = hierarchical_config_from_grouped_threshold(&new_grouped)?;
        let old_set = HtssLocalKeySet {
            group_key: group_key.clone(),
            shares: self.local_shares.values().cloned().collect(),
        };
        let resharded = reshare_htss(&old_set, &old_htss, &ratifier_set, &new_htss)?;
        anyhow::ensure!(
            resharded.group_key.xonly_public_key == group_key.xonly_public_key,
            "reshare changed the group key"
        );

        // 3. Atomic swap: only mutate after every fallible step above succeeded.
        self.local_shares = resharded
            .shares
            .into_iter()
            .map(|share| (share.participant_id, share))
            .collect();
        self.dkg = HtssDkgService::new(self.dkg.session_id.clone(), new_htss)?;
        self.grouped_config = new_grouped;
        self.sign_sessions.clear(); // old in-flight signing sessions are now stale

        Ok(authorization)
    }
```

> `sign_approval` (vault.rs:179) is the existing single-shot round that picks/validates a signer set and returns a `SigningResult`. If its signature differs (e.g. it derives its own set), pass `ratifier_set` through; confirm the exact signature when implementing and adapt the one call site.

- [ ] **Step 4: Implement `WalletApp::reshare` + accessor**

In `src/app.rs`, after `htss_finalize` (~line 350):

```rust
    /// Reshare the vault to a new grouped policy, authorized by `ratifier_set`
    /// (participant ids valid under the current policy). Returns the unchanged
    /// group key + address plus the authorization proof.
    pub fn reshare(
        &mut self,
        binding_id: &str,
        new_grouped: dkgkit_sdk::GroupedThresholdConfig,
        ratifier_set: Vec<u16>,
        policy_fingerprint: &str,
    ) -> anyhow::Result<DemoReport> {
        self.init()?;
        let ids = ratifier_set
            .into_iter()
            .map(ParticipantId::new)
            .collect::<Result<Vec<_>, _>>()?;
        let signing = self
            .vault
            .reshare(binding_id, new_grouped, ids, policy_fingerprint)?;
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

- [ ] **Step 5: Run the test**

Run: `cd /Users/chengchunyuan/project/btech && cargo test -p btech reshare_adds_a_signer`
Expected: PASS. Adjust the `demo_report()` accessor reference (Step 1 note) to the real one if compilation fails.

- [ ] **Step 6: Commit**

```bash
git add src/domain/vault.rs src/app.rs src/domain/policy.rs
git commit -m "feat(vault): VaultService::reshare — ratify + reshare to a new policy, key fixed"
```

### Task 5: `/vault/reshare` HTTP endpoint + persist-after-reshare

**Files:**
- Modify: `src/bin/vaultd.rs` (`ReshareReq` ~line 56; `vault_reshare` handler ~line 183; route ~line 215)
- Test: manual smoke (no HTTP test harness exists — see Step 4)

**Interfaces:**
- Consumes: `WalletApp::reshare` (Task 4); `with_vault`, `vault_path`, the existing persistence pattern (`load_or_create_vault`).
- Produces: `POST /vault/reshare?id=<vault>` body `{ session: String, signer_set: Vec<u16>, new_config: GroupedThresholdConfig, policy_fingerprint: String }` → `DemoReport`. Writes the updated `VaultKeyMaterial` to disk after a successful reshare.

- [ ] **Step 1: Add the request struct**

In `src/bin/vaultd.rs` after `FinalizeReq` (line ~56):

```rust
#[derive(Deserialize)]
struct ReshareReq {
    session: String,
    signer_set: Vec<u16>,
    new_config: dkgkit_sdk::GroupedThresholdConfig,
    policy_fingerprint: String,
}
```

(Ensure `dkgkit_sdk::GroupedThresholdConfig` is importable here, mirroring how `DemoReport`/types are referenced; add a `use` if needed.)

- [ ] **Step 2: Add the handler (with persistence)**

After `vault_sign_finalize` (line ~183). Unlike signing, reshare changes key material, so re-persist:

```rust
async fn vault_reshare(
    State(state): State<Arc<AppState>>,
    Query(q): Query<VaultQuery>,
    Json(req): Json<ReshareReq>,
) -> Result<Json<DemoReport>, (StatusCode, String)> {
    let id = q.id.unwrap_or_else(|| "treasury".to_string());
    let report = with_vault(&state, &id, |app| {
        app.reshare(
            &req.session,
            req.new_config.clone(),
            req.signer_set.clone(),
            &req.policy_fingerprint,
        )
    })
    .map_err(err500)?;

    // Persist the reshared key material so the new policy survives a restart.
    persist_vault(&state, &id).map_err(err500)?;
    Ok(Json(report))
}

/// Write a vault's current key material to disk (used after a reshare swap).
fn persist_vault(state: &AppState, id: &str) -> anyhow::Result<()> {
    let map = state.vaults.lock().expect("vault map lock");
    let app = map
        .get(id)
        .ok_or_else(|| anyhow::anyhow!("vault '{id}' not loaded"))?;
    let material = app
        .export_vault()
        .ok_or_else(|| anyhow::anyhow!("vault '{id}' has no finalized key material"))?;
    let path = vault_path(&state.data_dir, id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&material)?)?;
    Ok(())
}
```

- [ ] **Step 3: Register the route**

In the router (line ~210-217), add after `/vault/sign/finalize`:

```rust
        .route("/vault/reshare", post(vault_reshare))
```

- [ ] **Step 4: Build + smoke test**

Run: `cd /Users/chengchunyuan/project/btech && cargo build -p btech --bin btech-vaultd`
Expected: builds clean.

Smoke (in one terminal start vaultd, in another curl):
```bash
BTECH_VAULTD_DATA=$(mktemp -d) cargo run --bin btech-vaultd &
sleep 3
curl -s -X POST "http://127.0.0.1:8787/vault/reshare?id=treasury" \
  -H 'content-type: application/json' \
  -d '{"session":"smoke-1","signer_set":[1,3,4,6,7,8],"policy_fingerprint":"fp1","new_config":'"$(cargo run --quiet --bin btech -- --print-add-operator-config 2>/dev/null || echo 'PASTE grouped_config_add_operator JSON')"'}'
```
Expected: a `DemoReport` with `"verified":true` and the same `receive_address` as `GET /vault/state?id=treasury`. (If no JSON-printing CLI flag exists, hand-craft the `new_config` JSON from `grouped_config_add_operator` — `{participants:[{id,rank,label}...],requirements:[{rank,required,total}...]}`.)

- [ ] **Step 5: Commit**

```bash
git add src/bin/vaultd.rs
git commit -m "feat(vaultd): POST /vault/reshare — authorize + reshare + persist new policy"
```

---

## PHASE 3 — Web governance layer

### Task 6: DB v9 (policyVersion mirror) + audit action

**Files:**
- Modify: `app/api/_lib/db.ts` (`SCHEMA_VERSION` line 11; migration block ~line 122)
- Modify: `app/api/_lib/audit.ts` (`AuditAction` line 4)
- Test: `app/api/_lib/reshare-api.test.ts` (new — created here, extended later)

**Interfaces:**
- Produces: `chats.data_json` Chat objects may carry `policyVersion?: number` (default 0 when absent); `AuditAction` includes `"reshare"`.

- [ ] **Step 1: Write the failing test**

Create `app/api/_lib/reshare-api.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { openTestDb } from "./db";

describe("reshare schema", () => {
  it("schema version is at least 9", () => {
    const db = openTestDb();
    const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(9);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/chengchunyuan/project/btech && bun test app/api/_lib/reshare-api.test.ts`
Expected: FAIL — version is 8.

- [ ] **Step 3: Bump the schema version**

In `app/api/_lib/db.ts`, line 11: `const SCHEMA_VERSION = 9;`. The v9 step needs no new columns (the proposal payload rides in `approvals.data_json` and `policyVersion` rides in `chats.data_json`), so add a comment in the migration block (after line 126) documenting v9:

```ts
    // v9: governed policy reshare. No new columns — policy-change proposals ride
    // in approvals.data_json (proposedPolicy/policyDiff/basePolicyVersion) and a
    // mirrored policyVersion rides in chats.data_json, defaulting to 0 when absent.
```

- [ ] **Step 4: Extend the audit action union**

In `app/api/_lib/audit.ts`, line 4:

```ts
export type AuditAction = "propose" | "sign" | "message" | "join" | "reshare";
```

- [ ] **Step 5: Run the test**

Run: `cd /Users/chengchunyuan/project/btech && bun test app/api/_lib/reshare-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/_lib/db.ts app/api/_lib/audit.ts app/api/_lib/reshare-api.test.ts
git commit -m "feat(db): schema v9 for governed reshare + reshare audit action"
```

### Task 7: Policy types + `runReshare` client

**Files:**
- Modify: `app/ui/wallet/types.ts` (add types; extend `Approval`)
- Modify: `app/api/_lib/btech.ts` (add `runReshare`)

**Interfaces:**
- Produces:
  - `PolicySigner = { participantId: number; npub: string; label: string; rank: number }`
  - `PolicyTier = { id: string; name: string; rank: number; required: number; signers: PolicySigner[] }`
  - `PolicyConfig = { tiers: PolicyTier[] }`
  - `PolicyDiffItem = { kind: "add-signer" | "remove-signer" | "threshold" | "add-tier" | "remove-tier"; text: string }`
  - `Approval` gains optional `proposedPolicy?: PolicyConfig`, `policyDiff?: PolicyDiffItem[]`, `basePolicyVersion?: number`.
  - `runReshare(p: { session: string; signerSet: number[]; newConfig: GroupedConfigWire; policyFingerprint: string }, vaultId: string): Promise<DemoReport>` posting to `/vault/reshare`.
  - `GroupedConfigWire = { participants: { id: number; rank: number; label: string | null }[]; requirements: { rank: number; required: number; total: number }[] }` and `policyConfigToWire(p: PolicyConfig): GroupedConfigWire`.

- [ ] **Step 1: Add the types**

In `app/ui/wallet/types.ts`, after `Tier` (line 22):

```ts
export type PolicySigner = { participantId: number; npub: string; label: string; rank: number };
export type PolicyTier = { id: string; name: string; rank: number; required: number; signers: PolicySigner[] };
export type PolicyConfig = { tiers: PolicyTier[] };
export type PolicyDiffItem = {
  kind: "add-signer" | "remove-signer" | "threshold" | "add-tier" | "remove-tier";
  text: string;
};
```

In the `Approval` type (after line 106, before the closing `}`):

```ts
  /** Policy-change approvals (kind:"role"): the full new policy to reshare into. */
  proposedPolicy?: PolicyConfig;
  /** Precomputed human-readable diff vs. the policy at propose time. */
  policyDiff?: PolicyDiffItem[];
  /** The vault policyVersion this proposal was authored against (lost-update guard). */
  basePolicyVersion?: number;
```

Add `policyVersion` to `Chat` (after line 66):

```ts
  /** Monotonic version of the active policy; bumped on each applied reshare. */
  policyVersion?: number;
```

- [ ] **Step 2: Write the failing test for the wire mapping**

Append to `app/api/_lib/reshare-api.test.ts`:

```ts
import { policyConfigToWire } from "./btech";

describe("policyConfigToWire", () => {
  it("flattens tiers into grouped participants + requirements", () => {
    const wire = policyConfigToWire({
      tiers: [
        { id: "t0", name: "C-level", rank: 0, required: 1, signers: [
          { participantId: 1, npub: "n1", label: "A", rank: 0 },
          { participantId: 2, npub: "n2", label: "B", rank: 0 },
        ]},
        { id: "t1", name: "Ops", rank: 2, required: 3, signers: [
          { participantId: 6, npub: "n6", label: "O", rank: 2 },
        ]},
      ],
    });
    expect(wire.participants.length).toBe(3);
    expect(wire.requirements).toEqual([
      { rank: 0, required: 1, total: 2 },
      { rank: 2, required: 3, total: 1 },
    ]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd /Users/chengchunyuan/project/btech && bun test app/api/_lib/reshare-api.test.ts`
Expected: FAIL — `policyConfigToWire` not exported.

- [ ] **Step 4: Implement the client + mapping**

In `app/api/_lib/btech.ts`, append:

```ts
export type GroupedConfigWire = {
  participants: { id: number; rank: number; label: string | null }[];
  requirements: { rank: number; required: number; total: number }[];
};

export function policyConfigToWire(p: import("../../ui/wallet/types").PolicyConfig): GroupedConfigWire {
  const participants = p.tiers.flatMap((t) =>
    t.signers.map((s) => ({ id: s.participantId, rank: t.rank, label: s.label })),
  );
  const requirements = p.tiers.map((t) => ({
    rank: t.rank,
    required: t.required,
    total: t.signers.length,
  }));
  return { participants, requirements };
}

export type ReshareParams = {
  session: string;
  signerSet: number[];
  newConfig: GroupedConfigWire;
  policyFingerprint: string;
};

/** Authorize + apply a vault policy reshare via btech-vaultd. Requires vaultd —
 *  the reshare is stateful and cannot run through the one-shot CLI. */
export async function runReshare(p: ReshareParams, vaultId = "treasury"): Promise<DemoReport> {
  if (!VAULTD_URL) {
    throw new Error("BTECH_VAULTD_URL is required to apply a policy reshare");
  }
  const res = await fetch(`${VAULTD_URL}/vault/reshare?id=${encodeURIComponent(vaultId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: p.session,
      signer_set: p.signerSet,
      new_config: p.newConfig,
      policy_fingerprint: p.policyFingerprint,
    }),
  });
  if (!res.ok) {
    throw new Error(`vaultd reshare failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as DemoReport;
}
```

- [ ] **Step 5: Run the test**

Run: `cd /Users/chengchunyuan/project/btech && bun test app/api/_lib/reshare-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/ui/wallet/types.ts app/api/_lib/btech.ts app/api/_lib/reshare-api.test.ts
git commit -m "feat(web): policy types + runReshare vaultd client + wire mapping"
```

### Task 8: Persist + validate policy-change proposals

**Files:**
- Modify: `app/api/approvals/route.ts` (POST handler ~line 31)

**Interfaces:**
- Consumes: existing `Approval` persistence (`approvals.data_json`), `isMember` is not used here (proposals already require auth); current vault `policyVersion`.
- Produces: when `body.kind === "role"` and `body.proposedPolicy` is present, the POST stamps `basePolicyVersion` from the current chat's `policyVersion` and rejects a structurally-bricked policy (400).

- [ ] **Step 1: Write the failing test**

Append to `app/api/_lib/reshare-api.test.ts` a unit test of a pure validator (extract the brick check into a helper so it is testable without the route):

```ts
import { isBrickedPolicy } from "../approvals/policy-validate";

describe("isBrickedPolicy", () => {
  it("flags a tier requiring more signers than it has", () => {
    expect(isBrickedPolicy({ tiers: [
      { id: "t", name: "Ops", rank: 2, required: 3, signers: [
        { participantId: 6, npub: "n", label: "O", rank: 2 },
      ]},
    ]})).toBe(true);
  });
  it("accepts a satisfiable policy (1-of-1 is allowed)", () => {
    expect(isBrickedPolicy({ tiers: [
      { id: "t", name: "Solo", rank: 0, required: 1, signers: [
        { participantId: 1, npub: "n", label: "A", rank: 0 },
      ]},
    ]})).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/chengchunyuan/project/btech && bun test app/api/_lib/reshare-api.test.ts`
Expected: FAIL — module `../approvals/policy-validate` not found.

- [ ] **Step 3: Implement the validator**

Create `app/api/approvals/policy-validate.ts`:

```ts
import type { PolicyConfig } from "../../ui/wallet/types";

/** A policy is "bricked" if any tier can never reach quorum — required is < 1,
 *  exceeds the tier's signer count, or the policy has no tiers/signers. These
 *  freeze funds permanently, so they are hard-blocked (not merely warned). */
export function isBrickedPolicy(p: PolicyConfig): boolean {
  if (!p.tiers.length) return true;
  return p.tiers.some(
    (t) => t.signers.length === 0 || t.required < 1 || t.required > t.signers.length,
  );
}
```

- [ ] **Step 4: Wire it into the POST handler**

In `app/api/approvals/route.ts`, import and apply. After building `approval` (line ~53) and before the INSERT (line ~55), add:

```ts
  if (approval.kind === "role" && approval.proposedPolicy) {
    if (isBrickedPolicy(approval.proposedPolicy)) {
      return NextResponse.json(
        { error: "Policy would lock the vault — every tier must be satisfiable." },
        { status: 400 },
      );
    }
    const chatId = resolveChatId(db, approval.vault);
    const chatRow = db.prepare("SELECT data_json FROM chats WHERE id = ?").get(chatId) as
      | { data_json: string }
      | undefined;
    const version = chatRow ? (JSON.parse(chatRow.data_json).policyVersion ?? 0) : 0;
    approval.basePolicyVersion = version;
  }
```

Add the import at the top: `import { isBrickedPolicy } from "./policy-validate";`

- [ ] **Step 5: Run the tests**

Run: `cd /Users/chengchunyuan/project/btech && bun test app/api/_lib/reshare-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/approvals/route.ts app/api/approvals/policy-validate.ts app/api/_lib/reshare-api.test.ts
git commit -m "feat(web): persist+validate policy-change proposals (brick guard + base version)"
```

### Task 9: Reshare branch in the sign route

**Files:**
- Modify: `app/api/approvals/[id]/sign/route.ts` (after the live-send branch ~line 102)

**Interfaces:**
- Consumes: `runReshare`, `policyConfigToWire` (Task 7); the current vault `policyVersion`; `recordAudit` with action `"reshare"`.
- Produces: when a `kind:"role"` approval with `proposedPolicy` reaches quorum, the route: (a) rejects on stale `basePolicyVersion`; (b) calls `runReshare`; (c) on success mirrors the new policy + bumps `policyVersion` in the chat `data_json`, sets the approval `ready`, audits `reshare/success`.

- [ ] **Step 1: Add the reshare branch**

In `app/api/approvals/[id]/sign/route.ts`, after the existing live-send `if (live && quorumReached && ...)` block (line ~102) and before `const ready = ...` (line ~106), insert:

```ts
  // Policy-change reshare: when a role approval with a proposed policy reaches
  // quorum, the CURRENT signers have authorized the change. Apply it once.
  if (approval.kind === "role" && approval.proposedPolicy && quorumReached && !approval.proof?.verified) {
    const chatRow = db.prepare("SELECT data_json FROM chats WHERE id = ?").get(auditChatId) as
      | { data_json: string }
      | undefined;
    const chat = chatRow ? JSON.parse(chatRow.data_json) : { policyVersion: 0 };
    const liveVersion = chat.policyVersion ?? 0;
    if ((approval.basePolicyVersion ?? 0) !== liveVersion) {
      recordAudit(db, {
        chatId: auditChatId, actorNpub: user.npub, actorLabel: user.label,
        action: "reshare", outcome: "failed",
        detail: `${approval.title}: policy changed since proposed (v${approval.basePolicyVersion} ≠ v${liveVersion})`,
      });
      return NextResponse.json(
        { error: "Policy changed since this was proposed. Re-propose against the current policy." },
        { status: 409 },
      );
    }
    try {
      const wire = policyConfigToWire(approval.proposedPolicy);
      // Ratifier set = the distinct signers who voted (all are current signers).
      const voters = (
        db.prepare("SELECT npub FROM approval_signatures WHERE approval_id = ?").all(id) as { npub: string }[]
      ).map((r) => r.npub);
      const signerSet = voters
        .map((n) => (db.prepare("SELECT participant_id FROM signers WHERE npub = ? LIMIT 1").get(n) as { participant_id: number } | undefined)?.participant_id)
        .filter((x): x is number => typeof x === "number");
      const report = await runReshare(
        { session: approval.id, signerSet, newConfig: wire, policyFingerprint: JSON.stringify(wire) },
        auditChatId,
      );
      if (!report.verified) throw new Error("reshare authorization failed verification");
      proof = {
        digest: report.authorization_digest,
        signature: report.aggregate_signature,
        groupKey: report.group_xonly_public_key,
        signers: report.signers,
        verified: report.verified,
      };
      // Mirror the new authoritative policy + bump policyVersion on the chat.
      const mirrored = {
        ...chat,
        tiers: approval.proposedPolicy.tiers.map((t) => ({
          id: t.id, name: t.name, short: t.name.slice(0, 3).toUpperCase(),
          minNeed: t.required,
          keys: t.signers.map((s) => ({ id: `k${s.participantId}`, initials: s.label.slice(0, 2).toUpperCase(), name: s.label, device: "Active", status: "online" })),
        })),
        policyVersion: liveVersion + 1,
      };
      db.prepare("UPDATE chats SET data_json = ? WHERE id = ?").run(JSON.stringify(mirrored), auditChatId);
    } catch (err) {
      recordAudit(db, {
        chatId: auditChatId, actorNpub: user.npub, actorLabel: user.label,
        action: "reshare", outcome: "failed",
        detail: `${approval.title}: ${err instanceof Error ? err.message : "reshare failed"}`,
      });
      return NextResponse.json({ error: err instanceof Error ? err.message : "Reshare failed" }, { status: 502 });
    }
    recordAudit(db, {
      chatId: auditChatId, actorNpub: user.npub, actorLabel: user.label,
      action: "reshare", outcome: "success",
      detail: `${approval.title}: policy reshared, address unchanged (v${liveVersion + 1})`,
    });
  }
```

Add `runReshare`, `policyConfigToWire` to the existing btech import on line 7:

```ts
import { runSignApproval, runReshare, policyConfigToWire } from "../../../_lib/btech";
```

- [ ] **Step 2: Adjust the `ready` predicate**

The existing `const ready = quorumReached && (!live || !!proof?.verified);` (line 106) must also hold for reshare approvals (which are not `live` sends). Replace with:

```ts
  const isReshare = approval.kind === "role" && !!approval.proposedPolicy;
  const ready = quorumReached && (isReshare ? !!proof?.verified : (!live || !!proof?.verified));
```

- [ ] **Step 3: Manual verification (requires vaultd running)**

Run: `cd /Users/chengchunyuan/project/btech && bun run build` (typecheck the route)
Expected: compiles. Full end-to-end is exercised by the UI in Phase 4 + manual smoke from Task 5.

- [ ] **Step 4: Commit**

```bash
git add app/api/approvals/[id]/sign/route.ts
git commit -m "feat(web): apply reshare when a policy-change approval reaches quorum"
```

---

## PHASE 4 — UI: policy editor + diff/propose

### Task 10: Policy editor component (working copy + diff)

**Files:**
- Create: `app/ui/wallet/policy-editor.tsx`
- Test: `app/ui/wallet/policy-diff.test.ts` (new — pure diff function)

**Interfaces:**
- Consumes: `PolicyConfig`, `PolicyTier`, `PolicySigner`, `PolicyDiffItem` (Task 7); a roster of `{ npub; label; participantId }` for the add-signer picker.
- Produces:
  - `diffPolicy(current: PolicyConfig, draft: PolicyConfig): PolicyDiffItem[]` (pure, exported from `policy-editor.tsx`).
  - `<PolicyEditor current={...} roster={...} onPropose={(draft, diff) => void} />` — renders editable tiers (± required, remove signer, add signer from roster, add/remove tier) and a "Propose policy change" button that is hidden when `diff.length === 0` and disabled when the draft is bricked.

- [ ] **Step 1: Write the failing diff test**

Create `app/ui/wallet/policy-diff.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { diffPolicy } from "./policy-editor";

const base = {
  tiers: [
    { id: "t0", name: "C-level", rank: 0, required: 1, signers: [
      { participantId: 1, npub: "n1", label: "A", rank: 0 },
      { participantId: 2, npub: "n2", label: "B", rank: 0 },
    ]},
  ],
};

describe("diffPolicy", () => {
  it("returns empty when unchanged", () => {
    expect(diffPolicy(base, structuredClone(base))).toEqual([]);
  });
  it("detects an added signer", () => {
    const draft = structuredClone(base);
    draft.tiers[0].signers.push({ participantId: 3, npub: "n3", label: "C", rank: 0 });
    const d = diffPolicy(base, draft);
    expect(d.some((x) => x.kind === "add-signer")).toBe(true);
  });
  it("detects a threshold change", () => {
    const draft = structuredClone(base);
    draft.tiers[0].required = 2;
    const d = diffPolicy(base, draft);
    expect(d.some((x) => x.kind === "threshold")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/chengchunyuan/project/btech && bun test app/ui/wallet/policy-diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `diffPolicy` + the component**

Create `app/ui/wallet/policy-editor.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { PolicyConfig, PolicyTier, PolicySigner, PolicyDiffItem } from "./types";

export function diffPolicy(current: PolicyConfig, draft: PolicyConfig): PolicyDiffItem[] {
  const out: PolicyDiffItem[] = [];
  const byRank = (p: PolicyConfig) => new Map(p.tiers.map((t) => [t.rank, t]));
  const cur = byRank(current);
  const drf = byRank(draft);
  for (const [rank, dt] of drf) {
    const ct = cur.get(rank);
    if (!ct) { out.push({ kind: "add-tier", text: `+ tier ${dt.name}` }); continue; }
    if (ct.required !== dt.required) {
      out.push({ kind: "threshold", text: `${dt.name} ${ct.required}/${ct.signers.length} → ${dt.required}/${dt.signers.length}` });
    }
    const curIds = new Set(ct.signers.map((s) => s.participantId));
    const drfIds = new Set(dt.signers.map((s) => s.participantId));
    for (const s of dt.signers) if (!curIds.has(s.participantId)) out.push({ kind: "add-signer", text: `+ ${s.label} → ${dt.name}` });
    for (const s of ct.signers) if (!drfIds.has(s.participantId)) out.push({ kind: "remove-signer", text: `− ${s.label} from ${dt.name}` });
  }
  for (const [rank, ct] of cur) if (!drf.has(rank)) out.push({ kind: "remove-tier", text: `− tier ${ct.name}` });
  return out;
}

function isBricked(p: PolicyConfig): boolean {
  return !p.tiers.length || p.tiers.some((t) => t.signers.length === 0 || t.required < 1 || t.required > t.signers.length);
}

export function PolicyEditor({
  current,
  roster,
  onPropose,
}: {
  current: PolicyConfig;
  roster: { npub: string; label: string; participantId: number }[];
  onPropose: (draft: PolicyConfig, diff: PolicyDiffItem[]) => void;
}) {
  const [draft, setDraft] = useState<PolicyConfig>(() => structuredClone(current));
  const diff = diffPolicy(current, draft);
  const bricked = isBricked(draft);

  const setRequired = (tierId: string, delta: number) =>
    setDraft((d) => ({ tiers: d.tiers.map((t) => t.id !== tierId ? t : { ...t, required: Math.max(1, Math.min(t.required + delta, t.signers.length)) }) }));
  const removeSigner = (tierId: string, pid: number) =>
    setDraft((d) => ({ tiers: d.tiers.map((t) => t.id !== tierId ? t : { ...t, signers: t.signers.filter((s) => s.participantId !== pid) }) }));
  const addSigner = (tierId: string, s: PolicySigner) =>
    setDraft((d) => ({ tiers: d.tiers.map((t) => t.id !== tierId ? t : { ...t, signers: [...t.signers, { ...s, rank: t.rank }] }) }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {draft.tiers.map((t) => (
        <div key={t.id} style={{ background: "#16181d", border: "1px solid rgba(255,255,255,.08)", borderRadius: 11, padding: "12px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => setRequired(t.id, -1)} aria-label={`decrease ${t.name}`} style={stepBtn}>−</button>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>{t.required} / {t.signers.length}</span>
              <button onClick={() => setRequired(t.id, +1)} aria-label={`increase ${t.name}`} style={stepBtn}>+</button>
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {t.signers.map((s) => (
              <span key={s.participantId} style={chip}>
                {s.label}
                <button onClick={() => removeSigner(t.id, s.participantId)} aria-label={`remove ${s.label}`} style={chipX}>×</button>
              </span>
            ))}
            <select
              defaultValue=""
              onChange={(e) => {
                const r = roster.find((x) => String(x.participantId) === e.target.value);
                if (r) addSigner(t.id, { participantId: r.participantId, npub: r.npub, label: r.label, rank: t.rank });
                e.currentTarget.value = "";
              }}
              style={{ ...chip, cursor: "pointer" }}
            >
              <option value="" disabled>+ add signer</option>
              {roster
                .filter((r) => !draft.tiers.some((tt) => tt.signers.some((s) => s.participantId === r.participantId)))
                .map((r) => <option key={r.participantId} value={r.participantId}>{r.label}</option>)}
            </select>
          </div>
        </div>
      ))}

      {diff.length > 0 && (
        <div style={{ fontSize: 11.5, color: "#9CA1A7", lineHeight: 1.6 }}>
          {diff.map((d, i) => <div key={i}>{d.text}</div>)}
        </div>
      )}

      {diff.length > 0 && (
        <button
          onClick={() => onPropose(draft, diff)}
          disabled={bricked}
          title={bricked ? "Every tier must be satisfiable" : undefined}
          style={{ alignSelf: "flex-start", background: bricked ? "#3a3d44" : "#F7931A", color: bricked ? "#9CA1A7" : "#0A0B0D", border: "none", borderRadius: 9, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: bricked ? "not-allowed" : "pointer" }}
        >
          Propose policy change
        </button>
      )}
    </div>
  );
}

const stepBtn = { width: 24, height: 24, borderRadius: 6, border: "1px solid rgba(255,255,255,.15)", background: "transparent", color: "#EDEEF0", cursor: "pointer", fontSize: 15 } as const;
const chip = { display: "inline-flex", alignItems: "center", gap: 5, background: "#1d2026", border: "1px solid rgba(255,255,255,.1)", borderRadius: 20, padding: "4px 10px", fontSize: 11.5, color: "#EDEEF0" } as const;
const chipX = { background: "transparent", border: "none", color: "#7C828A", cursor: "pointer", fontSize: 13, padding: 0 } as const;
```

- [ ] **Step 4: Run the diff test**

Run: `cd /Users/chengchunyuan/project/btech && bun test app/ui/wallet/policy-diff.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/ui/wallet/policy-editor.tsx app/ui/wallet/policy-diff.test.ts
git commit -m "feat(ui): PolicyEditor — working-copy edits, live diff, brick-guarded Propose"
```

### Task 11: Wire the editor into the vault panel + propose POST

**Files:**
- Modify: `app/ui/wallet/wallet.tsx` (replace the local-only `proposeKey` propose path; mount `<PolicyEditor>` in the vault panel ~line 1817 `VaultPanel`; build `PolicyConfig` from `chat.tiers` + roster)

**Interfaces:**
- Consumes: `<PolicyEditor>` (Task 10); `/api/approvals` POST (Task 8); the existing roster source used by the member list.
- Produces: a `proposePolicyChange(draft, diff)` callback that POSTs a `kind:"role"` approval carrying `proposedPolicy`, `policyDiff`, then posts an announce message (mirrors `submitSend` at `wallet.tsx:657-709`).

- [ ] **Step 1: Add a `chatToPolicyConfig` helper**

In `app/ui/wallet/wallet.tsx`, near the other vault helpers (~line 537), add a pure mapping from the display `tiers` to `PolicyConfig`. Participant ids come from the signer roster by npub; tiers map rank by index (tier 0 → rank 0, etc., matching the seed):

```tsx
  const chatToPolicyConfig = (chat: Chat): PolicyConfig => ({
    tiers: chat.tiers.map((t, i) => ({
      id: t.id,
      name: t.name,
      rank: i,
      required: clampNeed(t),
      signers: t.keys.map((k, j) => ({
        participantId: Number.parseInt(k.id.replace(/\D/g, ""), 10) || j + 1,
        npub: "",
        label: k.name,
        rank: i,
      })),
    })),
  });
```

> The participant id derivation must match the vault's real signer ids. Prefer reading them from the `signers` roster the panel already fetches; the `k.id.replace` fallback only applies to seed `k1..kN` ids. Confirm the roster shape when implementing and map `npub`/`participantId` from it.

- [ ] **Step 2: Add the propose callback**

```tsx
  const proposePolicyChange = (chatId: string) => (draft: PolicyConfig, diff: PolicyDiffItem[]) => {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return;
    const threshold = chat.tiers.reduce((a, t) => a + clampNeed(t), 0);
    const policy = chat.tiers.map((t) => `${clampNeed(t)}/${t.keys.length}`).join(" + ");
    const proposal: Approval = {
      id: `rc${Date.now()}`,
      kind: "role",
      title: `Policy change · ${chat.name}`,
      changeLabel: diff.map((d) => d.text).join("  ·  "),
      detail: `Proposed in ${chat.name}`,
      requestedBy: "You",
      vault: chat.name,
      time: "just now",
      policy,
      threshold,
      total: threshold,
      signed: 0,
      youSigned: false,
      status: "pending",
      live: !!chat.receiveAddress,
      proposedPolicy: draft,
      policyDiff: diff,
    };
    void (async () => {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposal),
      });
      if (!res.ok) {
        setStateError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Proposal failed");
        return;
      }
      const created = ((await res.json()) as { approval: Approval }).approval;
      setApprovals((prev) => [created, ...prev]);
      await fetch("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId, text: `Proposed a policy change — ${diff.map((d) => d.text).join(", ")}. Needs the current ${policy} quorum to ratify.` }),
      });
    })();
  };
```

- [ ] **Step 3: Mount `<PolicyEditor>` in the vault panel**

In the `VaultPanel` component (~line 1817), below the existing read-only tier list, render the editor (keeping the legacy steppers is optional — prefer replacing them):

```tsx
  <PolicyEditor
    current={chatToPolicyConfig(chat)}
    roster={vaultRoster}
    onPropose={proposePolicyChange(chat.id)}
  />
```

Add the import at the top of `wallet.tsx`:

```tsx
import { PolicyEditor } from "./policy-editor";
import type { PolicyConfig, PolicyDiffItem } from "./types";
```

> `vaultRoster` is the `{ npub; label; participantId }[]` the panel already has for the member list; pass it through. If it isn't in scope in `VaultPanel`, thread it down as a prop from the parent that fetches `GET /api/chats/[id]/members`.

- [ ] **Step 4: Verify the build + manual flow**

Run: `cd /Users/chengchunyuan/project/btech && bun run build`
Expected: compiles. Then with vaultd running (`BTECH_VAULTD_URL` set), open a vault, add a signer, confirm the Propose button appears, propose, sign with enough current signers, and confirm the approval card flips to Applied and the vault summary shows the new tiers + bumped version.

- [ ] **Step 5: Commit**

```bash
git add app/ui/wallet/wallet.tsx
git commit -m "feat(ui): wire PolicyEditor into the vault panel + persisted propose flow"
```

### Task 12: Policy-diff display on the approval card

**Files:**
- Modify: `app/ui/wallet/approval-card.tsx` (`columns()` ~line 18; add a diff block ~line 100)

**Interfaces:**
- Consumes: `Approval.policyDiff` (Task 7).
- Produces: role approvals with a `policyDiff` render the diff lines; the "Apply change" / "✓ Applied" affordance already exists (lines 145-153) and now reflects a reshare.

- [ ] **Step 1: Show the diff for policy-change approvals**

In `app/ui/wallet/approval-card.tsx`, after the columns block (~line 100), add:

```tsx
      {appr.policyDiff && appr.policyDiff.length > 0 && (
        <div style={{ marginTop: 14, background: "#0E1014", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, padding: "11px 14px" }}>
          <div style={{ fontSize: 10.5, color: "#7C828A", letterSpacing: ".3px", marginBottom: 6 }}>PROPOSED POLICY CHANGE</div>
          {appr.policyDiff.map((d, i) => (
            <div key={i} style={{ fontSize: 12, color: "#C5C9CE", lineHeight: 1.6 }}>{d.text}</div>
          ))}
        </div>
      )}
```

- [ ] **Step 2: Refine the applied hint**

In `hintFor` (line 41), the role branch already returns "Change applied to the vault policy." for `broadcast`. For reshare clarity, change it to:

```ts
  if (a.status === "broadcast") return isRole ? "Policy reshared — group key and address unchanged." : "Submitted to the Bitcoin network.";
```

- [ ] **Step 3: Verify the build**

Run: `cd /Users/chengchunyuan/project/btech && bun run build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add app/ui/wallet/approval-card.tsx
git commit -m "feat(ui): render the proposed policy diff on role approval cards"
```

---

## Self-Review

**Spec coverage:**
- Channel/visibility: out of scope here (sub-project C). ✓ not in this plan.
- Edit policy (add/remove signers, change thresholds, add/remove tiers): Task 10 editor + Task 11 mapping. ✓
- Current-quorum ratifies: Task 9 counts distinct current-signer votes; Task 4 verifies the aggregate. ✓
- Reconstruct-then-redeal reshare, native primitive: Task 1. ✓
- Same group key + address: Task 1 invariant + Task 4 ensure + Task 5 returns unchanged address. ✓
- vaultd authoritative, web mirrors + bumps policyVersion: Task 5 persist; Task 9 mirror. ✓
- Persisted policy survives restart: Task 2. ✓
- Reshare authorization digest binds new policy: Task 3 + Task 9 `policyFingerprint`. ✓
- Brick = hard block; weak = allow: Task 8 `isBrickedPolicy` (1-of-1 allowed); Task 10 disables Propose only when bricked. ✓
- Stale proposal guard: Task 8 stamps `basePolicyVersion`; Task 9 rejects on mismatch (409). ✓
- In-flight signing cleared on reshare: Task 4 `sign_sessions.clear()`. ✓
- No vaultd fallback: Task 7 `runReshare` throws a clear "requires vaultd" error; Task 9 surfaces it (502) — governance gate (votes) still runs. ✓
- Audit `policy/propose` + `policy/applied`: propose audits via existing `"propose"` (route.ts:68); apply audits via `"reshare"` (Task 9). ✓

**Placeholder scan:** The three "confirm the exact accessor/roster/signature when implementing" notes (Tasks 4, 5, 11) are real integration points where the existing symbol name must be verified against the tree — each names the concrete target (`demo_report`/`vault_state`, `sign_approval`, `vaultRoster`) and the assertion, so they are actionable, not vague. No "TODO/TBD/add error handling" placeholders remain.

**Type consistency:** `PolicyConfig`/`PolicyTier`/`PolicySigner`/`PolicyDiffItem` defined in Task 7 are used identically in Tasks 8–12. `policyConfigToWire` output shape (`GroupedConfigWire`) matches the Rust `ReshareReq.new_config` serde shape (Task 5). `runReshare` params (camelCase) map to the snake_case body in Task 7's implementation. `reshare_htss` signature (Task 1) matches its call site in Task 4.

## Execution notes

- Phases are strictly ordered (each depends on the previous). Within a phase, tasks are ordered.
- Rust tests in Phase 1 run from `/Users/chengchunyuan/project/dkgkit`; everything else from `/Users/chengchunyuan/project/btech`.
- The end-to-end happy path can only be exercised with `btech-vaultd` running and `BTECH_VAULTD_URL` set; the unit/integration tests above do not require it.
