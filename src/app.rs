use serde::{Deserialize, Serialize};

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

impl WalletApp {
    pub fn demo() -> anyhow::Result<Self> {
        let vault = VaultService::new(
            "btech-treasury-demo",
            "btech-treasury-demo-dkg",
            "regtest",
            [42u8; 32],
            grouped_config_123_of_235()?,
        )?;
        Ok(Self {
            vault,
            repository: InMemoryRepository::default(),
            ready: false,
        })
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
