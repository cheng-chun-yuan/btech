import { randomBytes } from "node:crypto";

import type { DB } from "./db";
import { addMember, recordAudit } from "./audit";
import { initialsFor, colorForNpub } from "./avatar";

export type Member = {
  npub: string;
  label: string;
  role: string;
  initials: string;
  color: string;
};

/** Strict membership: only `chat_members` (unlike audit.isMember, which treats
 * any signer as a member of every chat). Used for DM privacy gates. */
export function isChatMember(db: DB, chatId: string, npub: string): boolean {
  return !!db.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND npub = ?").get(chatId, npub);
}

export function resolveIdentity(db: DB, npub: string): { label: string; role: string } {
  const u = db.prepare("SELECT label, role FROM users WHERE npub = ?").get(npub) as
    | { label: string; role: string }
    | undefined;
  if (u) return u;
  const s = db.prepare("SELECT label, role FROM signers WHERE npub = ? LIMIT 1").get(npub) as
    | { label: string; role: string }
    | undefined;
  if (s) return s;
  return { label: `${npub.slice(0, 11)}…`, role: "Observer" };
}

export function listChatMembers(db: DB, chatId: string): Member[] {
  const rows = db.prepare("SELECT npub FROM chat_members WHERE chat_id = ?").all(chatId) as
    { npub: string }[];
  return rows.map(({ npub }) => {
    const { label, role } = resolveIdentity(db, npub);
    return { npub, label, role, initials: initialsFor(label), color: colorForNpub(npub) };
  });
}

/** Existing direct chat whose membership is exactly {a, b}, else null. */
export function findDirectChat(db: DB, a: string, b: string): string | null {
  const row = db
    .prepare(`
      SELECT c.id AS id FROM chats c
      WHERE c.type = 'direct'
        AND (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id) = 2
        AND EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.npub = ?)
        AND EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.npub = ?)
      LIMIT 1
    `)
    .get(a, b) as { id: string } | undefined;
  return row?.id ?? null;
}

export function directCounterparty(db: DB, chatId: string, meNpub: string): string | null {
  const row = db
    .prepare("SELECT npub FROM chat_members WHERE chat_id = ? AND npub != ? LIMIT 1")
    .get(chatId, meNpub) as { npub: string } | undefined;
  return row?.npub ?? null;
}

export function createOrFindDirectChat(
  db: DB,
  me: { npub: string; label: string },
  targetNpub: string,
): { id: string; created: boolean } {
  const existing = findDirectChat(db, me.npub, targetNpub);
  if (existing) return { id: existing, created: false };

  const id = `dm_${randomBytes(5).toString("hex")}`;
  const { label: targetLabel } = resolveIdentity(db, targetNpub);
  const meta = {
    id,
    type: "direct",
    name: targetLabel,
    members: 2,
    balanceBtc: "0.00",
    balanceUsd: "0",
    initials: initialsFor(targetLabel),
    color: colorForNpub(targetNpub),
    tiers: [],
  };
  db.prepare("INSERT INTO chats (id, type, name, data_json) VALUES (?, ?, ?, ?)").run(
    id,
    "direct",
    targetLabel,
    JSON.stringify(meta),
  );
  addMember(db, id, me.npub);
  addMember(db, id, targetNpub);
  recordAudit(db, {
    chatId: id,
    actorNpub: me.npub,
    actorLabel: me.label,
    action: "join",
    detail: `Opened DM with ${targetLabel}`,
  });
  return { id, created: true };
}
