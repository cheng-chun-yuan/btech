import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";

import { getDb } from "../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../_lib/auth";
import { addMember, recordAudit } from "../_lib/audit";
import { runDemo } from "../_lib/btech";
import { directCounterparty, resolveIdentity, filterVisibleChats } from "../_lib/dm";
import { initialsFor, colorForNpub } from "../_lib/avatar";
import type { Chat, ChatMessage } from "../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const chatRows = db.prepare("SELECT id, data_json FROM chats").all() as
    { id: string; data_json: string }[];
  const msgStmt = db.prepare(
    "SELECT id, who, handle, initials, color, time, text, signed, zaps, author_npub AS authorNpub FROM messages WHERE chat_id = ? ORDER BY created_at",
  );
  const chats: Chat[] = chatRows.map((row) => {
    const meta = JSON.parse(row.data_json) as Omit<Chat, "messages">;
    const messages = (msgStmt.all(row.id) as Record<string, unknown>[]).map((m) => ({
      ...m,
      signed: !!m.signed,
    })) as unknown as ChatMessage[];
    return { ...meta, messages };
  });

  // Back any active vault channel that lacks a receive address (the cold/petty
  // seed channels ship without one) with its own real DKG vault. Each id gets a
  // distinct, stable Taproot address from vaultd; we derive it once and persist
  // it so the channel is fundable on regtest and later loads are instant.
  const unprovisioned = chats.filter(
    (c) => c.type === "channel" && c.vaultStatus === "active" && !c.receiveAddress,
  );
  if (unprovisioned.length > 0) {
    const update = db.prepare("UPDATE chats SET data_json = ? WHERE id = ?");
    await Promise.all(
      unprovisioned.map(async (c) => {
        try {
          c.receiveAddress = (await runDemo(c.id)).receive_address;
          const { messages: _messages, ...meta } = c;
          update.run(JSON.stringify(meta), c.id);
        } catch {
          // vaultd unreachable → leave it unprovisioned; the client treats a
          // missing address as 0 balance and we retry on the next load.
        }
      }),
    );
  }

  // Resolve the viewer so we can hide DMs they're not in and label each DM with
  // the *other* participant (the stored name is from the creator's POV).
  const viewer = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  const visible = filterVisibleChats(db, viewer?.npub ?? null, chats);
  if (viewer) {
    for (const c of visible) {
      if (c.type !== "direct") continue;
      const other = directCounterparty(db, c.id, viewer.npub);
      if (!other) continue;
      const { label } = resolveIdentity(db, other);
      c.counterpartyNpub = other;
      c.name = label;
      c.initials = initialsFor(label);
      c.color = colorForNpub(other);
    }
  }

  return NextResponse.json({ chats: visible });
}

/** Create a channel (group vault) and provision a real receive address. */
export async function POST(request: Request) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = (await request.json().catch(() => ({}))) as { name?: string };
  const clean = name?.trim().replace(/^#/, "");
  if (!clean) return NextResponse.json({ error: "name required" }, { status: 400 });

  const id = `ch_${randomBytes(5).toString("hex")}`;
  let receiveAddress: string;
  try {
    // Each channel gets its own DKG vault (distinct group key + address).
    receiveAddress = (await runDemo(id)).receive_address;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "vault provisioning failed" },
      { status: 502 },
    );
  }
  const initials = user.label.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  const chat: Omit<Chat, "messages"> = {
    id,
    type: "channel",
    name: `#${clean}`,
    desc: "Group vault",
    members: 1,
    balanceBtc: "0.00",
    balanceUsd: "0",
    vaultStatus: "active",
    receiveAddress,
    tiers: [
      {
        id: "signers",
        name: "Signers",
        short: "Signers",
        minNeed: 1,
        keys: [{ id: "creator", initials, name: `${user.label} (you)`, device: "DKGKit share", status: "online" }],
      },
    ],
  };

  db.prepare("INSERT INTO chats (id, type, name, data_json) VALUES (?, ?, ?, ?)").run(
    id,
    chat.type,
    chat.name,
    JSON.stringify(chat),
  );
  addMember(db, id, user.npub);
  recordAudit(db, {
    chatId: id,
    actorNpub: user.npub,
    actorLabel: user.label,
    action: "propose",
    outcome: "success",
    detail: `Created channel ${chat.name}`,
  });

  return NextResponse.json({ chat });
}
