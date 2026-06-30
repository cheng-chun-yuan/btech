import { nip19, finalizeEvent } from "nostr-tools";
import type { Event, EventTemplate } from "nostr-tools";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: EventTemplate): Promise<Event>;
      nip44?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>;
        decrypt(pubkey: string, ciphertext: string): Promise<string>;
      };
    };
  }
}

export interface NostrSigner {
  encrypt(counterpartyNpub: string, plaintext: string): Promise<string>;
  decrypt(counterpartyNpub: string, ciphertext: string): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
}

function pubHexFromNpub(npub: string): string {
  const d = nip19.decode(npub);
  if (d.type !== "npub" || typeof d.data !== "string") throw new Error("not an npub");
  return d.data;
}

/** Encrypt/decrypt with a locally-held secret key (demo persona or nsec). */
export class LocalKeySigner implements NostrSigner {
  constructor(private readonly secretKey: Uint8Array) {}
  private convKey(counterpartyNpub: string): Uint8Array {
    return getConversationKey(this.secretKey, pubHexFromNpub(counterpartyNpub));
  }
  async encrypt(counterpartyNpub: string, plaintext: string): Promise<string> {
    return encrypt(plaintext, this.convKey(counterpartyNpub));
  }
  async decrypt(counterpartyNpub: string, ciphertext: string): Promise<string> {
    return decrypt(ciphertext, this.convKey(counterpartyNpub));
  }
  async signEvent(template: EventTemplate): Promise<Event> {
    return finalizeEvent(template, this.secretKey);
  }
}

/** Encrypt/decrypt via a NIP-07 browser extension that supports nip44. */
export class Nip07Signer implements NostrSigner {
  async encrypt(counterpartyNpub: string, plaintext: string): Promise<string> {
    if (!window.nostr?.nip44) throw new Error("NIP-07 extension lacks nip44 support");
    return window.nostr.nip44.encrypt(pubHexFromNpub(counterpartyNpub), plaintext);
  }
  async decrypt(counterpartyNpub: string, ciphertext: string): Promise<string> {
    if (!window.nostr?.nip44) throw new Error("NIP-07 extension lacks nip44 support");
    return window.nostr.nip44.decrypt(pubHexFromNpub(counterpartyNpub), ciphertext);
  }
  async signEvent(template: EventTemplate): Promise<Event> {
    if (!window.nostr) throw new Error("No NIP-07 extension");
    return window.nostr.signEvent(template);
  }
}

/** Deterministic demo-persona secret. Mirrors the server's `deterministicSecret`
 * and login-form's `personaSecret`. */
export async function personaSecret(participantId: number): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`btech-signer-v1:${participantId}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

const SK_KEY = "btech_dm_sk";

function toHex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Stash an nsec secret for the browser session (cleared on logout / tab close).
 * Demo-only: sessionStorage is XSS-readable; acceptable for this app. */
export function stashSecretKey(sk: Uint8Array): void {
  try {
    sessionStorage.setItem(SK_KEY, toHex(sk));
  } catch {
    /* storage unavailable — DM will fall back to NIP-07 or be disabled */
  }
}
export function clearStashedKey(): void {
  try {
    sessionStorage.removeItem(SK_KEY);
  } catch {
    /* ignore */
  }
}
function readStashedKey(): Uint8Array | null {
  try {
    const hex = sessionStorage.getItem(SK_KEY);
    return hex ? fromHex(hex) : null;
  } catch {
    return null;
  }
}

/** Pick the best available signer for the logged-in user, or null if none
 * (e.g. nsec login with no stash and no nip44-capable extension). */
export async function resolveSigner(
  me: { npub: string; participant_id: number | null },
): Promise<NostrSigner | null> {
  if (me.participant_id != null) return new LocalKeySigner(await personaSecret(me.participant_id));
  const stashed = readStashedKey();
  if (stashed) return new LocalKeySigner(stashed);
  if (typeof window !== "undefined" && window.nostr?.nip44) return new Nip07Signer();
  return null;
}
