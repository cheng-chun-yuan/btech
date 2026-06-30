//! relaychat — REAL group + p2p encrypted chat over a live Nostr relay.
//!
//! Sub-project B: the decentralized coordination/exchange medium. Each participant
//! is its own Nostr identity; messages are NIP-44 encrypted and sender-signed
//! (Nostr events carry a Schnorr signature), so peers verify each other and no
//! server sees plaintext. Two channels:
//!   - GROUP: a message fanned out NIP-44-encrypted to every other member.
//!   - P2P:   a 1:1 NIP-44-encrypted direct message.
//!
//! Usage:
//!   docker compose -f ../dkgkit/examples/self-hosted-relay/docker-compose.yml up -d
//!   DKGKIT_RELAY=ws://127.0.0.1:7777 cargo run --bin relaychat

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

use dkgkit_sdk::bitcoin::sha256;
use nostr_sdk::prelude::*;

// Regular (relay-stored) kind in NIP-01's 1000–9999 range so the relay persists
// and backfills messages. Must match CHAT_KIND in app/ui/wallet/nostr-chat.ts.
// (Was 23333 — an ephemeral kind the relay never stored, breaking chat history.)
const CHAT_KIND: u16 = 9233;

fn secret_for(id: u16) -> [u8; 32] {
    sha256(format!("btech-signer-v1:{id}").as_bytes())
}

fn tag_value(event: &Event, key: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let slice = tag.as_slice();
        if slice.len() >= 2 && slice[0] == key {
            Some(slice[1].clone())
        } else {
            None
        }
    })
}

/// Is `event` addressed to `pk` (carries a matching `p` tag)?
fn addressed_to(event: &Event, pk: &PublicKey) -> bool {
    let hex = pk.to_hex();
    event.tags.iter().any(|tag| {
        let slice = tag.as_slice();
        slice.len() >= 2 && slice[0] == "p" && slice[1] == hex
    })
}

/// Send one NIP-44-encrypted, sender-signed chat message to a single recipient.
async fn send_msg(
    client: &Client,
    sender: &Keys,
    recipient: &PublicKey,
    hashtag: &str,
    scope: &str,
    text: &str,
) -> anyhow::Result<()> {
    let ciphertext = nip44::encrypt(sender.secret_key(), recipient, text, nip44::Version::V2)
        .map_err(|e| anyhow::anyhow!("nip44 encrypt failed: {e}"))?;
    let builder = EventBuilder::new(Kind::Custom(CHAT_KIND), ciphertext).tags(vec![
        Tag::hashtag(hashtag.to_string()),
        Tag::public_key(*recipient),
        Tag::parse(["chat", scope]).map_err(|e| anyhow::anyhow!("bad tag: {e}"))?,
    ]);
    client
        .send_event_builder(builder)
        .await
        .map_err(|e| anyhow::anyhow!("send_event failed: {e}"))?;
    Ok(())
}

/// Drain a participant's notifications for `window`, returning the messages
/// addressed to it that decrypt and come from a known member: (sender, scope, text).
async fn collect(
    notifications: &mut tokio::sync::broadcast::Receiver<RelayPoolNotification>,
    me: &Keys,
    directory: &HashMap<PublicKey, String>,
    window: Duration,
) -> Vec<(String, String, String)> {
    let mut inbox = Vec::new();
    let mut seen: HashSet<EventId> = HashSet::new();
    let my_pk = me.public_key();
    let deadline = Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, notifications.recv()).await {
            Ok(Ok(RelayPoolNotification::Event { event, .. })) => {
                let ev = event.as_ref();
                if ev.kind != Kind::Custom(CHAT_KIND) || !seen.insert(ev.id) {
                    continue;
                }
                if !addressed_to(ev, &my_pk) {
                    continue;
                }
                // Nostr events are signed: ev.pubkey is the authenticated sender.
                let Some(label) = directory.get(&ev.pubkey) else {
                    continue; // not a known group member
                };
                if let Ok(text) = nip44::decrypt(me.secret_key(), &ev.pubkey, &ev.content) {
                    let scope = tag_value(ev, "chat").unwrap_or_else(|| "?".into());
                    inbox.push((label.clone(), scope, text));
                }
            }
            Ok(Ok(_)) => {}
            _ => break,
        }
    }
    inbox
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let relay = std::env::var("DKGKIT_RELAY").unwrap_or_else(|_| "ws://127.0.0.1:7777".to_string());
    let hashtag = format!("dkgkit:btech-relaychat-{}", std::process::id());

    // Participants — each its own Nostr identity (deterministic demo keys).
    let people: Vec<(u16, &str)> = vec![(1, "alice"), (2, "bob"), (3, "carol")];
    let mut keys_by: BTreeMap<u16, Keys> = BTreeMap::new();
    let mut directory: HashMap<PublicKey, String> = HashMap::new();
    for (id, label) in &people {
        let keys = Keys::new(SecretKey::from_slice(&secret_for(*id))?);
        directory.insert(keys.public_key(), label.to_string());
        keys_by.insert(*id, keys);
    }
    let pk_of = |id: u16| keys_by[&id].public_key();

    // One relay client per participant, each subscribed to the group's events.
    let mut clients: BTreeMap<u16, Client> = BTreeMap::new();
    for (id, keys) in &keys_by {
        let client = Client::new(keys.clone());
        client.add_relay(&relay).await?;
        client.connect().await;
        let filter = Filter::new().kind(Kind::Custom(CHAT_KIND)).hashtag(hashtag.clone());
        client.subscribe(filter, None).await?;
        clients.insert(*id, client);
    }
    // Take each participant's notification stream BEFORE anyone sends.
    let mut streams: BTreeMap<u16, tokio::sync::broadcast::Receiver<RelayPoolNotification>> =
        clients.iter().map(|(id, c)| (*id, c.notifications())).collect();
    tokio::time::sleep(Duration::from_millis(600)).await;
    eprintln!("relaychat: {} participants connected to {relay}", people.len());

    // ---- Exchange messages over the relay ----
    // GROUP message from alice → every other member (fan-out).
    for (id, _) in people.iter().filter(|(id, _)| *id != 1) {
        send_msg(&clients[&1], &keys_by[&1], &pk_of(*id), &hashtag, "group",
            "gm — proposing we move 1 BTC from treasury to #ops-petty-cash. ok?").await?;
    }
    // GROUP ack from carol → every other member.
    for (id, _) in people.iter().filter(|(id, _)| *id != 3) {
        send_msg(&clients[&3], &keys_by[&3], &pk_of(*id), &hashtag, "group",
            "ack — looks good to me.").await?;
    }
    // P2P DM alice → bob, and bob → alice.
    send_msg(&clients[&1], &keys_by[&1], &pk_of(2), &hashtag, "dm",
        "bob, you're my co-signer for this — ready?").await?;
    send_msg(&clients[&2], &keys_by[&2], &pk_of(1), &hashtag, "dm",
        "ready. signing over the relay now.").await?;
    eprintln!("relaychat: messages published (2 group fan-outs + 2 DMs)");

    // ---- Collect + decrypt + verify on each participant ----
    let mut inboxes: BTreeMap<u16, Vec<(String, String, String)>> = BTreeMap::new();
    for (id, label) in &people {
        let inbox = collect(streams.get_mut(id).unwrap(), &keys_by[id], &directory, Duration::from_secs(3)).await;
        println!("\n📥 {label} (own Nostr key) received:");
        if inbox.is_empty() {
            println!("   (nothing)");
        }
        for (from, scope, text) in &inbox {
            println!("   [{scope}] {from} → {label}: \"{text}\"  ✓ decrypted + sender verified");
        }
        inboxes.insert(*id, inbox);
    }
    for c in clients.values() {
        c.disconnect().await;
    }

    // ---- Verify the substrate behaved correctly ----
    let scopes = |id: u16| -> Vec<&String> {
        inboxes[&id].iter().filter(|(_, s, _)| s == "group").map(|(f, _, _)| f).collect()
    };
    let dm_senders = |id: u16| -> Vec<&String> {
        inboxes[&id].iter().filter(|(_, s, _)| s == "dm").map(|(f, _, _)| f).collect()
    };
    let group_reached_all = scopes(2).contains(&&"alice".to_string()) // bob got alice's group msg
        && scopes(3).contains(&&"alice".to_string()) // carol got alice's group msg
        && scopes(1).contains(&&"carol".to_string()); // alice got carol's group ack
    let dms_private = dm_senders(1).contains(&&"bob".to_string())   // alice got bob's DM
        && dm_senders(2).contains(&&"alice".to_string())            // bob got alice's DM
        && dm_senders(3).is_empty();                                // carol got NO DMs

    println!("\nrelaychat result:");
    println!("  relay:                 {relay}");
    println!("  group fan-out reached all members:  {group_reached_all}");
    println!("  DMs stayed private (carol excluded): {dms_private}");
    anyhow::ensure!(group_reached_all, "a group message did not reach all members");
    anyhow::ensure!(dms_private, "a direct message leaked to a non-recipient");
    println!("  ✓ real group + p2p chat over the live relay — every message NIP-44");
    println!("    encrypted and sender-signed; peers verified each other; no server");
    println!("    saw plaintext. This is the coordination/exchange substrate for C.");
    Ok(())
}
