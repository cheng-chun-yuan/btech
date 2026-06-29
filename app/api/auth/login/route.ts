import { NextResponse } from "next/server";
import type { Event } from "nostr-tools";

import { getDb } from "../../_lib/db";
import { consumeChallenge, verifiedNpub } from "../../_lib/challenge";
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from "../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Login by proving control of a Nostr key: the client signs a one-time
 * challenge nonce (via NIP-07 or an nsec) and posts the signed event. We verify
 * the Schnorr signature and derive the npub from the proven event — knowing a
 * public npub is no longer enough to log in.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    event?: Event;
    nonce?: string;
  };
  if (!body.event || !body.nonce) {
    return NextResponse.json({ error: "Missing signed challenge" }, { status: 400 });
  }

  const db = getDb();
  if (!consumeChallenge(db, body.nonce)) {
    return NextResponse.json({ error: "Challenge expired — try again" }, { status: 401 });
  }
  const npub = verifiedNpub(body.event, body.nonce);
  if (!npub) {
    return NextResponse.json({ error: "Signature did not verify" }, { status: 401 });
  }

  const existing = db.prepare("SELECT npub, label, role FROM users WHERE npub = ?").get(npub) as
    | { npub: string; label: string; role: string }
    | undefined;

  const user =
    existing ??
    (() => {
      db.prepare("INSERT INTO users (npub, label, role, created_at) VALUES (?, 'Observer', 'Observer', ?)")
        .run(npub, Date.now());
      return { npub, label: "Observer", role: "Observer" };
    })();

  const signer = !!db.prepare("SELECT 1 FROM signers WHERE npub = ? LIMIT 1").get(npub);

  const token = createSession(db, npub);
  const res = NextResponse.json({ ...user, signer });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
