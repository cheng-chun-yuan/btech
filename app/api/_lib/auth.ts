import { randomBytes } from "node:crypto";

import type { DB } from "./db";

export const SESSION_COOKIE = "btech_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

export function createSession(db: DB, npub: string): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token, npub, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, npub, now, now + SESSION_TTL_MS);
  return token;
}

export function getSessionUser(
  db: DB,
  token: string | undefined,
): { npub: string; label: string; role: string } | null {
  if (!token) return null;
  const row = db
    .prepare(`
      SELECT u.npub AS npub, u.label AS label, u.role AS role, s.expires_at AS expires_at
      FROM sessions s JOIN users u ON u.npub = s.npub
      WHERE s.token = ?
    `)
    .get(token) as { npub: string; label: string; role: string; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    deleteSession(db, token);
    return null;
  }
  return { npub: row.npub, label: row.label, role: row.role };
}

export function deleteSession(db: DB, token: string | undefined): void {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
