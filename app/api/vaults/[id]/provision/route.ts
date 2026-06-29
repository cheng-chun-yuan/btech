import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { recordAudit } from "../../../_lib/audit";
import { runDemo } from "../../../_lib/btech";
import type { Chat } from "../../../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Provision a shared vault for a chat that does not have one yet (e.g. a DM that
 * starts as plain chat). Runs DKG in Rust to derive a real Taproot receive
 * address and flips the chat to an active 2-of-2 vault.
 */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = db.prepare("SELECT id, data_json FROM chats WHERE id = ?").get(id) as
    | { id: string; data_json: string }
    | undefined;
  if (!row) return NextResponse.json({ error: "Unknown chat" }, { status: 404 });

  const chat = JSON.parse(row.data_json) as Omit<Chat, "messages">;
  if (chat.vaultStatus === "active") {
    return NextResponse.json({ chat });
  }

  let receiveAddress: string;
  try {
    const report = await runDemo(id); // this DM's own DKG vault
    receiveAddress = report.receive_address;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Vault provisioning failed" },
      { status: 502 },
    );
  }

  const peer = chat.name ?? "Counterparty";
  const peerInitials = peer
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const updated: Omit<Chat, "messages"> = {
    ...chat,
    vaultStatus: "active",
    receiveAddress,
    tiers:
      chat.tiers && chat.tiers.length > 0
        ? chat.tiers
        : [
            {
              id: "pair",
              name: "Both parties",
              short: "Pair",
              minNeed: 2,
              keys: [
                { id: "you", initials: "··", name: `${user.label} (you)`, device: "DKGKit share", status: "online" },
                { id: "peer", initials: peerInitials, name: peer, device: "DKGKit share", status: "online" },
              ],
            },
          ],
  };

  db.prepare("UPDATE chats SET data_json = ? WHERE id = ?").run(JSON.stringify(updated), id);

  recordAudit(db, {
    chatId: id,
    actorNpub: user.npub,
    actorLabel: user.label,
    action: "propose",
    outcome: "success",
    detail: "Provisioned a 2-of-2 shared vault",
  });

  return NextResponse.json({ chat: updated });
}
