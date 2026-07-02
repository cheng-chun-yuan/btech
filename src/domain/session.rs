use dkgkit_sdk::bitcoin::{sha256, verify_aggregate_signature_digest, BitcoinAuthorizationMessage};
use dkgkit_sdk::{run_local_frost_dkg, sign_digest_with_shares, ParticipantId, ThresholdConfig};
use serde::{Deserialize, Serialize};

use crate::domain::approval::ApprovalRequest;
use crate::domain::policy::{
    demo_invalid_signer_set, demo_valid_signer_set, grouped_config_123_of_235, participant_id,
};
use crate::domain::vault::VaultService;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvitedParticipant {
    pub participant_id: u16,
    pub label: String,
    pub role: String,
    pub status: InviteStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultPolicyGroup {
    pub group_id: String,
    pub chat_name: String,
    pub rank: u16,
    pub required: u16,
    pub total: u16,
    pub participant_ids: Vec<u16>,
    pub joined_ids: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum InviteStatus {
    Invited,
    Joined,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignatureProof {
    pub scheme: String,
    pub threshold: String,
    pub group_xonly_public_key: String,
    pub signer_set: Vec<u16>,
    pub digest: String,
    pub aggregate_signature: String,
    pub verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionProofReport {
    pub session_id: String,
    pub invites: Vec<InvitedParticipant>,
    pub vault_policy_groups: Vec<VaultPolicyGroup>,
    pub all_invites_joined: bool,
    pub tss_boundary: String,
    pub tss: SignatureProof,
    pub htss: SignatureProof,
    pub invalid_htss_signer_set_rejected: bool,
    pub high_rank_can_substitute_low_group: bool,
    pub receive_address: String,
}

pub fn run_session_proof(session_id: impl Into<String>) -> anyhow::Result<SessionProofReport> {
    let session_id = session_id.into();
    let invites = demo_invites();
    let vault_policy_groups = demo_policy_groups();
    let all_invites_joined = invites
        .iter()
        .all(|invite| invite.status == InviteStatus::Joined);

    let tss = run_tss_proof(&session_id)?;
    let (
        htss,
        invalid_htss_signer_set_rejected,
        high_rank_can_substitute_low_group,
        receive_address,
    ) = run_htss_proof(&session_id)?;

    Ok(SessionProofReport {
        session_id,
        invites,
        vault_policy_groups,
        all_invites_joined,
        tss_boundary: "Base TSS/FROST is proven separately. It is not merged into HTSS and cannot satisfy an HTSS rank-specific group quorum.".to_string(),
        tss,
        htss,
        invalid_htss_signer_set_rejected,
        high_rank_can_substitute_low_group,
        receive_address,
    })
}

fn demo_invites() -> Vec<InvitedParticipant> {
    vec![
        InvitedParticipant {
            participant_id: 1,
            label: "Alice".to_string(),
            role: "Founder".to_string(),
            status: InviteStatus::Joined,
        },
        InvitedParticipant {
            participant_id: 2,
            label: "Bob".to_string(),
            role: "Security".to_string(),
            status: InviteStatus::Joined,
        },
        InvitedParticipant {
            participant_id: 3,
            label: "Carol".to_string(),
            role: "Finance".to_string(),
            status: InviteStatus::Joined,
        },
        InvitedParticipant {
            participant_id: 4,
            label: "Dina".to_string(),
            role: "Manager".to_string(),
            status: InviteStatus::Joined,
        },
        InvitedParticipant {
            participant_id: 5,
            label: "Evan".to_string(),
            role: "Manager".to_string(),
            status: InviteStatus::Invited,
        },
        InvitedParticipant {
            participant_id: 6,
            label: "Faye".to_string(),
            role: "Operator".to_string(),
            status: InviteStatus::Joined,
        },
        InvitedParticipant {
            participant_id: 7,
            label: "Gus".to_string(),
            role: "Operator".to_string(),
            status: InviteStatus::Joined,
        },
        InvitedParticipant {
            participant_id: 8,
            label: "Hana".to_string(),
            role: "Operator".to_string(),
            status: InviteStatus::Joined,
        },
        InvitedParticipant {
            participant_id: 9,
            label: "Iris".to_string(),
            role: "Operator".to_string(),
            status: InviteStatus::Invited,
        },
        InvitedParticipant {
            participant_id: 10,
            label: "Jules".to_string(),
            role: "Operator".to_string(),
            status: InviteStatus::Invited,
        },
    ]
}

fn demo_policy_groups() -> Vec<VaultPolicyGroup> {
    vec![
        VaultPolicyGroup {
            group_id: "c-level".to_string(),
            chat_name: "C-level approvals".to_string(),
            rank: 0,
            required: 1,
            total: 2,
            participant_ids: vec![1, 2],
            joined_ids: vec![1, 2],
        },
        VaultPolicyGroup {
            group_id: "managers".to_string(),
            chat_name: "Manager review".to_string(),
            rank: 1,
            required: 2,
            total: 3,
            participant_ids: vec![3, 4, 5],
            joined_ids: vec![3, 4],
        },
        VaultPolicyGroup {
            group_id: "operators".to_string(),
            chat_name: "Operator execution".to_string(),
            rank: 2,
            required: 3,
            total: 5,
            participant_ids: vec![6, 7, 8, 9, 10],
            joined_ids: vec![6, 7, 8],
        },
    ]
}

fn run_tss_proof(session_id: &str) -> anyhow::Result<SignatureProof> {
    let threshold = ThresholdConfig::new(2, 3)?;
    let shares = run_local_frost_dkg(format!("{session_id}-tss-dkg"), 2, 3)?;
    let group_key = shares
        .first()
        .ok_or_else(|| anyhow::anyhow!("TSS DKG produced no shares"))?
        .group_key
        .clone();
    let signer_set = vec![participant_id(1)?, participant_id(2)?];
    let digest = sha256(format!("BTech proof session {session_id}: base TSS approval").as_bytes());
    let aggregate = sign_digest_with_shares(
        format!("{session_id}-tss-signing"),
        threshold,
        group_key.clone(),
        digest,
        &shares,
        signer_set.clone(),
    )?;
    let verified = verify_aggregate_signature_digest(&group_key, &digest, &aggregate)?;

    Ok(SignatureProof {
        scheme: "TSS/FROST".to_string(),
        threshold: "2-of-3".to_string(),
        group_xonly_public_key: hex::encode(group_key.xonly_public_key),
        signer_set: signer_ids(&signer_set),
        digest: hex::encode(digest),
        aggregate_signature: hex::encode(aggregate.signature_bytes),
        verified,
    })
}

fn run_htss_proof(session_id: &str) -> anyhow::Result<(SignatureProof, bool, bool, String)> {
    let mut vault = VaultService::new(
        format!("{session_id}-htss-vault"),
        format!("{session_id}-htss-dkg"),
        "regtest",
        [42u8; 32],
        grouped_config_123_of_235()?,
    )?;
    vault.connect_transport()?;
    vault.run_htss_dkg()?;

    let address = vault.derive_receive_address(0, 0, 0)?;
    let approval = ApprovalRequest {
        id: format!("{session_id}-htss-approval"),
        message: BitcoinAuthorizationMessage {
            network: "regtest".to_string(),
            action: "approve-session-proof".to_string(),
            recipient: Some(address.address.clone()),
            amount_sats: Some(100_000),
            memo: Some("BTech grouped HTSS proof".to_string()),
            nonce: session_id.to_string(),
        },
    };

    let invalid_htss_signer_set_rejected = vault
        .sign_approval(
            format!("{session_id}-invalid-htss-signing"),
            &approval,
            demo_invalid_signer_set()?,
        )
        .is_err();
    // Downward substitution (Tassa conjunctive semantics): 2 execs + 3 managers
    // + 1 operator meets the cumulative quotas (1, 3, 6), so the spare exec and
    // managers cover the missing operator slots and the set must sign + verify.
    let high_rank_can_substitute_low_group = vault
        .sign_approval(
            format!("{session_id}-high-rank-substitution"),
            &approval,
            vec![
                participant_id(1)?,
                participant_id(2)?,
                participant_id(3)?,
                participant_id(4)?,
                participant_id(5)?,
                participant_id(6)?,
            ],
        )
        .map(|signing| signing.verified)
        .unwrap_or(false);
    let signer_set = demo_valid_signer_set()?;
    let signing =
        vault.sign_approval(format!("{session_id}-htss-signing"), &approval, signer_set)?;

    Ok((
        SignatureProof {
            scheme: "HTSS grouped threshold".to_string(),
            threshold: "(1,2,3)-of-(2,3,5)".to_string(),
            group_xonly_public_key: vault.group_xonly_public_key_hex()?,
            signer_set: signing.signer_ids,
            digest: signing.digest_hex,
            aggregate_signature: signing.signature_hex,
            verified: signing.verified,
        },
        invalid_htss_signer_set_rejected,
        high_rank_can_substitute_low_group,
        address.address,
    ))
}

fn signer_ids(signers: &[ParticipantId]) -> Vec<u16> {
    signers.iter().map(|id| id.0).collect()
}
