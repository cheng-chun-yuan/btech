use dkgkit_nostr::LocalNostrEventTransport;
use dkgkit_sdk::bitcoin::{
    taproot_child_address_descriptor_for_network, taproot_child_key_tweak,
    verify_aggregate_signature_digest, BitcoinAccountKey, BitcoinAddressDescriptor,
    BitcoinDerivationPath, TaprootKeyTweak,
};
use dkgkit_sdk::{
    aggregate_htss_signature_shares, aggregate_htss_signature_shares_for_output,
    hierarchical_config_from_grouped_threshold, htss_nonce, htss_sign_share,
    htss_sign_share_for_output, validate_grouped_threshold_signer_set, DkgKitError,
    FrostCoordinator, GroupKey, GroupedThresholdConfig, HtssDkgRound1State, HtssDkgService,
    HtssLocalKeyShare, HtssLocalNonce, HtssNoncePackage, ParticipantId, Result, SessionId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::domain::approval::ApprovalRequest;

/// Finalized vault key material, enough to sign without re-running DKG. Persisted
/// by long-lived services so a restart keeps the same group key (and addresses).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultKeyMaterial {
    pub group_key: GroupKey,
    pub shares: Vec<HtssLocalKeyShare>,
    /// The grouped policy these shares were dealt for. Persisted so a reshared
    /// vault keeps its NEW policy across restarts (not the seed config).
    #[serde(default = "crate::domain::policy::grouped_config_123_of_235_or_panic")]
    pub grouped_config: GroupedThresholdConfig,
}

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
    /// Per-signing-session secret local nonces collected during the
    /// pre-commit round (round 1), keyed by signing session id then participant.
    /// Consumed and dropped by `htss_finalize` so a nonce is never reused.
    sign_sessions: BTreeMap<String, BTreeMap<ParticipantId, HtssLocalNonce>>,
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
            sign_sessions: BTreeMap::new(),
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

    /// The additive key tweak between the group key and the BIP86 `account/change/index`
    /// receive output key, so the vault can sign a real key-path spend of that address.
    pub fn receive_key_tweak(
        &self,
        account: u32,
        change: u32,
        address_index: u32,
    ) -> anyhow::Result<TaprootKeyTweak> {
        let group_key = self
            .group_key
            .clone()
            .ok_or_else(|| anyhow::anyhow!("vault DKG is not finalized"))?;
        let account_key = BitcoinAccountKey::new(group_key, self.chain_code);
        let path = BitcoinDerivationPath::bip86(account, change, address_index);
        Ok(taproot_child_key_tweak(&account_key, &self.network, path)?)
    }

    /// Export the finalized key material (group key + local shares) for persistence.
    /// Returns `None` until DKG has finalized.
    pub fn export_key_material(&self) -> Option<VaultKeyMaterial> {
        let group_key = self.group_key.clone()?;
        Some(VaultKeyMaterial {
            group_key,
            shares: self.local_shares.values().cloned().collect(),
            grouped_config: self.grouped_config.clone(),
        })
    }

    /// Restore finalized key material, skipping DKG. Subsequent signing reuses the
    /// loaded group key and shares, so the receive addresses are unchanged.
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
            if let Ok(dkg) = HtssDkgService::new(self.dkg.session_id.0.clone(), htss) {
                self.dkg = dkg;
            }
        }
        self.grouped_config = material.grouped_config;
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
        // `local_nonces` borrows self.sign_sessions; the loop clones every value
        // into `selected` so the borrow ends when the loop exits (NLL).
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
        // Consume the session immediately — `selected` now owns all needed nonce
        // material, so the map entry is dead. Removing here (before any fallible
        // I/O) ensures the session is dropped even if signing later errors out.
        self.sign_sessions.remove(signing_session_id);

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
        anyhow::ensure!(verified, "aggregate signature failed Bitcoin verification");

        Ok(SigningResult {
            signature_hex: hex::encode(aggregate.signature_bytes),
            digest_hex: hex::encode(digest),
            signer_ids: signer_set.iter().map(|id| id.0).collect(),
            verified,
        })
    }

    /// Sign a Taproot key-path spend sighash with the vault's BIP86 receive key.
    ///
    /// The receive address is a BIP86 child of the group key, so the witness
    /// signature must verify under the tweaked output key rather than the group
    /// key. Callers pass the per-address `output_xonly` / `tweak` / `negate_key`
    /// from `taproot_child_key_tweak`; the grouped HTSS round runs exactly as for
    /// an approval, but the challenge commits to the output key and the aggregate
    /// is tweak-adjusted. Returns the 64-byte BIP340 aggregate signature.
    pub fn sign_taproot_keyspend_sighash(
        &mut self,
        signing_session_id: impl Into<String>,
        sighash: [u8; 32],
        output_xonly: [u8; 32],
        tweak: [u8; 32],
        negate_key: bool,
        signer_set: Vec<ParticipantId>,
    ) -> anyhow::Result<[u8; 64]> {
        validate_grouped_threshold_signer_set(&signer_set, &self.grouped_config)?;
        let group_key = self
            .group_key
            .clone()
            .ok_or_else(|| anyhow::anyhow!("vault DKG is not finalized"))?;
        let signing_session_id = SessionId::new(signing_session_id)?;

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
            let signature_share = htss_sign_share_for_output(
                &group_key,
                sighash,
                output_xonly,
                negate_key,
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
        let aggregate = aggregate_htss_signature_shares_for_output(
            sighash,
            output_xonly,
            tweak,
            &public_nonces,
            &signature_shares,
            &signer_set,
            &self.dkg.config,
        )?;
        let signature: [u8; 64] = aggregate
            .signature_bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("aggregate signature must be 64 bytes"))?;
        Ok(signature)
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
