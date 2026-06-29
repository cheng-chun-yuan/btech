import { createHash } from "node:crypto";
import { nip19 } from "nostr-tools";

import type { DB } from "./db";

const VAULT_ID = "treasury";

export function isValidNpub(npub: string): boolean {
  try {
    const d = nip19.decode(npub);
    return d.type === "npub" && typeof d.data === "string" && d.data.length === 64;
  } catch {
    return false;
  }
}

export function normalizeNpub(input: string): string | null {
  const s = input.trim();
  if (s.startsWith("npub1")) return isValidNpub(s) ? s : null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    try {
      return nip19.npubEncode(s.toLowerCase());
    } catch {
      return null;
    }
  }
  return null;
}

export function deterministicNpub(participantId: number): string {
  const hex = createHash("sha256").update(`btech-signer-v1:${participantId}`).digest("hex");
  return nip19.npubEncode(hex);
}

type Invite = { participant_id: number; label: string; role: string };

export function syncSigners(db: DB, invites: Invite[]): void {
  const upsertUser = db.prepare(`
    INSERT INTO users (npub, label, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(npub) DO UPDATE SET label=excluded.label, role=excluded.role
  `);
  const upsertSigner = db.prepare(`
    INSERT INTO signers (vault_id, participant_id, npub, label, role) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(vault_id, participant_id) DO UPDATE SET npub=excluded.npub, label=excluded.label, role=excluded.role
  `);
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const inv of invites) {
      const npub = deterministicNpub(inv.participant_id);
      upsertUser.run(npub, inv.label, inv.role, now);
      upsertSigner.run(VAULT_ID, inv.participant_id, npub, inv.label, inv.role);
    }
  });
  tx();
}

export function listSigners(
  db: DB,
): { npub: string; label: string; role: string; participant_id: number }[] {
  return db
    .prepare("SELECT npub, label, role, participant_id FROM signers WHERE vault_id = ? ORDER BY participant_id")
    .all(VAULT_ID) as { npub: string; label: string; role: string; participant_id: number }[];
}
