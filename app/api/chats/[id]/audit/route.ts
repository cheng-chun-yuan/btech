import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { isMember, listAudit, recordAudit } from "../../../_lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isMember(db, id, user.npub)) {
    return NextResponse.json({ error: "Restricted to vault members" }, { status: 403 });
  }
  return NextResponse.json({ entries: listAudit(db, id) });
}

/** Metadata-only "sent a message" ping — the message body lives E2E on the relay,
 * so the server records only that activity occurred, never content. */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isMember(db, id, user.npub)) {
    return NextResponse.json({ error: "Restricted to members" }, { status: 403 });
  }
  recordAudit(db, {
    chatId: id,
    actorNpub: user.npub,
    actorLabel: user.label,
    action: "message",
    detail: "sent an encrypted message",
  });
  return NextResponse.json({ ok: true });
}
