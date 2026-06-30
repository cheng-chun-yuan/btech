use serde::{Deserialize, Serialize};

use dkgkit_sdk::bitcoin::{
    finalize_taproot_keyspend, taproot_keyspend_sighashes, TaprootSpendInput, TaprootSpendOutput,
};
use dkgkit_sdk::ParticipantId;

pub use dkgkit_sdk::HtssNoncePackage;

use crate::domain::approval::ApprovalRequest;
use crate::domain::policy::{
    demo_invalid_signer_set, demo_valid_signer_set, grouped_config_123_of_235,
};
use crate::domain::session::{run_session_proof, SessionProofReport};
use crate::domain::vault::VaultService;
use crate::storage::InMemoryRepository;

pub struct WalletApp {
    vault: VaultService,
    repository: InMemoryRepository,
    ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DemoReport {
    pub vault_id: String,
    pub network: String,
    pub group_xonly_public_key: String,
    pub receive_path: String,
    pub receive_address: String,
    pub signers: Vec<u16>,
    pub authorization_digest: String,
    pub aggregate_signature: String,
    pub verified: bool,
    pub remaining_relay_events: usize,
}

/// One vault UTXO to spend, as supplied over the settlement boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettlementInput {
    pub txid: String,
    pub vout: u32,
    #[serde(rename = "valueSats")]
    pub value_sats: u64,
}

/// A request to settle a real Taproot spend out of the vault's receive address.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettlementRequest {
    pub recipient: String,
    #[serde(rename = "amountSats")]
    pub amount_sats: u64,
    #[serde(rename = "feeSats")]
    pub fee_sats: u64,
    pub inputs: Vec<SettlementInput>,
}

/// The broadcastable result of a vault settlement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettlementReport {
    pub txid: String,
    pub raw_tx_hex: String,
    pub vault_address: String,
    pub recipient: String,
    pub amount_sats: u64,
    pub change_sats: u64,
    pub fee_sats: u64,
    pub signers: Vec<u16>,
}

impl WalletApp {
    fn demo_vault() -> anyhow::Result<VaultService> {
        Ok(VaultService::new(
            "btech-treasury-demo",
            "btech-treasury-demo-dkg",
            "regtest",
            [42u8; 32],
            grouped_config_123_of_235()?,
        )?)
    }

    pub fn demo() -> anyhow::Result<Self> {
        Ok(Self {
            vault: Self::demo_vault()?,
            repository: InMemoryRepository::default(),
            ready: false,
        })
    }

    /// Rebuild a finalized vault from persisted key material, skipping DKG. The
    /// transport is connected so signing rounds run, but the group key and shares
    /// are the loaded ones, so receive addresses match the saved vault.
    pub fn load(material: crate::domain::vault::VaultKeyMaterial) -> anyhow::Result<Self> {
        let mut vault = Self::demo_vault()?;
        vault.connect_transport()?;
        vault.import_key_material(material);
        Ok(Self {
            vault,
            repository: InMemoryRepository::default(),
            ready: true,
        })
    }

    /// Finalized key material for persistence, or `None` before DKG completes.
    pub fn export_vault(&self) -> Option<crate::domain::vault::VaultKeyMaterial> {
        self.vault.export_key_material()
    }

    /// Connect transport and run DKG once. Idempotent: a long-lived service runs
    /// the ceremony on the first call and reuses the finalized vault thereafter.
    pub fn init(&mut self) -> anyhow::Result<()> {
        if self.ready {
            return Ok(());
        }
        self.vault.connect_transport()?;
        self.vault.run_htss_dkg()?;
        anyhow::ensure!(
            self.vault.local_share_count() == self.vault.participant_count(),
            "not every participant produced a local share"
        );
        self.ready = true;
        Ok(())
    }

    pub fn run_demo(&mut self) -> anyhow::Result<DemoReport> {
        self.init()?;

        let address = self.vault.derive_receive_address(0, 0, 0)?;
        let approval = ApprovalRequest::payment(
            "approval-001",
            self.vault.network.clone(),
            address.address.clone(),
            100_000,
            "btech local DKGKit approval",
        );
        self.repository.save_approval(approval.clone());

        let invalid_signers = demo_invalid_signer_set()?;
        anyhow::ensure!(
            self.vault
                .sign_approval("invalid-signing-attempt", &approval, invalid_signers)
                .is_err(),
            "invalid signer set unexpectedly signed"
        );

        let signer_set = demo_valid_signer_set()?;
        let signing = self
            .vault
            .sign_approval("approval-001-signing", &approval, signer_set)?;

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

    /// Sign a caller-supplied payment authorization (real recipient + amount),
    /// binding the aggregate signature to the actual approval rather than a fixed
    /// demo digest. Runs DKG, derives the receive address, and signs with a valid
    /// grouped signer set.
    pub fn sign_payment(
        &mut self,
        nonce: impl Into<String>,
        recipient: impl Into<String>,
        amount_sats: u64,
        memo: impl Into<String>,
    ) -> anyhow::Result<DemoReport> {
        self.init()?;

        let address = self.vault.derive_receive_address(0, 0, 0)?;
        let approval = ApprovalRequest::payment(
            nonce,
            self.vault.network.clone(),
            recipient,
            amount_sats,
            memo,
        );
        self.repository.save_approval(approval.clone());

        let signer_set = demo_valid_signer_set()?;
        let signing = self
            .vault
            .sign_approval("payment-signing", &approval, signer_set)?;

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

    /// Vault info without running a signing round (DKG is run once via init).
    pub fn vault_state(&mut self) -> anyhow::Result<serde_json::Value> {
        self.init()?;
        let address = self.vault.derive_receive_address(0, 0, 0)?;
        Ok(serde_json::json!({
            "vault_id": self.vault.vault_id,
            "network": self.vault.network,
            "group_xonly_public_key": self.vault.group_xonly_public_key_hex()?,
            "receive_address": address.address,
            "receive_path": address.path.display_path(),
        }))
    }

    /// Settle a real on-chain Taproot spend out of the vault: build the key-path
    /// transaction, run a grouped HTSS round per input signing the BIP341 sighash
    /// under the receive address' tweaked output key, and return the signed raw
    /// transaction (the caller broadcasts it). Change returns to the vault.
    pub fn settle_taproot_spend(
        &mut self,
        request: SettlementRequest,
    ) -> anyhow::Result<SettlementReport> {
        self.init()?;
        anyhow::ensure!(
            !request.inputs.is_empty(),
            "settlement needs at least one input UTXO"
        );

        let vault_address = self.vault.derive_receive_address(0, 0, 0)?.address;
        let tweak = self.vault.receive_key_tweak(0, 0, 0)?;
        let network = self.vault.network.clone();

        let total_in: u64 = request.inputs.iter().map(|input| input.value_sats).sum();
        let spend = request
            .amount_sats
            .checked_add(request.fee_sats)
            .ok_or_else(|| anyhow::anyhow!("amount + fee overflow"))?;
        anyhow::ensure!(
            total_in >= spend,
            "inputs ({total_in} sats) do not cover amount + fee ({spend} sats)"
        );
        let change_sats = total_in - spend;

        let inputs: Vec<TaprootSpendInput> = request
            .inputs
            .iter()
            .map(|input| TaprootSpendInput {
                txid: input.txid.clone(),
                vout: input.vout,
                value_sats: input.value_sats,
            })
            .collect();
        let mut outputs = vec![TaprootSpendOutput {
            address: request.recipient.clone(),
            value_sats: request.amount_sats,
        }];
        if change_sats > 0 {
            outputs.push(TaprootSpendOutput {
                address: vault_address.clone(),
                value_sats: change_sats,
            });
        }

        let (unsigned_tx_hex, sighashes) =
            taproot_keyspend_sighashes(&network, &vault_address, &inputs, &outputs)?;

        let signer_set = demo_valid_signer_set()?;
        let signers: Vec<u16> = signer_set.iter().map(|participant| participant.0).collect();
        let mut signatures = Vec::with_capacity(sighashes.len());
        for (index, sighash) in sighashes.iter().enumerate() {
            let signature = self.vault.sign_taproot_keyspend_sighash(
                format!("taproot-spend-input-{index}"),
                *sighash,
                tweak.output_xonly,
                tweak.tweak,
                tweak.negate_key,
                signer_set.clone(),
            )?;
            signatures.push(signature);
        }

        let (raw_tx_hex, txid) = finalize_taproot_keyspend(&unsigned_tx_hex, &signatures)?;
        Ok(SettlementReport {
            txid,
            raw_tx_hex,
            vault_address,
            recipient: request.recipient,
            amount_sats: request.amount_sats,
            change_sats,
            fee_sats: request.fee_sats,
            signers,
        })
    }

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

    /// Reshare the vault to a new grouped policy, authorized by `ratifier_set`
    /// (participant ids valid under the CURRENT policy). Returns the unchanged
    /// group key + address plus the ratifier authorization proof. `binding_id` is
    /// the approval id, not a cryptographic nonce.
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

    pub fn repository(&self) -> &InMemoryRepository {
        &self.repository
    }

    pub fn run_session_proof(session_id: impl Into<String>) -> anyhow::Result<SessionProofReport> {
        run_session_proof(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_flow_runs_end_to_end() {
        let mut app = WalletApp::demo().unwrap();
        let report = app.run_demo().unwrap();

        assert!(report.verified);
        assert_eq!(report.network, "regtest");
        assert_eq!(report.receive_path, "m/86'/0'/0'/0/0");
        assert_eq!(report.signers, vec![1, 3, 4, 6, 7, 8]);
        assert_eq!(report.authorization_digest.len(), 64);
        assert_eq!(report.aggregate_signature.len(), 128);
        assert_eq!(report.remaining_relay_events, 0);
        assert_eq!(app.repository().approval_count(), 1);
    }

    #[test]
    fn settle_taproot_spend_builds_a_verified_keypath_transaction() {
        let mut app = WalletApp::demo().unwrap();
        app.init().unwrap();
        let vault_address = app.vault.derive_receive_address(0, 0, 0).unwrap().address;

        let request = SettlementRequest {
            recipient: vault_address.clone(),
            amount_sats: 100_000_000,
            fee_sats: 10_000,
            inputs: vec![SettlementInput {
                txid: "ab".repeat(32),
                vout: 0,
                value_sats: 50_000_000_000,
            }],
        };
        // settle_taproot_spend signs each input's BIP341 sighash under the receive
        // address' tweaked output key; aggregation verifies the signature before
        // returning, so a successful call already proves the witness is valid.
        let report = app.settle_taproot_spend(request).unwrap();

        assert_eq!(report.change_sats, 50_000_000_000 - 100_000_000 - 10_000);
        assert_eq!(report.signers.len(), 6);
        assert!(report.txid.len() == 64);
        assert!(!report.raw_tx_hex.is_empty());
        assert_eq!(report.vault_address, vault_address);
    }

    #[test]
    fn collapsed_two_round_precommit_then_finalize_verifies() {
        let mut app = WalletApp::demo().unwrap();
        app.init().unwrap();
        let set: Vec<u16> = vec![1, 3, 4, 6, 7, 8];
        for pid in &set {
            app.htss_precommit("tx-collapsed-1", *pid).unwrap();
        }
        // Idempotency: re-calling precommit for the same (session, participant)
        // must return the already-published package, not a fresh nonce.
        let first = app.htss_precommit("tx-collapsed-1", 1).unwrap();
        let second = app.htss_precommit("tx-collapsed-1", 1).unwrap();
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&second).unwrap(),
            "htss_precommit must be idempotent: second call returned a different package"
        );
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

    #[test]
    fn reshare_adds_a_signer_keeps_address_and_verifies() {
        let mut app = WalletApp::demo().unwrap();
        app.init().unwrap();

        // Capture the group key + receive address from the REAL vault accessors
        // (the same ones DemoReport / vault_state surface) before resharing.
        let group_before = app.vault.group_xonly_public_key_hex().unwrap();
        let addr_before = app.vault.derive_receive_address(0, 0, 0).unwrap().address;

        // New policy: the seed 1-2-3-of-2-3-5 plus a 6th operator (id 11) at rank 2,
        // operator group requirement bumped from 3-of-5 to 3-of-6.
        let new_grouped = crate::domain::policy::grouped_config_add_operator().unwrap();
        let ratifiers: Vec<u16> = vec![1, 3, 4, 6, 7, 8]; // valid under the CURRENT policy

        let report = app
            .reshare("reshare-1", new_grouped, ratifiers.clone(), "fp-new-policy")
            .unwrap();

        assert!(report.verified, "ratifier aggregate must verify");
        assert_eq!(
            report.group_xonly_public_key, group_before,
            "group key must be fixed across reshare"
        );
        assert_eq!(
            report.receive_address, addr_before,
            "receive address must be fixed across reshare"
        );
        assert_eq!(
            report.signers, ratifiers,
            "the authorization was signed by the current-policy ratifier quorum"
        );

        // The vault now signs a payment with a quorum that INCLUDES the new
        // operator (id 11), valid only under the NEW 3-of-6 operator policy, and
        // the aggregate must verify under the unchanged group key.
        let pay_set: Vec<u16> = vec![1, 3, 4, 6, 7, 11];
        for pid in &pay_set {
            app.htss_precommit("pay-after-reshare", *pid).unwrap();
        }
        let pay = app
            .htss_finalize(
                "pay-after-reshare",
                "pay-after-reshare",
                "bcrt1qexample",
                100_000,
                "memo",
                pay_set.clone(),
            )
            .unwrap();
        assert!(
            pay.verified,
            "post-reshare quorum including the new operator must sign and verify"
        );
        assert_eq!(pay.signers, pay_set);
        // The post-reshare payment is over the SAME unchanged group key + address.
        assert_eq!(pay.group_xonly_public_key, group_before);
        assert_eq!(pay.receive_address, addr_before);
    }

    #[test]
    fn session_proof_runs_tss_and_htss_end_to_end() {
        let report = WalletApp::run_session_proof("test-session").unwrap();

        assert!(!report.all_invites_joined);
        assert_eq!(report.invites.len(), 10);
        assert_eq!(report.vault_policy_groups.len(), 3);
        assert_eq!(report.vault_policy_groups[0].required, 1);
        assert_eq!(report.vault_policy_groups[1].required, 2);
        assert_eq!(report.vault_policy_groups[2].required, 3);
        assert_eq!(report.tss.scheme, "TSS/FROST");
        assert_eq!(report.tss.threshold, "2-of-3");
        assert_eq!(report.tss.signer_set, vec![1, 2]);
        assert!(report.tss.verified);
        assert_eq!(report.htss.scheme, "HTSS grouped threshold");
        assert_eq!(report.htss.threshold, "(1,2,3)-of-(2,3,5)");
        assert_eq!(report.htss.signer_set, vec![1, 3, 4, 6, 7, 8]);
        assert!(report.htss.verified);
        assert!(report.invalid_htss_signer_set_rejected);
        assert!(report.high_rank_cannot_substitute_low_group);
        assert!(report.tss_boundary.contains("not merged into HTSS"));
        assert!(report.receive_address.starts_with("bcrt1"));
    }
}
