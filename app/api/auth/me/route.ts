import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const db = getDb();
  const user = getSessionUser(db, token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const signer = db
    .prepare("SELECT participant_id FROM signers WHERE npub = ? LIMIT 1")
    .get(user.npub) as { participant_id: number } | undefined;
  return NextResponse.json({ ...user, participant_id: signer?.participant_id ?? null });
}
