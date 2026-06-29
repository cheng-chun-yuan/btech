import { NextResponse } from "next/server";

import { getDb } from "../../_lib/db";
import { normalizeNpub } from "../../_lib/identity";
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from "../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { npub?: string };
  const npub = body.npub ? normalizeNpub(body.npub) : null;
  if (!npub) {
    return NextResponse.json({ error: "Invalid Nostr key" }, { status: 400 });
  }

  const db = getDb();
  const existing = db.prepare("SELECT npub, label, role FROM users WHERE npub = ?").get(npub) as
    | { npub: string; label: string; role: string }
    | undefined;

  // Unknown npub logs in as a read-only observer.
  const user =
    existing ??
    (() => {
      db.prepare("INSERT INTO users (npub, label, role, created_at) VALUES (?, 'Observer', 'Observer', ?)")
        .run(npub, Date.now());
      return { npub, label: "Observer", role: "Observer" };
    })();

  const signer = !!db
    .prepare("SELECT 1 FROM signers WHERE npub = ? LIMIT 1")
    .get(npub);

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
