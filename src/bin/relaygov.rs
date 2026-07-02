//! relaygov — relay-driven governance: bind a PROPOSAL to threshold SIGNING.
//!
//! Sub-project C, fusing A (signing over the relay) + B (the chat substrate):
//!   1. PROPOSE — a member posts a proposal (a transfer) to the group over the relay.
//!   2. PICK SIGNERS — the policy selects the required signer set by rank/role.
//!   3. RBAC — a wrong-role set is rejected ("role not accepted"); the correct
//!      quorum is accepted.
//!   4. SIGN — the quorum threshold-signs the proposal's Taproot sighash over the
//!      relay (pre-committed round → sign → aggregate), every signer verifying.
//!   5. EXECUTE — finalize the transaction (broadcast a real spend with RELAYSIGN_SPEND_*).
//!
//! Multi-rank policy (so roles matter): rank 0 "C-level" {1,2} require 1; rank 1
//! "Managers" {3,4,5} require 2. A valid quorum is 1 C-level + 2 Managers.
//!
//! Usage:
//!   DKGKIT_RELAY=ws://127.0.0.1:7777 cargo run --bin relaygov
//!   RELAYSIGN_SPEND_TXID=<txid> RELAYSIGN_SPEND_VOUT=<n> RELAYSIGN_SPEND_VALUE=<sats> \
//!     RELAYSIGN_TO=<addr> RELAYSIGN_AMOUNT=<sats> cargo run --bin relaygov

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::Context;
use dkgkit_nostr::{LiveNostrTransport, LiveNostrTransportConfig, ParticipantDirectory};
use dkgkit_sdk::bitcoin::{
    finalize_taproot_keyspend, sha256, taproot_child_address_descriptor_for_network,
    taproot_child_key_tweak, taproot_keyspend_sighashes, verify_schnorr_digest, BitcoinAccountKey,
    BitcoinDerivationPath, TaprootSpendInput, TaprootSpendOutput,
};
use dkgkit_sdk::{
    aggregate_htss_signature_shares_for_output, hierarchical_config_from_grouped_threshold,
    htss_nonce, htss_sign_share_for_output, validate_grouped_threshold_signer_set, FrostCoordinator,
    GroupKey, GroupThresholdRequirement, GroupedThresholdConfig, HierarchicalThresholdConfig,
    HtssDkgRound1Package, HtssDkgRound1State, HtssDkgRound2Package, HtssDkgService,
    HtssLocalKeyShare, HtssLocalNonce, HtssNoncePackage, HtssSignatureSharePackage, ParticipantId,
    RankedParticipant, SessionId,
};
use nostr_sdk::prelude::*;
use serde::{Deserialize, Serialize};

type Coord = FrostCoordinator<LiveNostrTransport>;

#[derive(Serialize, Deserialize)]
struct RelaygovVault {
    group_key: GroupKey,
    shares: Vec<HtssLocalKeyShare>,
}

fn secret_for(id: u16) -> [u8; 32] {
    sha256(format!("btech-signer-v1:{id}").as_bytes())
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok().and_then(|v| v.parse().ok())
}

fn role_of(rank: u16) -> &'static str {
    match rank {
        0 => "C-level",
        1 => "Manager",
        _ => "Operator",
    }
}

fn drain_round1(coord: &mut Coord, s: &SessionId, want: usize, t: Duration) -> anyhow::Result<Vec<HtssDkgRound1Package>> {
    let mut acc = Vec::new();
    let deadline = Instant::now() + t;
    while acc.len() < want && Instant::now() < deadline {
        acc.extend(coord.drain_htss_dkg_round1(s)?);
        if acc.len() < want {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    anyhow::ensure!(acc.len() >= want, "timed out draining round1 ({}/{})", acc.len(), want);
    Ok(acc)
}

fn drain_round2(coord: &mut Coord, s: &SessionId, r: ParticipantId, want: usize, t: Duration) -> anyhow::Result<Vec<HtssDkgRound2Package>> {
    let mut acc = Vec::new();
    let deadline = Instant::now() + t;
    while acc.len() < want && Instant::now() < deadline {
        acc.extend(coord.drain_htss_dkg_round2_for(s, r)?);
        if acc.len() < want {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    anyhow::ensure!(acc.len() >= want, "timed out draining round2 ({}/{})", acc.len(), want);
    Ok(acc)
}

fn drain_nonces(coord: &mut Coord, s: &SessionId, want: usize, t: Duration) -> anyhow::Result<Vec<HtssNoncePackage>> {
    let mut acc: BTreeMap<u16, HtssNoncePackage> = BTreeMap::new();
    let deadline = Instant::now() + t;
    while acc.len() < want && Instant::now() < deadline {
        for p in coord.drain_htss_nonces(s)? {
            acc.insert(p.participant_id.0, p);
        }
        if acc.len() < want {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    anyhow::ensure!(acc.len() >= want, "timed out draining nonces ({}/{})", acc.len(), want);
    Ok(acc.into_values().collect())
}

fn drain_sign_shares(coord: &mut Coord, s: &SessionId, want: usize, t: Duration) -> anyhow::Result<Vec<HtssSignatureSharePackage>> {
    let mut acc: BTreeMap<u16, HtssSignatureSharePackage> = BTreeMap::new();
    let deadline = Instant::now() + t;
    while acc.len() < want && Instant::now() < deadline {
        for p in coord.drain_htss_signature_shares(s)? {
            acc.insert(p.participant_id.0, p);
        }
        if acc.len() < want {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    anyhow::ensure!(acc.len() >= want, "timed out draining sign shares ({}/{})", acc.len(), want);
    Ok(acc.into_values().collect())
}

/// The quorum threshold-signs `sighash` for the tweaked output key over the relay:
/// each signer pre-commits a single-use nonce, signs, and every signer aggregates +
/// verifies under the output key. Returns the agreed 64-byte signature.
#[allow(clippy::too_many_arguments)]
fn sign_over_relay(
    coords: &mut [Coord],
    signer_set: &[ParticipantId],
    signer_idx: &[usize],
    shares: &BTreeMap<ParticipantId, HtssLocalKeyShare>,
    config: &HierarchicalThresholdConfig,
    group_key: &GroupKey,
    output_xonly: [u8; 32],
    tweak: [u8; 32],
    negate_key: bool,
    sighash: [u8; 32],
) -> anyhow::Result<[u8; 64]> {
    let session = SessionId::new("btech-relaygov-sign")?;
    let mut local_nonces: BTreeMap<ParticipantId, HtssLocalNonce> = BTreeMap::new();
    for (&pid, &i) in signer_set.iter().zip(signer_idx.iter()) {
        let nonce = htss_nonce(session.clone(), &shares[&pid])?;
        coords[i].publish_htss_nonce(&nonce.package)?;
        local_nonces.insert(pid, nonce);
    }
    let mut nonce_sets: BTreeMap<ParticipantId, Vec<HtssNoncePackage>> = BTreeMap::new();
    for (&pid, &i) in signer_set.iter().zip(signer_idx.iter()) {
        nonce_sets.insert(pid, drain_nonces(&mut coords[i], &session, signer_set.len(), Duration::from_secs(20))?);
    }
    for (&pid, &i) in signer_set.iter().zip(signer_idx.iter()) {
        let share = htss_sign_share_for_output(
            group_key,
            sighash,
            output_xonly,
            negate_key,
            &shares[&pid],
            &local_nonces[&pid],
            &nonce_sets[&pid],
            signer_set,
            config,
        )?;
        coords[i].publish_htss_signature_share(&share)?;
    }
    let mut sigs: BTreeMap<ParticipantId, [u8; 64]> = BTreeMap::new();
    for (&pid, &i) in signer_set.iter().zip(signer_idx.iter()) {
        let drained = drain_sign_shares(&mut coords[i], &session, signer_set.len(), Duration::from_secs(20))?;
        let aggregate = aggregate_htss_signature_shares_for_output(
            group_key, sighash, output_xonly, tweak, negate_key,
            &nonce_sets[&pid], &drained, signer_set, config,
        )?;
        let bytes: [u8; 64] = aggregate.signature_bytes.as_slice().try_into()
            .map_err(|_| anyhow::anyhow!("aggregate signature must be 64 bytes"))?;
        sigs.insert(pid, bytes);
    }
    let first = *sigs.values().next().context("no signatures")?;
    anyhow::ensure!(sigs.values().all(|s| *s == first), "peers disagreed on the signature");
    Ok(first)
}

/// Pick the required signer set by rank/role to satisfy the policy — the
/// "proposal picks the people to sign first" step.
fn pick_required_signers(grouped: &GroupedThresholdConfig) -> Vec<ParticipantId> {
    let mut picked = Vec::new();
    for req in &grouped.requirements {
        let mut count = 0;
        for p in &grouped.participants {
            if p.rank == req.rank && count < req.required {
                picked.push(p.id);
                count += 1;
            }
        }
    }
    picked
}

fn main() -> anyhow::Result<()> {
    let relay = std::env::var("DKGKIT_RELAY").unwrap_or_else(|_| "ws://127.0.0.1:7777".to_string());
    let vault_tag = format!("btech-relaygov-{}", std::process::id());

    // Multi-rank policy so roles matter: 1-of-2 C-level + 2-of-3 Managers.
    let grouped = GroupedThresholdConfig::new(
        vec![
            RankedParticipant::new(1, 0, Some("ceo".into()))?,
            RankedParticipant::new(2, 0, Some("cfo".into()))?,
            RankedParticipant::new(3, 1, Some("mgr-a".into()))?,
            RankedParticipant::new(4, 1, Some("mgr-b".into()))?,
            RankedParticipant::new(5, 1, Some("mgr-c".into()))?,
        ],
        vec![
            GroupThresholdRequirement::new(0, 1, 2)?,
            GroupThresholdRequirement::new(1, 2, 3)?,
        ],
    )?;
    let htss = hierarchical_config_from_grouped_threshold(&grouped)?;
    let dkg = HtssDkgService::new("btech-relaygov-dkg", htss)?;
    let dkg_session = dkg.session_id.clone();
    let participants: Vec<ParticipantId> = dkg.config.participants.iter().map(|p| p.id).collect();
    let rank_of: BTreeMap<u16, u16> = grouped.participants.iter().map(|p| (p.id.0, p.rank.0)).collect();
    let n = participants.len();

    let mut directory = ParticipantDirectory::new();
    let mut keys_by = Vec::new();
    for pid in &participants {
        let keys = Keys::new(SecretKey::from_slice(&secret_for(pid.0)).context("secret key")?);
        directory.insert(*pid, keys.public_key());
        keys_by.push(keys);
    }
    let mut coords: Vec<Coord> = Vec::new();
    for (i, pid) in participants.iter().enumerate() {
        let cfg = LiveNostrTransportConfig {
            relays: vec![relay.clone()],
            vault_tag: vault_tag.clone(),
            self_id: *pid,
            keys: keys_by[i].clone(),
            directory: directory.clone(),
            connect_timeout: Duration::from_secs(10),
            publish_timeout: Duration::from_secs(10),
        };
        coords.push(FrostCoordinator::new(LiveNostrTransport::new(cfg)));
    }
    for c in &mut coords {
        c.connect()?;
    }
    std::thread::sleep(Duration::from_millis(400));
    eprintln!("relaygov: {n} participants connected to {relay}");

    // Load persisted vault, or DKG over the relay and persist.
    let data_dir = PathBuf::from(std::env::var("BTECH_RELAYGOV_DATA").unwrap_or_else(|_| "data/relaygov".to_string()));
    let vault_file = data_dir.join("vault.json");
    let (group_key, shares): (GroupKey, BTreeMap<ParticipantId, HtssLocalKeyShare>) = if vault_file.exists() {
        let v: RelaygovVault = serde_json::from_slice(&std::fs::read(&vault_file)?)?;
        if v.group_key.verification_key_bytes.is_empty() {
            eprintln!(
                "relaygov: WARNING — vault predates the hardened dkgkit (no verification key \
                 material); bad signature shares cannot be attributed to a signer. Delete {} to \
                 re-run DKG.",
                vault_file.display()
            );
        }
        let shares = v.shares.into_iter().map(|s| (s.participant_id, s)).collect();
        eprintln!("relaygov: loaded persisted vault");
        (v.group_key, shares)
    } else {
        let mut states: Vec<HtssDkgRound1State> = Vec::new();
        for (i, pid) in participants.iter().enumerate() {
            let st = dkg.begin_round1(*pid)?;
            coords[i].publish_htss_dkg_round1(dkg_session.clone(), &st.package)?;
            states.push(st);
        }
        let mut round1_all: Vec<Vec<HtssDkgRound1Package>> = Vec::new();
        for c in &mut coords {
            round1_all.push(drain_round1(c, &dkg_session, n, Duration::from_secs(25))?);
        }
        for i in 0..n {
            for pkg in dkg.create_round2_packages(&states[i], &round1_all[i])? {
                coords[i].publish_htss_dkg_round2(dkg_session.clone(), &pkg)?;
            }
        }
        let mut shares: BTreeMap<ParticipantId, HtssLocalKeyShare> = BTreeMap::new();
        let mut gks: Vec<GroupKey> = Vec::new();
        for (i, pid) in participants.iter().enumerate() {
            let r2 = drain_round2(&mut coords[i], &dkg_session, *pid, n - 1, Duration::from_secs(25))?;
            let (gk, share) = dkg.finalize_participant(*pid, &round1_all[i], &r2)?;
            shares.insert(*pid, share);
            gks.push(gk);
        }
        let group_key = gks[0].clone();
        anyhow::ensure!(gks.iter().all(|k| k.xonly_public_key == group_key.xonly_public_key), "group key mismatch");
        std::fs::create_dir_all(&data_dir).ok();
        let v = RelaygovVault { group_key: group_key.clone(), shares: shares.values().cloned().collect() };
        std::fs::write(&vault_file, serde_json::to_vec_pretty(&v)?)?;
        eprintln!("relaygov: DKG complete over relay; vault persisted");
        (group_key, shares)
    };

    let account = BitcoinAccountKey::new(group_key.clone(), [42u8; 32]);
    let path = BitcoinDerivationPath::bip86(0, 0, 0);
    let vault_address = taproot_child_address_descriptor_for_network(&account, "regtest", path.clone())?.address;

    // ---- 1. PROPOSE (the chat substrate from B carries this to the group) ----
    let recipient = std::env::var("RELAYSIGN_TO")
        .unwrap_or_else(|_| "bcrt1pxvv7ajy96lnj2m5r26pvkjvpkxn20w94zs63nzvfjvcnehss9phqv0mwvm".to_string());
    let amount_sats = env_u64("RELAYSIGN_AMOUNT").unwrap_or(100_000_000);
    let fee_sats = env_u64("RELAYSIGN_FEE").unwrap_or(1000);
    println!("📣 PROPOSAL (posted to the vault group over the relay):");
    println!("   transfer {:.8} BTC  {vault_address}  →  {recipient}", amount_sats as f64 / 1e8);

    // ---- 2. PICK SIGNERS by rank/role ----
    let picked = pick_required_signers(&grouped);
    let describe = |set: &[ParticipantId]| -> String {
        set.iter().map(|p| format!("#{}({})", p.0, role_of(rank_of[&p.0]))).collect::<Vec<_>>().join(", ")
    };
    println!("👥 policy picked required signers: {}", describe(&picked));

    // ---- 3. RBAC: reject a wrong-role set, accept the correct quorum ----
    let rogue: Vec<ParticipantId> = vec![participants[2], participants[3], participants[4]]; // 3 Managers, no C-level
    match validate_grouped_threshold_signer_set(&rogue, &grouped) {
        Err(e) => println!("🚫 RBAC reject — set {} cannot authorize: role not accepted ({e})", describe(&rogue)),
        Ok(()) => println!("⚠ RBAC: rogue set unexpectedly accepted"),
    }
    validate_grouped_threshold_signer_set(&picked, &grouped)
        .map_err(|e| anyhow::anyhow!("picked quorum rejected: {e}"))?;
    println!("✅ RBAC accept — quorum {} satisfies the policy", describe(&picked));

    let signer_idx: Vec<usize> = picked.iter()
        .map(|s| participants.iter().position(|p| p == s).expect("signer present")).collect();

    // ---- 4. SIGN the proposal's Taproot sighash over the relay ----
    let tweak = taproot_child_key_tweak(&account, "regtest", path)?;
    let (inputs, broadcastable) = match std::env::var("RELAYSIGN_SPEND_TXID") {
        Ok(txid) => {
            let vout = env_u64("RELAYSIGN_SPEND_VOUT").context("RELAYSIGN_SPEND_VOUT required")? as u32;
            let value = env_u64("RELAYSIGN_SPEND_VALUE").context("RELAYSIGN_SPEND_VALUE required")?;
            (vec![TaprootSpendInput { txid, vout, value_sats: value }], true)
        }
        Err(_) => (vec![TaprootSpendInput { txid: "ab".repeat(32), vout: 0, value_sats: 5_000_000_000 }], false),
    };
    let total_in: u64 = inputs.iter().map(|i| i.value_sats).sum();
    anyhow::ensure!(total_in >= amount_sats + fee_sats, "inputs do not cover amount + fee");
    let change = total_in - amount_sats - fee_sats;
    let mut outputs = vec![TaprootSpendOutput { address: recipient.clone(), value_sats: amount_sats }];
    if change > 0 {
        outputs.push(TaprootSpendOutput { address: vault_address.clone(), value_sats: change });
    }
    let (unsigned_tx_hex, sighashes) = taproot_keyspend_sighashes("regtest", &vault_address, &inputs, &outputs)?;
    anyhow::ensure!(sighashes.len() == 1, "this demo signs a single input");

    let signature = sign_over_relay(
        &mut coords, &picked, &signer_idx, &shares, &dkg.config, &group_key,
        tweak.output_xonly, tweak.tweak, tweak.negate_key, sighashes[0],
    )?;
    for c in &mut coords {
        let _ = c.disconnect();
    }
    let valid = verify_schnorr_digest(&tweak.output_xonly, &sighashes[0], &signature)?;
    anyhow::ensure!(valid, "relay-signed witness invalid under output key");
    println!("✍  quorum signed the proposal over the relay — witness valid under output key: {valid}");

    // ---- 5. EXECUTE ----
    let (raw_tx_hex, txid) = finalize_taproot_keyspend(&unsigned_tx_hex, &[signature])?;
    println!("📤 EXECUTE — settlement tx {txid}");
    if broadcastable {
        println!("BROADCAST_HEX:{raw_tx_hex}");
        println!("   ✓ governance complete: proposal → policy-picked signers → RBAC → relay");
        println!("     signing → broadcastable settlement. Broadcast the hex to settle.");
    } else {
        println!("   (synthetic input — set RELAYSIGN_SPEND_* against {vault_address} to broadcast)");
        println!("   ✓ governance flow complete end-to-end over the relay.");
    }
    Ok(())
}
