import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { recordAudit, resolveChatId } from "../../../_lib/audit";
import { runSignApproval } from "../../../_lib/btech";
import type { Approval, SigningProof } from "../../../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = db.prepare("SELECT id, data_json, is_live FROM approvals WHERE id = ?").get(id) as
    | { id: string; data_json: string; is_live: number }
    | undefined;
  if (!row) return NextResponse.json({ error: "Unknown approval" }, { status: 404 });

  const approval = JSON.parse(row.data_json) as Approval;
  const auditChatId = resolveChatId(db, approval.vault);

  let aggregate: string | null = null;
  let proof: SigningProof | undefined;
  if (row.is_live || approval.live) {
    // Live vault: run a real grouped HTSS round in Rust, signing the approval's
    // actual recipient + amount so the signature is bound to this transaction.
    const recipient = approval.recipientAddress ?? approval.dest ?? "";
    const amountSats =
      approval.amountSats ?? Math.round(parseFloat(approval.btc ?? "0") * 1e8);
    try {
      const report = await runSignApproval(
        { recipient, amountSats, nonce: approval.id, memo: approval.title },
        auditChatId, // sign with this vault's own key
      );
      proof = {
        digest: report.authorization_digest,
        signature: report.aggregate_signature,
        groupKey: report.group_xonly_public_key,
        signers: report.signers,
        verified: report.verified,
      };
      if (!report.verified) throw new Error("aggregate signature failed verification");
      aggregate = report.aggregate_signature;
    } catch (err) {
      // Record the failed signing attempt in the audit trail, then surface it.
      recordAudit(db, {
        chatId: auditChatId,
        actorNpub: user.npub,
        actorLabel: user.label,
        action: "sign",
        outcome: "failed",
        detail: `${approval.title}: ${err instanceof Error ? err.message : "signing failed"}`,
      });
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Signing failed" },
        { status: 502 },
      );
    }
  }

  db.prepare(`
    INSERT OR IGNORE INTO approval_signatures (approval_id, npub, aggregate_signature, signed_at)
    VALUES (?, ?, ?, ?)
  `).run(id, user.npub, aggregate, Date.now());

  const count = (
    db.prepare("SELECT COUNT(*) c FROM approval_signatures WHERE approval_id = ?").get(id) as { c: number }
  ).c;
  const updated: Approval = {
    ...approval,
    signed: Math.max(approval.signed ?? 0, count),
    youSigned: true,
    proof: proof ?? approval.proof,
    status: count >= approval.threshold ? "ready" : approval.status,
  };
  db.prepare("UPDATE approvals SET data_json = ?, status = ? WHERE id = ?")
    .run(JSON.stringify(updated), updated.status, id);

  recordAudit(db, {
    chatId: auditChatId,
    actorNpub: user.npub,
    actorLabel: user.label,
    action: "sign",
    outcome: "success",
    detail: aggregate ? "live HTSS aggregate signature verified" : approval.title,
  });

  return NextResponse.json({ approval: updated });
}
