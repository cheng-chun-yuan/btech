/**
 * One-off live silent-payment send driver (regtest, against the running dev app
 * + vaultd). Logs in as each demo persona via the real Nostr challenge flow,
 * proposes a silent transfer to the treasury's own tsp1 address, signs it to
 * quorum, broadcasts on-chain, and prints the txid + the detected stealth inbox.
 */
import { finalizeEvent } from "nostr-tools";
import { createHash } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:3030";
const TSP1 = process.env.TSP1!;
const AMOUNT_BTC = Number(process.env.AMOUNT_BTC ?? "0.01");

function secret(pid: number): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`btech-signer-v1:${pid}`).digest());
}

function sessionCookie(res: Response): string {
  const all = res.headers.getSetCookie?.() ?? [];
  const hit = all.find((c) => c.startsWith("btech_session="));
  if (!hit) throw new Error("no btech_session cookie in login response");
  return hit.split(";")[0];
}

async function login(pid: number): Promise<string> {
  const { nonce } = (await (await fetch(`${BASE}/api/auth/challenge`)).json()) as { nonce: string };
  const evt = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["challenge", nonce]],
      content: `btech-login:${nonce}`,
    },
    secret(pid),
  );
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: evt, nonce }),
  });
  if (!res.ok) throw new Error(`login pid ${pid}: ${res.status} ${await res.text()}`);
  return sessionCookie(res);
}

async function main() {
  if (!TSP1) throw new Error("set TSP1=<treasury tsp1 address>");
  const alice = await login(1);

  const proposeRes = await fetch(`${BASE}/api/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: alice },
    body: JSON.stringify({
      title: "Silent payment demo",
      vault: "#treasury-ops",
      kind: "send",
      live: true,
      silent: true,
      recipientAddress: TSP1,
      dest: `${TSP1.slice(0, 8)}…${TSP1.slice(-4)}`,
      destLabel: "Bitcoin regtest · stealth",
      amountSats: Math.round(AMOUNT_BTC * 1e8),
      btc: AMOUNT_BTC.toFixed(2),
    }),
  });
  const proposeJson = (await proposeRes.json()) as any;
  if (!proposeRes.ok) throw new Error(`propose: ${JSON.stringify(proposeJson)}`);
  const ap = proposeJson.approval;
  const sigPids: number[] = (ap.signerSet ?? []).map((s: any) => s.participantId);
  console.log(`PROPOSED ${ap.id} · silent=${ap.silent} · threshold=${ap.threshold} · signers=[${sigPids}]`);

  let last: any = ap;
  for (const pid of sigPids) {
    const cookie = await login(pid);
    const r = await fetch(`${BASE}/api/approvals/${ap.id}/sign`, { method: "POST", headers: { cookie } });
    const j = (await r.json()) as any;
    if (!r.ok) throw new Error(`sign pid ${pid}: ${r.status} ${JSON.stringify(j)}`);
    last = j.approval;
    console.log(`  signed #${pid} → ${last.signed}/${last.threshold} · status=${last.status} · verified=${last.proof?.verified ?? false}`);
  }
  if (last.status !== "ready") throw new Error(`not ready after signing: ${last.status}`);

  const bRes = await fetch(`${BASE}/api/approvals/${ap.id}/broadcast`, { method: "POST", headers: { cookie: alice } });
  const bJson = (await bRes.json()) as any;
  if (!bRes.ok) throw new Error(`broadcast: ${JSON.stringify(bJson)}`);
  console.log(`BROADCAST txid=${bJson.txid}`);

  const inbox = (await (await fetch(`${BASE}/api/stealth`)).json()) as any;
  console.log(`STEALTH inbox count=${inbox.inbound?.length ?? 0}`);
  console.log("STEALTH latest:", JSON.stringify(inbox.inbound?.[0] ?? null, null, 2));
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
