//! relaysign — REAL grouped HTSS threshold SIGNING over a live Nostr relay.
//!
//! Extends `relaydemo` from DKG to full signing with a PRE-COMMITTED first round.
//! Each participant is its own relay client holding only its own share — no server
//! holds keys. The flow:
//!   1. DKG over the relay (run once, then PERSISTED so the address is stable)
//!   2. PRE-COMMIT (round 1): each signer publishes a one-time nonce over the relay
//!   3. SIGN (round 2): each signer publishes its signature share for the message
//!   4. VERIFY: EVERY signer independently aggregates and verifies — no privileged
//!      aggregator.
//!
//! Modes:
//!   (default)  Stage 1 — sign an agreed digest over the relay.
//!   address    Provision (or load) the vault and print its stable receive address.
//!   taproot    Stage 2 — sign a real Taproot key-path sighash over the relay and
//!              finalize a broadcastable transaction. With RELAYSIGN_SPEND_* set it
//!              spends a real funded UTXO; otherwise it signs a synthetic input as a
//!              validity proof.
//!
//! Usage:
//!   DKGKIT_RELAY=ws://127.0.0.1:7777 cargo run --bin relaysign address
//!   DKGKIT_RELAY=ws://127.0.0.1:7777 cargo run --bin relaysign            # Stage 1
//!   RELAYSIGN_SPEND_TXID=<txid> RELAYSIGN_SPEND_VOUT=<n> RELAYSIGN_SPEND_VALUE=<sats> \
//!     RELAYSIGN_TO=<addr> RELAYSIGN_AMOUNT=<sats> cargo run --bin relaysign taproot

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::Context;
use dkgkit_nostr::{LiveNostrTransport, LiveNostrTransportConfig, ParticipantDirectory};
use dkgkit_sdk::bitcoin::{
    finalize_taproot_keyspend, sha256, taproot_child_address_descriptor_for_network,
    taproot_child_key_tweak, taproot_keyspend_sighashes, verify_aggregate_signature_digest,
    verify_schnorr_digest, BitcoinAccountKey, BitcoinDerivationPath, TaprootSpendInput,
    TaprootSpendOutput,
};
use dkgkit_sdk::{
    aggregate_htss_signature_shares, aggregate_htss_signature_shares_for_output,
    hierarchical_config_from_grouped_threshold, htss_nonce, htss_sign_share,
    htss_sign_share_for_output, FrostCoordinator, GroupKey, GroupThresholdRequirement,
    GroupedThresholdConfig, HierarchicalThresholdConfig, HtssDkgRound1Package, HtssDkgRound1State,
    HtssDkgRound2Package, HtssDkgService, HtssLocalKeyShare, HtssLocalNonce, HtssNoncePackage,
    HtssSignatureSharePackage, ParticipantId, RankedParticipant, SessionId,
};
use nostr_sdk::prelude::*;
use serde::{Deserialize, Serialize};

type Coord = FrostCoordinator<LiveNostrTransport>;

/// A tweaked Taproot output key to sign for: (output x-only, additive tweak, A==-1).
type OutputTweak = ([u8; 32], [u8; 32], bool);

/// Persisted finalized vault — group key + every participant's share — so a
/// restart reuses the same key (and therefore the same receive addresses).
#[derive(Serialize, Deserialize)]
struct RelaysignVault {
    group_key: GroupKey,
    shares: Vec<HtssLocalKeyShare>,
}

fn secret_for(id: u16) -> [u8; 32] {
    sha256(format!("btech-signer-v1:{id}").as_bytes())
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok().and_then(|v| v.parse().ok())
}

fn drain_round1(
    coord: &mut Coord,
    session: &SessionId,
    want: usize,
    timeout: Duration,
) -> anyhow::Result<Vec<HtssDkgRound1Package>> {
    let mut acc = Vec::new();
    let deadline = Instant::now() + timeout;
    while acc.len() < want && Instant::now() < deadline {
        acc.extend(coord.drain_htss_dkg_round1(session)?);
        if acc.len() < want {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    anyhow::ensure!(acc.len() >= want, "timed out draining round1 ({}/{})", acc.len(), want);
    Ok(acc)
}

fn drain_round2(
    coord: &mut Coord,
    session: &SessionId,
    recipient: ParticipantId,
    want: usize,
    timeout: Duration,
) -> anyhow::Result<Vec<HtssDkgRound2Package>> {
    let mut acc = Vec::new();
    let deadline = Instant::now() + timeout;
    while acc.len() < want && Instant::now() < deadline {
        acc.extend(coord.drain_htss_dkg_round2_for(session, recipient)?);
        if acc.len() < want {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    anyhow::ensure!(acc.len() >= want, "timed out draining round2 ({}/{})", acc.len(), want);
    Ok(acc)
}

fn drain_nonces(
    coord: &mut Coord,
    session: &SessionId,
    want: usize,
    timeout: Duration,
) -> anyhow::Result<Vec<HtssNoncePackage>> {
    let mut acc: BTreeMap<u16, HtssNoncePackage> = BTreeMap::new();
    let deadline = Instant::now() + timeout;
    while acc.len() < want && Instant::now() < deadline {
        for pkg in coord.drain_htss_nonces(session)? {
            acc.insert(pkg.participant_id.0, pkg);
        }
        if acc.len() < want {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    anyhow::ensure!(acc.len() >= want, "timed out draining nonces ({}/{})", acc.len(), want);
    Ok(acc.into_values().collect())
}

fn drain_sign_shares(
    coord: &mut Coord,
    session: &SessionId,
    want: usize,
    timeout: Duration,
) -> anyhow::Result<Vec<HtssSignatureSharePackage>> {
    let mut acc: BTreeMap<u16, HtssSignatureSharePackage> = BTreeMap::new();
    let deadline = Instant::now() + timeout;
    while acc.len() < want && Instant::now() < deadline {
        for pkg in coord.drain_htss_signature_shares(session)? {
            acc.insert(pkg.participant_id.0, pkg);
        }
        if acc.len() < want {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    anyhow::ensure!(acc.len() >= want, "timed out draining sign shares ({}/{})", acc.len(), want);
    Ok(acc.into_values().collect())
}

/// One full signing session over the relay: each signer pre-commits a single-use
/// nonce (round 1), signs `message` (round 2), and EVERY signer independently
/// aggregates + verifies. `tweak` = `Some(..)` signs for a tweaked Taproot output
/// key; `None` signs under the raw group key. Returns the agreed 64-byte signature.
#[allow(clippy::too_many_arguments)]
fn sign_over_relay(
    coords: &mut [Coord],
    signer_set: &[ParticipantId],
    signer_idx: &[usize],
    shares: &BTreeMap<ParticipantId, HtssLocalKeyShare>,
    config: &HierarchicalThresholdConfig,
    group_key: &GroupKey,
    session_label: &str,
    message: [u8; 32],
    tweak: Option<OutputTweak>,
) -> anyhow::Result<[u8; 64]> {
    let session = SessionId::new(session_label)?;

    // PRE-COMMITTED ROUND (round 1): one single-use nonce per signer.
    let mut local_nonces: BTreeMap<ParticipantId, HtssLocalNonce> = BTreeMap::new();
    for (&pid, &i) in signer_set.iter().zip(signer_idx.iter()) {
        let nonce = htss_nonce(session.clone(), &shares[&pid])?;
        coords[i].publish_htss_nonce(&nonce.package)?;
        local_nonces.insert(pid, nonce);
    }
    let mut nonce_sets: BTreeMap<ParticipantId, Vec<HtssNoncePackage>> = BTreeMap::new();
    for (&pid, &i) in signer_set.iter().zip(signer_idx.iter()) {
        let set = drain_nonces(&mut coords[i], &session, signer_set.len(), Duration::from_secs(20))?;
        nonce_sets.insert(pid, set);
    }

    // SIGN (round 2): each signer publishes its share for the agreed message.
    for (&pid, &i) in signer_set.iter().zip(signer_idx.iter()) {
        // remove() moves the nonce out of the map — signing consumes it by value.
        let nonce = local_nonces.remove(&pid).context("missing local nonce for signer")?;
        let share = match tweak {
            Some((output_xonly, _, negate_key)) => htss_sign_share_for_output(
                group_key,
                message,
                output_xonly,
                negate_key,
                &shares[&pid],
                nonce,
                &nonce_sets[&pid],
                signer_set,
                config,
            )?,
            None => htss_sign_share(
                group_key,
                message,
                &shares[&pid],
                nonce,
                &nonce_sets[&pid],
                signer_set,
                config,
            )?,
        };
        coords[i].publish_htss_signature_share(&share)?;
    }

    // AGGREGATE + VERIFY independently on every signer (verify each other).
    let mut sigs: BTreeMap<ParticipantId, [u8; 64]> = BTreeMap::new();
    for (&pid, &i) in signer_set.iter().zip(signer_idx.iter()) {
        let drained = drain_sign_shares(&mut coords[i], &session, signer_set.len(), Duration::from_secs(20))?;
        let aggregate = match tweak {
            Some((output_xonly, tweak_bytes, negate_key)) => {
                aggregate_htss_signature_shares_for_output(
                    group_key,
                    message,
                    output_xonly,
                    tweak_bytes,
                    negate_key,
                    &nonce_sets[&pid],
                    &drained,
                    signer_set,
                    config,
                )?
            }
            None => {
                let a = aggregate_htss_signature_shares(
                    group_key,
                    message,
                    &nonce_sets[&pid],
                    &drained,
                    signer_set,
                    config,
                )?;
                anyhow::ensure!(
                    verify_aggregate_signature_digest(group_key, &message, &a)?,
                    "peer {} failed to verify the aggregate signature",
                    pid.0
                );
                a
            }
        };
        let bytes: [u8; 64] = aggregate
            .signature_bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("aggregate signature must be 64 bytes"))?;
        sigs.insert(pid, bytes);
    }

    let first = *sigs.values().next().context("no signatures produced")?;
    anyhow::ensure!(
        sigs.values().all(|s| *s == first),
        "peers disagreed on the aggregate signature"
    );
    Ok(first)
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let taproot = args.iter().any(|a| a == "taproot");
    let address_only = args.iter().any(|a| a == "address");
    let relay = std::env::var("DKGKIT_RELAY").unwrap_or_else(|_| "ws://127.0.0.1:7777".to_string());
    let vault_tag = format!("btech-relaysign-{}", std::process::id());

    // 2-of-3 single-group vault — enough to prove multi-agent signing over a relay.
    let grouped = GroupedThresholdConfig::new(
        vec![
            RankedParticipant::new(1, 0, Some("alice".into()))?,
            RankedParticipant::new(2, 0, Some("bob".into()))?,
            RankedParticipant::new(3, 0, Some("carol".into()))?,
        ],
        vec![GroupThresholdRequirement::new(0, 2, 3)?],
    )?;
    let htss = hierarchical_config_from_grouped_threshold(&grouped)?;
    let dkg = HtssDkgService::new("btech-relaysign-dkg", htss)?;
    let dkg_session = dkg.session_id.clone();
    let participants: Vec<ParticipantId> = dkg.config.participants.iter().map(|p| p.id).collect();
    let n = participants.len();

    // Per-participant Nostr identities + shared directory.
    let mut directory = ParticipantDirectory::new();
    let mut keys_by = Vec::new();
    for pid in &participants {
        let keys = Keys::new(SecretKey::from_slice(&secret_for(pid.0)).context("secret key")?);
        directory.insert(*pid, keys.public_key());
        keys_by.push(keys);
    }

    let data_dir =
        PathBuf::from(std::env::var("BTECH_RELAYSIGN_DATA").unwrap_or_else(|_| "data/relaysign".to_string()));
    let vault_file = data_dir.join("vault.json");
    let have_persisted = vault_file.exists();
    // DKG needs the relay; signing needs the relay; loading + address-only does not.
    let need_relay = !have_persisted || !address_only;

    // One relay client per participant.
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
    if need_relay {
        for c in &mut coords {
            c.connect()?;
        }
        std::thread::sleep(Duration::from_millis(400));
        eprintln!("relaysign: {n} participants connected to {relay}");
    }

    // ---- Load persisted vault, or run DKG over the relay and persist it. ----
    let (group_key, shares): (GroupKey, BTreeMap<ParticipantId, HtssLocalKeyShare>) = if have_persisted {
        let vault: RelaysignVault = serde_json::from_slice(&std::fs::read(&vault_file)?)?;
        if vault.group_key.verification_key_bytes.is_empty() {
            eprintln!(
                "relaysign: WARNING — vault predates the hardened dkgkit; its grouped shares \
                 use the old per-tier derivative order and will be REJECTED at signing (rank \
                 mismatch). Delete {} to re-run DKG.",
                vault_file.display()
            );
        }
        let shares = vault
            .shares
            .into_iter()
            .map(|s| (s.participant_id, s))
            .collect::<BTreeMap<_, _>>();
        eprintln!("relaysign: loaded persisted vault ({} shares)", shares.len());
        (vault.group_key, shares)
    } else {
        let mut states: Vec<HtssDkgRound1State> = Vec::new();
        for (i, pid) in participants.iter().enumerate() {
            let st = dkg.begin_round1(*pid)?;
            coords[i].publish_htss_dkg_round1(dkg_session.clone(), &st.package)?;
            states.push(st);
        }
        let mut round1_all: Vec<Vec<HtssDkgRound1Package>> = Vec::new();
        for c in &mut coords {
            round1_all.push(drain_round1(c, &dkg_session, n, Duration::from_secs(20))?);
        }
        for i in 0..n {
            for pkg in dkg.create_round2_packages(&states[i], &round1_all[i])? {
                coords[i].publish_htss_dkg_round2(dkg_session.clone(), &pkg)?;
            }
        }
        let mut shares: BTreeMap<ParticipantId, HtssLocalKeyShare> = BTreeMap::new();
        let mut group_keys: Vec<GroupKey> = Vec::new();
        for (i, pid) in participants.iter().enumerate() {
            let r2 = drain_round2(&mut coords[i], &dkg_session, *pid, n - 1, Duration::from_secs(20))?;
            let (gk, share) = dkg.finalize_participant(*pid, &round1_all[i], &r2)?;
            shares.insert(*pid, share);
            group_keys.push(gk);
        }
        let group_key = group_keys[0].clone();
        anyhow::ensure!(
            group_keys.iter().all(|k| k.xonly_public_key == group_key.xonly_public_key),
            "participants derived different group keys"
        );
        std::fs::create_dir_all(&data_dir).ok();
        let vault = RelaysignVault {
            group_key: group_key.clone(),
            shares: shares.values().cloned().collect(),
        };
        std::fs::write(&vault_file, serde_json::to_vec_pretty(&vault)?)?;
        eprintln!("relaysign: DKG complete over relay; vault persisted to {}", vault_file.display());
        (group_key, shares)
    };

    // Stable receive address from the (persisted) group key.
    let account = BitcoinAccountKey::new(group_key.clone(), [42u8; 32]);
    let path = BitcoinDerivationPath::bip86(0, 0, 0);
    let vault_address =
        taproot_child_address_descriptor_for_network(&account, "regtest", path.clone())?.address;

    if address_only {
        println!("relaysign vault address: {vault_address}");
        println!("group x-only:            {}", hex::encode(group_key.xonly_public_key));
        println!("(fund this address on regtest, then: relaysign taproot with RELAYSIGN_SPEND_*)");
        return Ok(());
    }

    // 2-of-3: alice + bob sign; carol abstains.
    let signer_set = vec![participants[0], participants[1]];
    let signer_idx: Vec<usize> = signer_set
        .iter()
        .map(|s| participants.iter().position(|p| p == s).expect("signer in set"))
        .collect();

    if !taproot {
        // ---- Stage 1: sign an agreed authorization digest over the relay. ----
        let digest =
            sha256(b"btech relaysign stage-1: authorize transfer of 1.00 BTC to #ops-petty-cash");
        let signature = sign_over_relay(
            &mut coords,
            &signer_set,
            &signer_idx,
            &shares,
            &dkg.config,
            &group_key,
            "btech-relaysign-sign",
            digest,
            None,
        )?;
        for c in &mut coords {
            let _ = c.disconnect();
        }
        println!("relaysign result (Stage 1 — digest):");
        println!("  relay:        {relay}");
        println!(
            "  signers:      {:?} (2-of-3, each a distinct Nostr identity over the live relay)",
            signer_set.iter().map(|p| p.0).collect::<Vec<_>>()
        );
        println!("  group x-only: {}…", &hex::encode(group_key.xonly_public_key)[..16]);
        println!("  signature:    {}…", &hex::encode(signature)[..24]);
        println!("  ✓ trustless pre-committed-round HTSS signing over the live relay.");
        return Ok(());
    }

    // ---- Stage 2: sign a REAL Taproot key-path sighash over the relay. ----
    let tweak = taproot_child_key_tweak(&account, "regtest", path)?;
    let recipient = std::env::var("RELAYSIGN_TO")
        .unwrap_or_else(|_| "bcrt1pxvv7ajy96lnj2m5r26pvkjvpkxn20w94zs63nzvfjvcnehss9phqv0mwvm".to_string());
    let amount_sats = env_u64("RELAYSIGN_AMOUNT").unwrap_or(100_000_000);
    let fee_sats = env_u64("RELAYSIGN_FEE").unwrap_or(1000);

    // Real funded UTXO from RELAYSIGN_SPEND_*, else a synthetic input (proof only).
    let (inputs, broadcastable) = match std::env::var("RELAYSIGN_SPEND_TXID") {
        Ok(txid) => {
            let vout = env_u64("RELAYSIGN_SPEND_VOUT").context("RELAYSIGN_SPEND_VOUT required")? as u32;
            let value = env_u64("RELAYSIGN_SPEND_VALUE").context("RELAYSIGN_SPEND_VALUE required")?;
            (vec![TaprootSpendInput { txid, vout, value_sats: value }], true)
        }
        Err(_) => (
            vec![TaprootSpendInput { txid: "ab".repeat(32), vout: 0, value_sats: 5_000_000_000 }],
            false,
        ),
    };
    let total_in: u64 = inputs.iter().map(|i| i.value_sats).sum();
    anyhow::ensure!(
        total_in >= amount_sats + fee_sats,
        "inputs ({total_in}) do not cover amount + fee ({})",
        amount_sats + fee_sats
    );
    let change_sats = total_in - amount_sats - fee_sats;
    let mut outputs = vec![TaprootSpendOutput { address: recipient.clone(), value_sats: amount_sats }];
    if change_sats > 0 {
        outputs.push(TaprootSpendOutput { address: vault_address.clone(), value_sats: change_sats });
    }
    let (unsigned_tx_hex, sighashes) =
        taproot_keyspend_sighashes("regtest", &vault_address, &inputs, &outputs)?;
    anyhow::ensure!(sighashes.len() == 1, "this demo signs a single input");

    let signature = sign_over_relay(
        &mut coords,
        &signer_set,
        &signer_idx,
        &shares,
        &dkg.config,
        &group_key,
        "btech-relaysign-taproot",
        sighashes[0],
        Some((tweak.output_xonly, tweak.tweak, tweak.negate_key)),
    )?;
    for c in &mut coords {
        let _ = c.disconnect();
    }

    let valid = verify_schnorr_digest(&tweak.output_xonly, &sighashes[0], &signature)?;
    anyhow::ensure!(valid, "relay-signed witness does not verify under the output key");
    let (raw_tx_hex, txid) = finalize_taproot_keyspend(&unsigned_tx_hex, &[signature])?;

    println!("relaysign result (Stage 2 — Taproot key-path spend):");
    println!("  relay:         {relay}");
    println!(
        "  signers:       {:?} (2-of-3 over the live relay)",
        signer_set.iter().map(|p| p.0).collect::<Vec<_>>()
    );
    println!("  vault address: {vault_address}");
    println!("  recipient:     {recipient} ({amount_sats} sats)");
    println!("  witness valid under output key: {valid}");
    println!("  txid:          {txid}");
    if broadcastable {
        println!("BROADCAST_HEX:{raw_tx_hex}");
        println!("  ✓ real funded UTXO, threshold-signed entirely over the relay. Broadcast");
        println!("    the hex above to settle a trustless on-chain exchange.");
    } else {
        println!("  (synthetic input — fund {vault_address}, then re-run taproot with");
        println!("   RELAYSIGN_SPEND_TXID/VOUT/VALUE to produce a broadcastable transaction.)");
    }
    Ok(())
}
