// Relay chat verification (run with: NEXT_PUBLIC_NOSTR_RELAY=ws://127.0.0.1:7777 bun .superpowers/sdd/verify-relay-chat.ts)
// Requires a running Nostr relay. Mirrors relaychat.rs: group reaches all, dm stays private.
import { SimplePool, generateSecretKey, getPublicKey, nip19, finalizeEvent, type Event } from "nostr-tools";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";

const RELAY = process.env.NEXT_PUBLIC_NOSTR_RELAY ?? "ws://127.0.0.1:7777";
const KIND = 23333;
const CHAT = `verify-${Math.floor(Date.now())}`; // unique topic per run

type P = { sk: Uint8Array; hex: string; npub: string };
const mk = (): P => { const sk = generateSecretKey(); const hex = getPublicKey(sk); return { sk, hex, npub: nip19.npubEncode(hex) }; };

function publish(pool: SimplePool, sender: P, recipient: P, scope: string, text: string) {
  const ck = getConversationKey(sender.sk, recipient.hex);
  const ev = finalizeEvent(
    { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["t", CHAT], ["p", recipient.hex], ["chat", scope]], content: encrypt(text, ck) },
    sender.sk,
  );
  return Promise.any(pool.publish([RELAY], ev));
}

async function main() {
  const pool = new SimplePool();
  const [alice, bob, carol] = [mk(), mk(), mk()];
  const inbox: Record<string, { from: string; scope: string; text: string }[]> = { alice: [], bob: [], carol: [] };
  const byHex: Record<string, P & { name: string }> = {
    [alice.hex]: { ...alice, name: "alice" }, [bob.hex]: { ...bob, name: "bob" }, [carol.hex]: { ...carol, name: "carol" },
  };

  const sub = pool.subscribeMany([RELAY], { kinds: [KIND], "#t": [CHAT] }, {
    onevent: (ev: Event) => {
      const me = [alice, bob, carol].find((p) => ev.tags.some((t) => t[0] === "p" && t[1] === p.hex));
      if (!me) return;
      const author = byHex[ev.pubkey];
      try {
        const text = decrypt(ev.content, getConversationKey(me.sk, ev.pubkey));
        const scope = ev.tags.find((t) => t[0] === "chat")?.[1] ?? "?";
        inbox[byHex[me.hex].name].push({ from: author?.name ?? "?", scope, text });
      } catch { /* not for me */ }
    },
  });

  await new Promise((r) => setTimeout(r, 500));
  // GROUP from alice → bob + carol (fan-out)
  await Promise.all([publish(pool, alice, bob, "group", "gm team"), publish(pool, alice, carol, "group", "gm team")]);
  // DM alice → bob only
  await publish(pool, alice, bob, "dm", "psst bob");
  await new Promise((r) => setTimeout(r, 2000));
  sub.close(); pool.close([RELAY]);

  const groupAll = inbox.bob.some((m) => m.scope === "group" && m.from === "alice") && inbox.carol.some((m) => m.scope === "group" && m.from === "alice");
  const dmPrivate = inbox.bob.some((m) => m.scope === "dm") && !inbox.carol.some((m) => m.scope === "dm");
  console.log("group reached all members:", groupAll);
  console.log("dm stayed private (carol excluded):", dmPrivate);
  console.log(groupAll && dmPrivate ? "✅ RELAY CHAT VERIFIED" : "❌ FAILED");
  process.exit(groupAll && dmPrivate ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
