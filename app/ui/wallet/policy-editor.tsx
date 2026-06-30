"use client";

import { useState } from "react";

import type { PolicyConfig, PolicySigner, PolicyDiffItem } from "./types";

export function diffPolicy(current: PolicyConfig, draft: PolicyConfig): PolicyDiffItem[] {
  const out: PolicyDiffItem[] = [];
  const byRank = (p: PolicyConfig) => new Map(p.tiers.map((t) => [t.rank, t]));
  const cur = byRank(current);
  const drf = byRank(draft);
  for (const [rank, dt] of drf) {
    const ct = cur.get(rank);
    if (!ct) {
      out.push({ kind: "add-tier", text: `+ tier ${dt.name}` });
      continue;
    }
    if (ct.required !== dt.required) {
      out.push({
        kind: "threshold",
        text: `${dt.name} ${ct.required}/${ct.signers.length} → ${dt.required}/${dt.signers.length}`,
      });
    }
    const curIds = new Set(ct.signers.map((s) => s.participantId));
    const drfIds = new Set(dt.signers.map((s) => s.participantId));
    for (const s of dt.signers) if (!curIds.has(s.participantId)) out.push({ kind: "add-signer", text: `+ ${s.label} → ${dt.name}` });
    for (const s of ct.signers) if (!drfIds.has(s.participantId)) out.push({ kind: "remove-signer", text: `− ${s.label} from ${dt.name}` });
  }
  for (const [rank, ct] of cur) if (!drf.has(rank)) out.push({ kind: "remove-tier", text: `− tier ${ct.name}` });
  return out;
}

/** A draft is "bricked" if any tier can never be satisfied, or there are no
 * tiers at all. A 1-of-1 tier is fine; required must stay within [1, n]. */
function isBricked(p: PolicyConfig): boolean {
  return !p.tiers.length || p.tiers.some((t) => t.signers.length === 0 || t.required < 1 || t.required > t.signers.length);
}

export function PolicyEditor({
  current,
  roster,
  onPropose,
}: {
  current: PolicyConfig;
  roster: { npub: string; label: string; participantId: number }[];
  onPropose: (draft: PolicyConfig, diff: PolicyDiffItem[]) => void;
}) {
  const [draft, setDraft] = useState<PolicyConfig>(() => structuredClone(current));
  const diff = diffPolicy(current, draft);
  const bricked = isBricked(draft);

  const setRequired = (tierId: string, delta: number) =>
    setDraft((d) => ({
      tiers: d.tiers.map((t) =>
        t.id !== tierId ? t : { ...t, required: Math.max(1, Math.min(t.required + delta, t.signers.length)) },
      ),
    }));
  const removeSigner = (tierId: string, pid: number) =>
    setDraft((d) => ({
      tiers: d.tiers.map((t) => (t.id !== tierId ? t : { ...t, signers: t.signers.filter((s) => s.participantId !== pid) })),
    }));
  const addSigner = (tierId: string, s: PolicySigner) =>
    setDraft((d) => ({
      tiers: d.tiers.map((t) => (t.id !== tierId ? t : { ...t, signers: [...t.signers, { ...s, rank: t.rank }] })),
    }));
  const removeTier = (tierId: string) => setDraft((d) => ({ tiers: d.tiers.filter((t) => t.id !== tierId) }));
  const addTier = () =>
    setDraft((d) => {
      const rank = d.tiers.length ? Math.max(...d.tiers.map((t) => t.rank)) + 1 : 0;
      return { tiers: [...d.tiers, { id: `t${rank}-${d.tiers.length}`, name: "New tier", rank, required: 1, signers: [] }] };
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {draft.tiers.map((t) => (
        <div key={t.id} style={{ background: "#16181d", border: "1px solid rgba(255,255,255,.08)", borderRadius: 11, padding: "12px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => setRequired(t.id, -1)} aria-label={`decrease ${t.name}`} style={stepBtn}>−</button>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>{t.required} / {t.signers.length}</span>
              <button onClick={() => setRequired(t.id, +1)} aria-label={`increase ${t.name}`} style={stepBtn}>+</button>
              <button onClick={() => removeTier(t.id)} aria-label={`remove tier ${t.name}`} title="Remove tier" style={stepBtn}>×</button>
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {t.signers.map((s) => (
              <span key={s.participantId} style={chip}>
                {s.label}
                <button onClick={() => removeSigner(t.id, s.participantId)} aria-label={`remove ${s.label}`} style={chipX}>×</button>
              </span>
            ))}
            <select
              defaultValue=""
              onChange={(e) => {
                const r = roster.find((x) => String(x.participantId) === e.target.value);
                if (r) addSigner(t.id, { participantId: r.participantId, npub: r.npub, label: r.label, rank: t.rank });
                e.currentTarget.value = "";
              }}
              style={{ ...chip, cursor: "pointer" }}
            >
              <option value="" disabled>+ add signer</option>
              {roster
                .filter((r) => !draft.tiers.some((tt) => tt.signers.some((s) => s.participantId === r.participantId)))
                .map((r) => (
                  <option key={r.participantId} value={r.participantId}>{r.label}</option>
                ))}
            </select>
          </div>
        </div>
      ))}

      <button onClick={addTier} aria-label="add tier" style={addTierBtn}>+ Add tier</button>

      {diff.length > 0 && (
        <div style={{ fontSize: 11.5, color: "#9CA1A7", lineHeight: 1.6 }}>
          {diff.map((d, i) => (
            <div key={i}>{d.text}</div>
          ))}
        </div>
      )}

      {diff.length > 0 && (
        <button
          onClick={() => onPropose(draft, diff)}
          disabled={bricked}
          title={bricked ? "Every tier must be satisfiable" : undefined}
          style={{
            alignSelf: "flex-start",
            background: bricked ? "#3a3d44" : "#F7931A",
            color: bricked ? "#9CA1A7" : "#0A0B0D",
            border: "none",
            borderRadius: 9,
            padding: "9px 18px",
            fontSize: 13,
            fontWeight: 600,
            cursor: bricked ? "not-allowed" : "pointer",
          }}
        >
          Propose policy change
        </button>
      )}
    </div>
  );
}

const stepBtn = {
  width: 24,
  height: 24,
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,.15)",
  background: "transparent",
  color: "#EDEEF0",
  cursor: "pointer",
  fontSize: 15,
} as const;
const chip = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "#1d2026",
  border: "1px solid rgba(255,255,255,.1)",
  borderRadius: 20,
  padding: "4px 10px",
  fontSize: 11.5,
  color: "#EDEEF0",
} as const;
const chipX = { background: "transparent", border: "none", color: "#7C828A", cursor: "pointer", fontSize: 13, padding: 0 } as const;
const addTierBtn = {
  alignSelf: "flex-start",
  background: "transparent",
  border: "1px dashed rgba(255,255,255,.18)",
  borderRadius: 9,
  padding: "8px 14px",
  color: "#9CA1A7",
  cursor: "pointer",
  fontSize: 12.5,
} as const;
