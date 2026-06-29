import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { recordAudit, resolveChatId } from "../../../_lib/audit";
import { runDemo } from "../../../_lib/btech";
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

  let aggregate: string | null = null;
  let proof: SigningProof | undefined;
  if (row.is_live || approval.live) {
    // Live vault: run a real grouped HTSS signing round in Rust.
    const report = await runDemo();
    aggregate = report.aggregate_signature;
    proof = {
      digest: report.authorization_digest,
      signature: report.aggregate_signature,
      groupKey: report.group_xonly_public_key,
      signers: report.signers,
      verified: report.verified,
    };
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
    chatId: resolveChatId(db, approval.vault),
    actorNpub: user.npub,
    actorLabel: user.label,
    action: "sign",
    detail: aggregate ? "live HTSS aggregate signature" : approval.title,
  });

  return NextResponse.json({ approval: updated });
}
