import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../_lib/auth";
import { createOrFindDirectChat } from "../_lib/dm";
import { isValidNpub } from "../_lib/identity";
import type { Chat, ChatMessage } from "../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Find or create a 1:1 direct chat with `targetNpub`. */
export async function POST(request: Request) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { targetNpub } = (await request.json().catch(() => ({}))) as { targetNpub?: string };
  if (!targetNpub || !isValidNpub(targetNpub)) {
    return NextResponse.json({ error: "valid targetNpub required" }, { status: 400 });
  }
  if (targetNpub === user.npub) {
    return NextResponse.json({ error: "cannot DM yourself" }, { status: 400 });
  }

  const { id } = createOrFindDirectChat(db, user, targetNpub);

  const row = db.prepare("SELECT data_json FROM chats WHERE id = ?").get(id) as { data_json: string };
  const meta = JSON.parse(row.data_json) as Omit<Chat, "messages">;
  const msgs = db
    .prepare(
      "SELECT id, who, handle, initials, color, time, text, signed, zaps, author_npub AS authorNpub FROM messages WHERE chat_id = ? ORDER BY created_at",
    )
    .all(id) as Record<string, unknown>[];
  const messages = msgs.map((m) => ({ ...m, signed: !!m.signed })) as unknown as ChatMessage[];
  const chat: Chat = { ...meta, counterpartyNpub: targetNpub, messages };

  return NextResponse.json({ chat });
}
