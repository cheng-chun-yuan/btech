import { randomBytes } from "node:crypto";
import { verifyEvent, nip19 } from "nostr-tools";
import type { Event } from "nostr-tools";

import type { DB } from "./db";

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 min

/** Issue a one-time login challenge nonce. */
export function createChallenge(db: DB): string {
  const nonce = randomBytes(24).toString("hex");
  db.prepare("INSERT INTO auth_challenges (nonce, expires_at) VALUES (?, ?)").run(
    nonce,
    Date.now() + CHALLENGE_TTL_MS,
  );
  return nonce;
}

/** Consume a challenge: true only if it exists and is unexpired. One-time use. */
export function consumeChallenge(db: DB, nonce: string): boolean {
  const row = db.prepare("SELECT expires_at FROM auth_challenges WHERE nonce = ?").get(nonce) as
    | { expires_at: number }
    | undefined;
  if (row) db.prepare("DELETE FROM auth_challenges WHERE nonce = ?").run(nonce);
  return !!row && row.expires_at >= Date.now();
}

/**
 * Verify that `event` is a valid Schnorr-signed Nostr event committing to
 * `nonce`. Returns the proven npub, or null if the proof fails.
 */
export function verifiedNpub(event: Event, nonce: string): string | null {
  try {
    const commits =
      event.tags?.some((t) => t[0] === "challenge" && t[1] === nonce) ||
      (typeof event.content === "string" && event.content.includes(nonce));
    if (!commits) return null;
    if (!verifyEvent(event)) return null;
    return nip19.npubEncode(event.pubkey);
  } catch {
    return null;
  }
}
