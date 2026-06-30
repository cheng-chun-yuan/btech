import type { PolicyConfig, SignerKey, Tier } from "../../ui/wallet/types";

/**
 * Project an authoritative {@link PolicyConfig} onto the wallet UI's display
 * {@link Tier}[] shape. This is the mirror applied to a chat's `data_json` after
 * a reshare is authorized: each policy tier becomes a display tier (`required` →
 * `minNeed`, first three letters → `short`), and each policy signer becomes a
 * display key. The receive address is unchanged by a reshare, so only the tiers
 * (and the caller's `policyVersion` bump) move.
 *
 * Pure + side-effect free so the easy-to-get-wrong mapping can be unit-tested
 * without a DB/session/vaultd.
 */
export function policyToDisplayTiers(p: PolicyConfig): Tier[] {
  return p.tiers.map((t) => ({
    id: t.id,
    name: t.name,
    short: t.name.slice(0, 3).toUpperCase(),
    minNeed: t.required,
    keys: t.signers.map(
      (s): SignerKey => ({
        id: `k${s.participantId}`,
        initials: s.label.slice(0, 2).toUpperCase(),
        name: s.label,
        device: "Active",
        status: "online",
      }),
    ),
  }));
}
