import type { PolicyConfig } from "../../ui/wallet/types";

/** A policy is "bricked" if it can never reach quorum — it has no tiers, or some
 *  tier has zero signers, `required < 1`, or `required > signers.length`. Such a
 *  policy would freeze the vault permanently, so it is hard-blocked (not merely
 *  warned). A still-satisfiable-but-weak policy (e.g. 1-of-1) is allowed. */
export function isBrickedPolicy(p: PolicyConfig): boolean {
  if (!p.tiers.length) return true;
  return p.tiers.some(
    (t) => t.signers.length === 0 || t.required < 1 || t.required > t.signers.length,
  );
}
