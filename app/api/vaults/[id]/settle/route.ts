import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { settleVault } from "../../../_lib/settle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Settle a real on-chain transfer out of this vault (build → threshold-sign via
 * btech-vaultd → broadcast → audit). See `settleVault` for the shared logic.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    recipient?: string;
    amountSats?: number;
    feeSats?: number;
  };
  if (!body.recipient?.trim()) {
    return NextResponse.json({ error: "recipient required" }, { status: 400 });
  }

  try {
    const result = await settleVault(db, {
      vaultId: id,
      recipient: body.recipient.trim(),
      amountSats: body.amountSats ?? 0,
      feeSats: body.feeSats,
      actorNpub: user.npub,
      actorLabel: user.label,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "settlement failed" },
      { status: 502 },
    );
  }
}
