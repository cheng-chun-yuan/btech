import { NextResponse } from "next/server";

import { getDb } from "../_lib/db";
import type { Chat, ChatMessage } from "../../ui/wallet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const chatRows = db.prepare("SELECT id, data_json FROM chats").all() as
    { id: string; data_json: string }[];
  const msgStmt = db.prepare(
    "SELECT id, who, handle, initials, color, time, text, signed, zaps FROM messages WHERE chat_id = ? ORDER BY created_at",
  );
  const chats: Chat[] = chatRows.map((row) => {
    const meta = JSON.parse(row.data_json) as Omit<Chat, "messages">;
    const messages = (msgStmt.all(row.id) as Record<string, unknown>[]).map((m) => ({
      ...m,
      signed: !!m.signed,
    })) as unknown as ChatMessage[];
    return { ...meta, messages };
  });
  return NextResponse.json({ chats });
}
