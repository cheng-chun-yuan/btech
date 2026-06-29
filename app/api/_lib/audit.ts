import { randomBytes } from "node:crypto";
import type { DB } from "./db";

export type AuditAction = "propose" | "sign" | "message" | "join";
export type AuditOutcome = "success" | "failed";
export type AuditEntry = {
  id: string;
  chat_id: string;
  actor_npub: string;
  actor_label: string;
  action: AuditAction;
  outcome: AuditOutcome | null;
  detail: string | null;
  created_at: number;
};

export function addMember(db: DB, chatId: string, npub: string): void {
  db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, npub) VALUES (?, ?)").run(chatId, npub);
}

export function isMember(db: DB, chatId: string, npub: string): boolean {
  const signer = db.prepare("SELECT 1 FROM signers WHERE npub = ? LIMIT 1").get(npub);
  if (signer) return true;
  return !!db.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND npub = ?").get(chatId, npub);
}

export function recordAudit(
  db: DB,
  e: {
    chatId: string;
    actorNpub: string;
    actorLabel: string;
    action: AuditAction;
    outcome?: AuditOutcome;
    detail?: string;
  },
): AuditEntry {
  const entry: AuditEntry = {
    id: `a_${randomBytes(6).toString("hex")}`,
    chat_id: e.chatId,
    actor_npub: e.actorNpub,
    actor_label: e.actorLabel,
    action: e.action,
    outcome: e.outcome ?? null,
    detail: e.detail ?? null,
    created_at: Date.now(),
  };
  db.prepare(`
    INSERT INTO audit_log (id, chat_id, actor_npub, actor_label, action, outcome, detail, created_at)
    VALUES (@id, @chat_id, @actor_npub, @actor_label, @action, @outcome, @detail, @created_at)
  `).run(entry);
  addMember(db, e.chatId, e.actorNpub);
  return entry;
}

export function listAudit(db: DB, chatId: string): AuditEntry[] {
  return db
    .prepare("SELECT * FROM audit_log WHERE chat_id = ? ORDER BY created_at DESC, id DESC")
    .all(chatId) as AuditEntry[];
}

export function resolveChatId(db: DB, vaultName: string): string {
  if (vaultName === "#treasury-ops") return "treasury";
  const row = db.prepare("SELECT id FROM chats WHERE name = ?").get(vaultName) as
    | { id: string }
    | undefined;
  return row?.id ?? vaultName;
}
