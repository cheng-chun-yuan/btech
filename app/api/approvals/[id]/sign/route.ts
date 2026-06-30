import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { recordAudit, resolveChatId } from "../../../_lib/audit";
import { runSignApproval, runPrecommit, runFinalize, VAULTD_CONFIGURED } from "../../../_lib/btech";
import { isSelectedSigner, signedNpubs, allSelectedSigned } from "../../../_lib/governance";
import type { Approval, SigningProof } from "../../../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = db.prepare("SELECT id, data_json, is_live, status FROM approvals WHERE id = ?").get(id) as
    | { id: string; data_json: string; is_live: number; status: string }
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
  if (approval.signerSet && !isSelectedSigner(approval.signerSet, user.npub)) {
    recordAudit(db, {
      chatId: auditChatId,
      actorNpub: user.npub,
      actorLabel: user.label,
      action: "sign",
      outcome: "failed",
      detail: `${approval.title}: not a selected signer for this approval`,
    });
    return NextResponse.json({ error: "You are not a selected signer for this approval." }, { status: 403 });
  }

  // Round 1 (collapsed two-round): a selected signer pre-commits their nonce as
  // they approve. The secret nonce stays in vaultd; we store only the public
  // package. Falls through to a plain vote when vaultd/ signerSet is absent.
  let precommitJson: string | null = null;
  if (live && approval.signerSet && VAULTD_CONFIGURED && !approval.proof?.verified) {
    try {
      const pc = await runPrecommit(
        { session: approval.id, participantId: signer.participant_id },
        auditChatId,
      );
      precommitJson = JSON.stringify(pc.nonce_package);
    } catch (err) {
      recordAudit(db, {
        chatId: auditChatId,
        actorNpub: user.npub,
        actorLabel: user.label,
        action: "sign",
        outcome: "failed",
        detail: `${approval.title}: pre-commit failed`,
      });
      return NextResponse.json({ error: err instanceof Error ? err.message : "pre-commit failed" }, { status: 502 });
    }
  }
  db.prepare(`
    INSERT OR IGNORE INTO approval_signatures (approval_id, npub, aggregate_signature, precommit, signed_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(id, user.npub, precommitJson, Date.now());

  // Quorum is counted by DISTINCT SIGNERS who have approved — not by the size of
  // the crypto round — so the bar fills one signer at a time, across users.
  const signed = (
    db.prepare("SELECT COUNT(*) c FROM approval_signatures WHERE approval_id = ?").get(id) as { c: number }
  ).c;
  const quorumReached = approval.signerSet
    ? allSelectedSigned(approval.signerSet, signedNpubs(db, id))
    : signed >= approval.threshold;

  // Run the real grouped HTSS round ONCE — when the last required signer pushes
  // the approval over its threshold (and the aggregate hasn't already been
  // produced). Earlier signers cast governance votes; the vault only produces
  // its threshold signature after enough distinct signers have approved.
  let proof: SigningProof | undefined = approval.proof;
  if (live && quorumReached && !approval.proof?.verified) {
    const recipient = approval.recipientAddress ?? approval.dest ?? "";
    const amountSats = approval.amountSats ?? Math.round(parseFloat(approval.btc ?? "0") * 1e8);
    try {
      const report =
        approval.signerSet && VAULTD_CONFIGURED
          ? await runFinalize(
              {
                session: approval.id,
                signerSet: approval.signerSet.map((s) => s.participantId),
                recipient,
                amountSats,
                nonce: approval.id,
                memo: approval.title,
              },
              auditChatId,
            )
          : await runSignApproval(
              { recipient, amountSats, nonce: approval.id, memo: approval.title },
              auditChatId,
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
  const currentStatus = approval.status ?? row.status;
  const updated: Approval = {
    ...approval,
    signed,
    youSigned: true,
    proof: proof ?? approval.proof,
    status: ready ? "ready" : currentStatus,
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
