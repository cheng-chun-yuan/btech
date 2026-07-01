import type { Chat, PolicyConfig, Tier } from "../types";

export function clampNeed(t: Tier): number {
  return Math.max(1, Math.min(t.minNeed, t.keys.length));
}
export function quorumOf(tiers: Tier[]): string {
  return tiers.map((t) => `${clampNeed(t)}/${t.keys.length}`).join(" + ");
}
export function spendOf(tiers: Tier[]): string {
  return "spend = " + tiers.map((t) => `(${clampNeed(t)} of ${t.keys.length} ${t.short})`).join("  AND  ");
}

/** Map the display `tiers` of a chat to the editable `PolicyConfig` the
 * PolicyEditor works on. Each tier becomes a rank (0,1,2…). A display `SignerKey`
 * carries no npub, so we derive the Rust signer id by parsing `k.id` ("k1"→1,
 * "k0-2"→0) and look the npub up from the vault roster by that id; falling back to
 * the slot index + 1 and an empty npub when neither is available. */
export function chatToPolicyConfig(
  chat: Chat,
  roster: { npub: string; label: string; participantId: number }[],
): PolicyConfig {
  const byPid = new Map(roster.map((r) => [r.participantId, r]));
  return {
    tiers: chat.tiers.map((t, i) => ({
      id: t.id,
      name: t.name,
      rank: i,
      required: clampNeed(t),
      signers: t.keys.map((k, j) => {
        const pid = Number.parseInt(k.id.replace(/\D/g, ""), 10) || j + 1;
        const r = byPid.get(pid);
        return { participantId: pid, npub: r?.npub ?? "", label: k.name, rank: i };
      }),
    })),
  };
}
