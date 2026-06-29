use dkgkit_nostr::LocalNostrEventTransport;
use dkgkit_sdk::bitcoin::{
    taproot_child_address_descriptor_for_network, verify_aggregate_signature_digest,
    BitcoinAccountKey, BitcoinAddressDescriptor, BitcoinDerivationPath,
};
use dkgkit_sdk::{
    aggregate_htss_signature_shares, hierarchical_config_from_grouped_threshold, htss_nonce,
    htss_sign_share, validate_grouped_threshold_signer_set, DkgKitError, FrostCoordinator,
    GroupKey, GroupedThresholdConfig, HtssDkgRound1State, HtssDkgService, HtssLocalKeyShare,
    ParticipantId, Result, SessionId,
};
use std::collections::BTreeMap;

use crate::domain::approval::ApprovalRequest;

pub struct VaultService {
    pub vault_id: String,
    pub network: String,
    pub chain_code: [u8; 32],
    pub grouped_config: GroupedThresholdConfig,
    pub dkg: HtssDkgService,
    coordinator: FrostCoordinator<LocalNostrEventTransport>,
    round1_states: BTreeMap<ParticipantId, HtssDkgRound1State>,
    local_shares: BTreeMap<ParticipantId, HtssLocalKeyShare>,
    group_key: Option<GroupKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigningResult {
    pub signature_hex: String,
    pub digest_hex: String,
    pub signer_ids: Vec<u16>,
    pub verified: bool,
}

impl VaultService {
    pub fn new(
        vault_id: impl Into<String>,
        dkg_session_id: impl Into<String>,
        network: impl Into<String>,
        chain_code: [u8; 32],
        grouped_config: GroupedThresholdConfig,
    ) -> Result<Self> {
        let htss_config = hierarchical_config_from_grouped_threshold(&grouped_config)?;
        Ok(Self {
            vault_id: vault_id.into(),
            network: network.into(),
            chain_code,
            grouped_config,
            dkg: HtssDkgService::new(dkg_session_id, htss_config)?,
            coordinator: FrostCoordinator::new(LocalNostrEventTransport::default()),
            round1_states: BTreeMap::new(),
            local_shares: BTreeMap::new(),
            group_key: None,
        })
    }

    pub fn connect_transport(&mut self) -> Result<()> {
        self.coordinator.connect()
    }

    pub fn run_htss_dkg(&mut self) -> Result<()> {
        // Idempotent: a finalized vault keeps its shares so signing can reuse the
        // same DKG (run once, sign many) when the service is long-lived.
        if self.group_key.is_some() {
            return Ok(());
        }
        for participant in &self.dkg.config.participants {
            let state = self.dkg.begin_round1(participant.id)?;
            self.coordinator
                .publish_htss_dkg_round1(self.dkg.session_id.clone(), &state.package)?;
            self.round1_states.insert(participant.id, state);
        }

        let round1_packages = self
            .coordinator
            .drain_htss_dkg_round1(&self.dkg.session_id)?;

        for state in self.round1_states.values() {
            for package in self.dkg.create_round2_packages(state, &round1_packages)? {
                self.coordinator
                    .publish_htss_dkg_round2(self.dkg.session_id.clone(), &package)?;
            }
        }

        for participant in &self.dkg.config.participants {
            let round2_for_participant = self
                .coordinator
                .drain_htss_dkg_round2_for(&self.dkg.session_id, participant.id)?;
            let (group_key, local_share) = self.dkg.finalize_participant(
                participant.id,
                &round1_packages,
                &round2_for_participant,
            )?;
            match &self.group_key {
                Some(existing) if existing.xonly_public_key != group_key.xonly_public_key => {
                    return Err(DkgKitError::Protocol(
                        "participants derived different group keys".to_string(),
                    ));
                }
                None => self.group_key = Some(group_key),
                _ => {}
            }
            self.local_shares.insert(participant.id, local_share);
        }

        Ok(())
    }

    pub fn derive_receive_address(
        &self,
        account: u32,
        change: u32,
        address_index: u32,
    ) -> anyhow::Result<BitcoinAddressDescriptor> {
        let group_key = self
            .group_key
            .clone()
            .ok_or_else(|| anyhow::anyhow!("vault DKG is not finalized"))?;
        let account_key = BitcoinAccountKey::new(group_key, self.chain_code);
        let path = BitcoinDerivationPath::bip86(account, change, address_index);
        taproot_child_address_descriptor_for_network(&account_key, &self.network, path)
    }

    pub fn sign_approval(
        &mut self,
        signing_session_id: impl Into<String>,
        approval: &ApprovalRequest,
        signer_set: Vec<ParticipantId>,
    ) -> anyhow::Result<SigningResult> {
        validate_grouped_threshold_signer_set(&signer_set, &self.grouped_config)?;
        let group_key = self
            .group_key
            .clone()
            .ok_or_else(|| anyhow::anyhow!("vault DKG is not finalized"))?;
        let signing_session_id = SessionId::new(signing_session_id)?;
        let digest = approval.digest();

        let selected_shares = signer_set
            .iter()
            .map(|participant_id| {
                self.local_shares
                    .get(participant_id)
                    .cloned()
                    .ok_or_else(|| {
                        anyhow::anyhow!("missing local share for signer {}", participant_id.0)
                    })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        let local_nonces = selected_shares
            .iter()
            .map(|share| htss_nonce(signing_session_id.clone(), share))
            .collect::<Result<Vec<_>>>()?;
        for nonce in &local_nonces {
            self.coordinator.publish_htss_nonce(&nonce.package)?;
        }
        let public_nonces = self.coordinator.drain_htss_nonces(&signing_session_id)?;

        for (share, nonce) in selected_shares.iter().zip(local_nonces.iter()) {
            let signature_share = htss_sign_share(
                &group_key,
                digest,
                share,
                nonce,
                &public_nonces,
                &signer_set,
                &self.dkg.config,
            )?;
            self.coordinator
                .publish_htss_signature_share(&signature_share)?;
        }

        let signature_shares = self
            .coordinator
            .drain_htss_signature_shares(&signing_session_id)?;
        let aggregate = aggregate_htss_signature_shares(
            &group_key,
            digest,
            &public_nonces,
            &signature_shares,
            &signer_set,
            &self.dkg.config,
        )?;
        let verified = verify_aggregate_signature_digest(&group_key, &digest, &aggregate)?;
        anyhow::ensure!(verified, "aggregate signature failed Bitcoin verification");

        Ok(SigningResult {
            signature_hex: hex::encode(aggregate.signature_bytes),
            digest_hex: hex::encode(digest),
            signer_ids: signer_set.iter().map(|id| id.0).collect(),
            verified,
        })
    }

    pub fn group_xonly_public_key_hex(&self) -> anyhow::Result<String> {
        let group_key = self
            .group_key
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("vault DKG is not finalized"))?;
        Ok(hex::encode(group_key.xonly_public_key))
    }

    pub fn participant_count(&self) -> usize {
        self.dkg.config.participants.len()
    }

    pub fn local_share_count(&self) -> usize {
        self.local_shares.len()
    }

    pub fn remaining_relay_events(&self) -> usize {
        self.coordinator.transport().pending_len()
    }
}
