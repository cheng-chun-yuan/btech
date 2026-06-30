import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { recordAudit, resolveChatId } from "../../../_lib/audit";
import {
  runSignApproval,
  runPrecommit,
  runFinalize,
  runReshare,
  policyConfigToWire,
  VAULTD_CONFIGURED,
} from "../../../_lib/btech";
import { isSelectedSigner, signedNpubs, allSelectedSigned } from "../../../_lib/governance";
import { policyToDisplayTiers } from "../../policy-mirror";
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
  //
  // A policy-change (reshare) approval (kind:"role") must NEVER precommit, even
  // if the propose route wrongly attached a signerSet — precommit belongs to the
  // grouped payment round, and an orphaned vaultd session would leak. Defense in
  // depth: gate precommit on the approval NOT being a role/reshare change.
  let precommitJson: string | null = null;
  if (
    live &&
    approval.signerSet &&
    approval.kind !== "role" &&
    VAULTD_CONFIGURED &&
    !approval.proof?.verified
  ) {
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
  // A role/reshare approval is ALWAYS threshold-based (the full current-policy
  // quorum of DISTINCT signers) — never `allSelectedSigned`. Letting a signerSet
  // govern its quorum would let a hand-picked 1-element set self-ratify a
  // reshare; refuse that here regardless of what the propose route attached.
  const useSelected = approval.signerSet && approval.kind !== "role";
  const quorumReached = useSelected
    ? allSelectedSigned(approval.signerSet!, signedNpubs(db, id))
    : signed >= approval.threshold;

  // Run the real grouped HTSS round ONCE — when the last required signer pushes
  // the approval over its threshold (and the aggregate hasn't already been
  // produced). Earlier signers cast governance votes; the vault only produces
  // its threshold signature after enough distinct signers have approved.
  let proof: SigningProof | undefined = approval.proof;
  if (live && quorumReached && !approval.proof?.verified) {
    if (approval.kind === "role" && approval.proposedPolicy) {
      // Policy-change RESHARE. A role approval carries a proposedPolicy but NO
      // signerSet, so it skipped the selected-signer gate + the precommit round
      // and reached quorum on DISTINCT current signers (signed >= threshold) —
      // exactly the authority needed to ratify a key-share reshare. We re-share
      // ONCE here, when the quorum-closing signer pushes it over the threshold.
      const chatRow = db.prepare("SELECT data_json FROM chats WHERE id = ?").get(auditChatId) as
        | { data_json: string }
        | undefined;
      const chat = chatRow ? JSON.parse(chatRow.data_json) : { policyVersion: 0 };
      const liveVersion: number = chat.policyVersion ?? 0;

      // Lost-update guard: the proposal must target the policy version it was
      // authored against. If the live policy moved on (another reshare landed
      // first), reject so the proposer re-proposes against the current policy.
      if ((approval.basePolicyVersion ?? 0) !== liveVersion) {
        recordAudit(db, {
          chatId: auditChatId,
          actorNpub: user.npub,
          actorLabel: user.label,
          action: "reshare",
          outcome: "failed",
          detail: `${approval.title}: policy changed since proposed (v${approval.basePolicyVersion ?? 0} ≠ v${liveVersion})`,
        });
        return NextResponse.json(
          { error: "Policy changed since this was proposed. Re-propose against the current policy." },
          { status: 409 },
        );
      }

      try {
        // Ratifier set = the DISTINCT signers who actually voted (all current
        // signers). Resolve each voter npub to its Rust participant id.
        const voters = (
          db.prepare("SELECT npub FROM approval_signatures WHERE approval_id = ?").all(id) as {
            npub: string;
          }[]
        ).map((r) => r.npub);
        const signerSet = voters
          .map(
            (n) =>
              (
                db.prepare("SELECT participant_id FROM signers WHERE npub = ? LIMIT 1").get(n) as
                  | { participant_id: number }
                  | undefined
              )?.participant_id,
          )
          .filter((x): x is number => typeof x === "number");

        const wire = policyConfigToWire(approval.proposedPolicy);
        const report = await runReshare(
          { session: approval.id, signerSet, newConfig: wire, policyFingerprint: JSON.stringify(wire) },
          auditChatId,
        );
        if (!report.verified) throw new Error("reshare authorization failed verification");
        proof = {
          digest: report.authorization_digest,
          signature: report.aggregate_signature,
          groupKey: report.group_xonly_public_key,
          signers: report.signers,
          verified: report.verified,
        };

        // web<->vaultd mirror is NOT atomic, and intentionally so. By this point
        // vaultd has ALREADY reshared the key material — it is the authoritative
        // source of the live policy. The UPDATE below only mirrors that into the
        // `chats` row (display tiers + policyVersion). If this local sqlite write
        // throws, the catch returns 502 and policyVersion is left un-bumped, so web
        // is momentarily stale vs vaultd. That window is practically unreachable (a
        // local sqlite write immediately after a 200 from vaultd) and self-corrects
        // on the next reshare/retry; funds stay safe regardless because a reshare
        // rotates shares only — the group key and receive address are invariant.
        //
        // Mirror the new authoritative policy into the chat + bump policyVersion.
        // A reshare rotates key shares, not the group key, so the receive address
        // is unchanged — only the displayed tiers + version advance.
        const mirrored = {
          ...chat,
          tiers: policyToDisplayTiers(approval.proposedPolicy),
          policyVersion: liveVersion + 1,
        };
        db.prepare("UPDATE chats SET data_json = ? WHERE id = ?").run(
          JSON.stringify(mirrored),
          auditChatId,
        );
      } catch (err) {
        recordAudit(db, {
          chatId: auditChatId,
          actorNpub: user.npub,
          actorLabel: user.label,
          action: "reshare",
          outcome: "failed",
          detail: `${approval.title}: ${err instanceof Error ? err.message : "reshare failed"}`,
        });
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Reshare failed" },
          { status: 502 },
        );
      }

      recordAudit(db, {
        chatId: auditChatId,
        actorNpub: user.npub,
        actorLabel: user.label,
        action: "reshare",
        outcome: "success",
        detail: `${approval.title}: policy reshared, address unchanged (v${liveVersion + 1})`,
      });
    } else {
      // Payment authorization — the existing grouped HTSS round (unchanged).
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
