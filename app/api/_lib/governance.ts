import type { DB } from "./db";
import { listSigners } from "./identity";
import type { SelectedSigner } from "../../ui/wallet/types";

/** Canonical policy-valid minimal set for the (1,2,3)-of-(2,3,5) vault:
 * 1 C-level + 2 managers + 3 operators. */
export const DEFAULT_VALID_PARTICIPANT_IDS = [1, 3, 4, 6, 7, 8];

/** Resolve picked npubs to a signer set. Every npub must be a registered signer
 * (a row in `signers`); otherwise this throws. Order follows participant id. */
export function resolveSignerSet(db: DB, npubs: string[]): SelectedSigner[] {
  const roster = new Map(listSigners(db).map((s) => [s.npub, s]));
  const picked = npubs.map((npub) => {
    const s = roster.get(npub);
    if (!s) throw new Error(`not a registered signer: ${npub}`);
    return { participantId: s.participant_id, npub: s.npub, label: s.label };
  });
  return picked.sort((a, b) => a.participantId - b.participantId);
}

/** The default selection offered at propose time: the canonical valid set,
 * resolved from the live roster. Empty when the vault has no signer roster. */
export function defaultSignerSet(db: DB): SelectedSigner[] {
  const roster = new Map(listSigners(db).map((s) => [s.participant_id, s]));
  return DEFAULT_VALID_PARTICIPANT_IDS.flatMap((pid) => {
    const s = roster.get(pid);
    return s ? [{ participantId: s.participant_id, npub: s.npub, label: s.label }] : [];
  });
}

export function isSelectedSigner(signerSet: SelectedSigner[] | undefined, npub: string): boolean {
  return !!signerSet?.some((s) => s.npub === npub);
}

export function signedNpubs(db: DB, approvalId: string): Set<string> {
  const rows = db
    .prepare("SELECT npub FROM approval_signatures WHERE approval_id = ?")
    .all(approvalId) as { npub: string }[];
  return new Set(rows.map((r) => r.npub));
}

export function allSelectedSigned(signerSet: SelectedSigner[], signed: Set<string>): boolean {
  return signerSet.length > 0 && signerSet.every((s) => signed.has(s.npub));
}
