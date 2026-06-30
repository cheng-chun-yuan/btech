import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { recordAudit, resolveChatId } from "../../../_lib/audit";
import { settleVault } from "../../../_lib/settle";
import type { Approval } from "../../../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Broadcast a transfer approval on-chain — a SEPARATE action from signing. Only a
 * `ready` transfer (quorum reached, aggregate signature verified) can be broadcast.
 * Builds + threshold-signs the real Taproot spend out of the approval's vault and
 * submits it to the chain, then flips the approval to `broadcast` with its txid.
 */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = db.prepare("SELECT data_json, status FROM approvals WHERE id = ?").get(id) as
    | { data_json: string; status: string }
    | undefined;
  if (!row) return NextResponse.json({ error: "Unknown approval" }, { status: 404 });

  const approval = JSON.parse(row.data_json) as Approval;
  if (approval.kind !== "send") {
    return NextResponse.json({ error: "only transfer approvals broadcast" }, { status: 400 });
  }
  if (approval.status !== "ready") {
    return NextResponse.json(
      { error: "approval is not ready — collect signatures to reach quorum first" },
      { status: 409 },
    );
  }
  const recipient = approval.recipientAddress?.trim();
  if (!recipient) {
    return NextResponse.json({ error: "approval has no recipient address" }, { status: 400 });
  }
  const amountSats = approval.amountSats ?? Math.round(parseFloat(approval.btc ?? "0") * 1e8);
  const vaultId = resolveChatId(db, approval.vault);

  let txid: string;
  try {
    ({ txid } = await settleVault(db, {
      vaultId,
      recipient,
      amountSats,
      actorNpub: user.npub,
      actorLabel: user.label,
    }));
  } catch (err) {
    recordAudit(db, {
      chatId: vaultId,
      actorNpub: user.npub,
      actorLabel: user.label,
      action: "sign",
      outcome: "failed",
      detail: `broadcast failed: ${err instanceof Error ? err.message : "error"}`,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "broadcast failed" },
      { status: 502 },
    );
  }

  const updated: Approval = { ...approval, status: "broadcast", txid };
  db.prepare("UPDATE approvals SET data_json = ?, status = ? WHERE id = ?").run(
    JSON.stringify(updated),
    "broadcast",
    id,
  );
  return NextResponse.json({ approval: updated, txid });
}
