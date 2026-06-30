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
  const live = !!(row.is_live || approval.live);

  // Only registered vault signers (key-share holders) may contribute to a
  // quorum. Membership is global in this demo — the roster lives under a single
  // vault_id — so one lookup answers "is this user a signer?". Observers and
  // other non-signers are rejected and never move the bar.
  const signer = db
    .prepare("SELECT participant_id FROM signers WHERE npub = ? LIMIT 1")
    .get(user.npub) as { participant_id: number } | undefined;
  if (!signer) {
    recordAudit(db, {
      chatId: auditChatId,
      actorNpub: user.npub,
      actorLabel: user.label,
      action: "sign",
      outcome: "failed",
      detail: `${approval.title}: not a signer of this vault`,
    });
    return NextResponse.json({ error: "You are not a signer of this vault." }, { status: 403 });
  }

  // Record THIS signer's approval — one vote per npub (the table's primary key
  // dedups, so signing twice is a no-op). The aggregate is filled in later, and
  // only once, when the quorum is reached and the grouped round actually runs.
  db.prepare(`
    INSERT OR IGNORE INTO approval_signatures (approval_id, npub, aggregate_signature, signed_at)
    VALUES (?, ?, NULL, ?)
  `).run(id, user.npub, Date.now());

  // Quorum is counted by DISTINCT SIGNERS who have approved — not by the size of
  // the crypto round — so the bar fills one signer at a time, across users.
  const signed = (
    db.prepare("SELECT COUNT(*) c FROM approval_signatures WHERE approval_id = ?").get(id) as { c: number }
  ).c;
  const quorumReached = signed >= approval.threshold;

  // Run the real grouped HTSS round ONCE — when the last required signer pushes
  // the approval over its threshold (and the aggregate hasn't already been
  // produced). Earlier signers cast governance votes; the vault only produces
  // its threshold signature after enough distinct signers have approved.
  let proof: SigningProof | undefined = approval.proof;
  if (live && quorumReached && !approval.proof?.verified) {
    const recipient = approval.recipientAddress ?? approval.dest ?? "";
    const amountSats = approval.amountSats ?? Math.round(parseFloat(approval.btc ?? "0") * 1e8);
    try {
      const report = await runSignApproval(
        { recipient, amountSats, nonce: approval.id, memo: approval.title },
        auditChatId, // sign with this vault's own key
      );
      if (!report.verified) throw new Error("aggregate signature failed verification");
      proof = {
        digest: report.authorization_digest,
        signature: report.aggregate_signature,
        groupKey: report.group_xonly_public_key,
        signers: report.signers,
        verified: report.verified,
      };
      // Stamp the completed aggregate onto the signature row that closed quorum.
      db.prepare(
        "UPDATE approval_signatures SET aggregate_signature = ? WHERE approval_id = ? AND npub = ?",
      ).run(report.aggregate_signature, id, user.npub);
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

  // Ready only when the quorum is met AND — for live vaults — the aggregate has
  // verified. A pending approval stays pending until the last signer signs.
  const ready = quorumReached && (!live || !!proof?.verified);
  const updated: Approval = {
    ...approval,
    signed,
    youSigned: true,
    proof: proof ?? approval.proof,
    status: ready ? "ready" : approval.status,
  };
  db.prepare("UPDATE approvals SET data_json = ?, status = ? WHERE id = ?")
    .run(JSON.stringify(updated), updated.status, id);

  recordAudit(db, {
    chatId: auditChatId,
    actorNpub: user.npub,
    actorLabel: user.label,
    action: "sign",
    outcome: "success",
    detail: ready
      ? live
        ? `quorum reached ${signed}/${approval.threshold} — live HTSS aggregate verified`
        : `quorum reached ${signed}/${approval.threshold}`
      : `signed ${signed}/${approval.threshold} (signer #${signer.participant_id})`,
  });

  return NextResponse.json({ approval: updated });
}
