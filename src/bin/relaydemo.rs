//! relaydemo — run a REAL grouped HTSS DKG over a live Nostr relay.
//!
//! Each participant is its own relay client (own keypair, shared directory), so
//! round-1 packages broadcast publicly and round-2 secret shares travel as
//! NIP-44-encrypted point-to-point direct messages. Proves the relay is
//! load-bearing for the ceremony, not just an in-memory bus.
//!
//! Usage:
//!   docker compose -f ../dkgkit/examples/self-hosted-relay/docker-compose.yml up -d
//!   DKGKIT_RELAY=ws://127.0.0.1:7777 cargo run --bin relaydemo

use std::time::{Duration, Instant};

use anyhow::Context;
use dkgkit_nostr::{LiveNostrTransport, LiveNostrTransportConfig, ParticipantDirectory};
use dkgkit_sdk::bitcoin::sha256;
use dkgkit_sdk::{
    hierarchical_config_from_grouped_threshold, FrostCoordinator, GroupThresholdRequirement,
    GroupedThresholdConfig, HtssDkgRound1Package, HtssDkgRound1State, HtssDkgRound2Package,
    HtssDkgService, ParticipantId, RankedParticipant, SessionId,
};
use nostr_sdk::prelude::*;

fn secret_for(id: u16) -> [u8; 32] {
    sha256(format!("btech-signer-v1:{id}").as_bytes())
}

fn drain_round1(
    coord: &mut FrostCoordinator<LiveNostrTransport>,
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
    coord: &mut FrostCoordinator<LiveNostrTransport>,
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

fn main() -> anyhow::Result<()> {
    let relay = std::env::var("DKGKIT_RELAY").unwrap_or_else(|_| "ws://127.0.0.1:7777".to_string());
    let vault_tag = format!("btech-relaydemo-{}", std::process::id());

    // A 2-of-3 single-group vault is enough to prove multi-agent DKG over a relay.
    let grouped = GroupedThresholdConfig::new(
        vec![
            RankedParticipant::new(1, 0, Some("alice".into()))?,
            RankedParticipant::new(2, 0, Some("bob".into()))?,
            RankedParticipant::new(3, 0, Some("carol".into()))?,
        ],
        vec![GroupThresholdRequirement::new(0, 2, 3)?],
    )?;
    let htss = hierarchical_config_from_grouped_threshold(&grouped)?;
    let dkg = HtssDkgService::new("btech-relaydemo-dkg", htss)?;
    let session = dkg.session_id.clone();
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

    // One relay client (coordinator) per participant.
    let mut coords: Vec<FrostCoordinator<LiveNostrTransport>> = Vec::new();
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
    std::thread::sleep(Duration::from_millis(400)); // let subscriptions settle
    eprintln!("relaydemo: {n} participants connected to {relay}");

    // Round 1 — public broadcast.
    let mut states: Vec<HtssDkgRound1State> = Vec::new();
    for (i, pid) in participants.iter().enumerate() {
        let st = dkg.begin_round1(*pid)?;
        coords[i].publish_htss_dkg_round1(session.clone(), &st.package)?;
        states.push(st);
    }
    let mut round1_all: Vec<Vec<HtssDkgRound1Package>> = Vec::new();
    for c in &mut coords {
        round1_all.push(drain_round1(c, &session, n, Duration::from_secs(20))?);
    }
    eprintln!("relaydemo: round1 broadcast + collected over relay");

    // Round 2 — NIP-44-encrypted direct shares.
    for i in 0..n {
        for pkg in dkg.create_round2_packages(&states[i], &round1_all[i])? {
            coords[i].publish_htss_dkg_round2(session.clone(), &pkg)?;
        }
    }
    eprintln!("relaydemo: round2 encrypted shares published over relay");

    // Each participant finalizes from the shares addressed to it.
    let mut group_keys = Vec::new();
    for (i, pid) in participants.iter().enumerate() {
        let r2 = drain_round2(&mut coords[i], &session, *pid, n - 1, Duration::from_secs(20))?;
        let (gk, _share) = dkg.finalize_participant(*pid, &round1_all[i], &r2)?;
        group_keys.push(hex::encode(gk.xonly_public_key));
    }
    for c in &mut coords {
        let _ = c.disconnect();
    }

    let first = &group_keys[0];
    let all_match = group_keys.iter().all(|k| k == first);
    println!("relaydemo result:");
    println!("  relay:        {relay}");
    println!("  participants: {n} (each a distinct Nostr identity)");
    println!("  group x-only: {}…", &first[..16]);
    println!("  all agree:    {all_match}");
    anyhow::ensure!(all_match, "participants derived different group keys");
    println!("  ✓ real grouped HTSS DKG completed over the live relay (round-2 shares NIP-44 encrypted)");
    Ok(())
}
