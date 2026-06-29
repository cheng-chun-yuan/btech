import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";

import { getDb } from "../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../_lib/auth";
import { recordAudit, resolveChatId } from "../_lib/audit";
import type { Approval } from "../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ensure the live treasury approval row exists so its signatures can persist. */
function ensureLiveApproval(db: ReturnType<typeof getDb>) {
  db.prepare(`
    INSERT OR IGNORE INTO approvals (id, vault, kind, data_json, status, is_live, created_at)
    VALUES ('tx1', '#treasury-ops', 'send', ?, 'pending', 1, ?)
  `).run(
    JSON.stringify({
      id: "tx1",
      kind: "send",
      vault: "#treasury-ops",
      title: "Vendor payment — Blockstream",
      live: true,
      threshold: 6,
      total: 10,
      signed: 1,
      youSigned: false,
      status: "pending",
      policy: "1/2 + 2/3 + 3/5",
      time: "12m ago",
    }),
    Date.now(),
  );
}

export async function GET() {
  const db = getDb();
  ensureLiveApproval(db);
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
  const approval: Approval = {
    kind: "send",
    threshold: 1,
    total: 1,
    signed: 0,
    youSigned: false,
    status: "pending",
    policy: "",
    time: "just now",
    ...body,
    id: body.id ?? `tx_${randomBytes(5).toString("hex")}`,
    title: body.title,
    vault: body.vault,
  } as Approval;

  db.prepare(`
    INSERT INTO approvals (id, vault, kind, data_json, status, is_live, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(approval.id, approval.vault, approval.kind, JSON.stringify(approval), approval.status, Date.now());

  recordAudit(db, {
    chatId: resolveChatId(db, approval.vault),
    actorNpub: user.npub,
    actorLabel: user.label,
    action: "propose",
    detail: approval.title,
  });

  return NextResponse.json({ approval });
}
