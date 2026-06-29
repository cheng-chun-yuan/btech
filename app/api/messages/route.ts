import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";

import { getDb } from "../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../_lib/auth";
import { recordAudit } from "../_lib/audit";
import type { ChatMessage } from "../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const db = getDb();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = getSessionUser(db, token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { chatId, text } = (await request.json().catch(() => ({}))) as {
    chatId?: string;
    text?: string;
  };
  if (!chatId || !text?.trim()) {
    return NextResponse.json({ error: "chatId and text required" }, { status: 400 });
  }
  const exists = db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId);
  if (!exists) return NextResponse.json({ error: "Unknown chat" }, { status: 404 });

  const initials = user.label
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const message: ChatMessage = {
    id: `m_${randomBytes(6).toString("hex")}`,
    who: user.label,
    handle: `${user.npub.slice(0, 12)}…`,
    initials,
    color: "#F7931A",
    time: "now",
    text: text.trim(),
    signed: false,
    zaps: "",
  };
  db.prepare(`
    INSERT INTO messages (id, chat_id, author_npub, who, handle, initials, color, time, text, signed, zaps, created_at)
    VALUES (@id, @chat_id, @author_npub, @who, @handle, @initials, @color, @time, @text, 0, @zaps, @created_at)
  `).run({ ...message, chat_id: chatId, author_npub: user.npub, signed: 0, created_at: Date.now() });

  recordAudit(db, {
    chatId,
    actorNpub: user.npub,
    actorLabel: user.label,
    action: "message",
    detail: text.trim().slice(0, 80),
  });

  return NextResponse.json({ message });
}
