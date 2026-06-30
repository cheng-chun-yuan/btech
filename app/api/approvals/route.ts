import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";

import { getDb } from "../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../_lib/auth";
import { recordAudit, resolveChatId, isMember } from "../_lib/audit";
import { resolveSignerSet, defaultSignerSet } from "../_lib/governance";
import { runVaultQuorum } from "../_lib/btech";
import { isBrickedPolicy } from "./policy-validate";
import type { Approval } from "../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  const rows = db.prepare("SELECT id, data_json FROM approvals ORDER BY created_at DESC").all() as
    { id: string; data_json: string }[];
  const sigCount = db.prepare("SELECT COUNT(*) c FROM approval_signatures WHERE approval_id = ?");
  const mineStmt = db.prepare("SELECT 1 FROM approval_signatures WHERE approval_id = ? AND npub = ?");

  const approvals: Approval[] = rows.map((row) => {
    const a = JSON.parse(row.data_json) as Approval;
    const persistedSigs = (sigCount.get(row.id) as { c: number }).c;
    const signed = Math.max(a.signed ?? 0, persistedSigs);
    const youSigned = user ? !!mineStmt.get(row.id, user.npub) : false;
    return { ...a, signed, youSigned };
  });
  return NextResponse.json({ approvals });
}

export async function POST(request: Request) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Partial<Approval>;
  if (!body.title || !body.vault) {
    return NextResponse.json({ error: "title and vault required" }, { status: 400 });
  }

  // Propose-picks-signers: the proposer may send explicit `signerNpubs`; else we
  // default to the vault's canonical valid set (when it has a signer roster).
  let signerSet: Approval["signerSet"];   // undefined unless we resolve one server-side
  try {
    if (Array.isArray((body as { signerNpubs?: string[] }).signerNpubs)) {
      signerSet = resolveSignerSet(db, (body as { signerNpubs: string[] }).signerNpubs);
    } else {
      const def = defaultSignerSet(db);
      if (def.length > 0) signerSet = def;
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "invalid signer set" },
      { status: 400 },
    );
  }

  const approval: Approval = {
    kind: "send",
    signed: 0,
    youSigned: false,
    status: "pending",
    policy: "",
    time: "just now",
    ...body,
    id: body.id ?? `tx_${randomBytes(5).toString("hex")}`,
    title: body.title,
    vault: body.vault,
    signerSet,
    // signerSet (when present) is the quorum, so it sets threshold/total; these
    // sit AFTER ...body so they win over whatever the client sent.
    threshold: signerSet ? signerSet.length : (body.threshold ?? 1),
    total: signerSet ? signerSet.length : (body.total ?? 1),
  } as Approval;

  // Policy-change proposals (kind:"role" + proposedPolicy): hard-block a bricked
  // policy (would freeze the vault forever), stamp the basePolicyVersion the
  // proposal was authored against (a lost-update guard checked later at apply),
  // and SERVER-SIDE pin the threshold to the CURRENT policy's full quorum.
  if (approval.kind === "role" && approval.proposedPolicy) {
    if (isBrickedPolicy(approval.proposedPolicy)) {
      return NextResponse.json(
        { error: "Policy would lock the vault — every tier must be satisfiable." },
        { status: 400 },
      );
    }
    const chatId = resolveChatId(db, approval.vault);

    // Membership gate (spec): only a member of this vault — a registered signer
    // or an explicit chat member — may propose a policy change. A non-member
    // proposer is rejected 403 and the attempt is audited as a failed reshare.
    // Scoped to the policy-change branch ONLY; payment (kind:"send") proposals
    // are unaffected.
    if (!isMember(db, chatId, user.npub)) {
      recordAudit(db, {
        chatId,
        actorNpub: user.npub,
        actorLabel: user.label,
        action: "reshare",
        outcome: "failed",
        detail: `${approval.title}: not a member of this vault`,
      });
      return NextResponse.json(
        { error: "You are not a member of this vault." },
        { status: 403 },
      );
    }

    const chatRow = db.prepare("SELECT data_json FROM chats WHERE id = ?").get(chatId) as
      | { data_json: string }
      | undefined;
    const meta = chatRow
      ? (JSON.parse(chatRow.data_json) as { policyVersion?: number; tiers?: { minNeed?: number }[] })
      : undefined;
    approval.basePolicyVersion = meta?.policyVersion ?? 0;

    // SECURITY: a policy-change approval must be ratified by the vault's CURRENT
    // quorum — never by a proposer-picked signerSet, and NEVER by the client-sent
    // threshold. C's signerSet resolution above would (for a role approval) leave
    // a default signerSet and set threshold = signerSet.length, a current-quorum
    // bypass (a proposer could land threshold = 1 and self-ratify the reshare).
    // Drop any signerSet and derive the quorum server-side: prefer the sum of the
    // current policy tiers' minNeed; for the live treasury vault (tiers NOT mirrored
    // into the web DB → sum 0) source it AUTHORITATIVELY from vaultd's grouped_config.
    // If neither yields a quorum we FAIL CLOSED with 400 rather than trust the client.
    delete approval.signerSet;
    let quorum = (meta?.tiers ?? []).reduce((sum, t) => sum + (t.minNeed ?? 0), 0);
    if (!quorum) quorum = (await runVaultQuorum(chatId)) ?? 0;
    if (!quorum || quorum < 1) {
      return NextResponse.json(
        { error: "Cannot determine the current policy quorum for this vault." },
        { status: 400 },
      );
    }
    approval.threshold = quorum;
    approval.total = quorum;
    // NEVER use body.threshold for role approvals.
  }

  db.prepare(`
    INSERT INTO approvals (id, vault, kind, data_json, status, is_live, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    approval.id,
    approval.vault,
    approval.kind,
    JSON.stringify(approval),
    approval.status,
    approval.live ? 1 : 0,
    Date.now(),
  );

  recordAudit(db, {
    chatId: resolveChatId(db, approval.vault),
    actorNpub: user.npub,
    actorLabel: user.label,
    action: "propose",
    outcome: "success",
    detail: approval.title,
  });

  return NextResponse.json({ approval });
}
