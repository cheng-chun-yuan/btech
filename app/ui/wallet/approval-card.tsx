"use client";

import type { CSSProperties } from "react";

import type { Approval } from "./types";

const MONO = "'JetBrains Mono', monospace";

const STATUS = {
  pending: { label: "NEEDS SIGNATURES", color: "#C99A5B", bg: "rgba(247,147,26,.12)", border: "rgba(255,255,255,.07)" },
  ready: { label: "QUORUM REACHED", color: "#3FB950", bg: "rgba(63,185,80,.12)", border: "rgba(63,185,80,.25)" },
  broadcast: { label: "BROADCAST", color: "#3FB950", bg: "rgba(63,185,80,.12)", border: "rgba(255,255,255,.07)" },
  rejected: { label: "REJECTED", color: "#F0616D", bg: "rgba(240,97,109,.12)", border: "rgba(255,255,255,.07)" },
} as const;

type Col = { label: string; val: string; sub: string; font: string; subFont: string };

function columns(a: Approval): Col[] {
  if (a.kind === "role") {
    return [
      { label: "CHANGE", val: a.changeLabel ?? "", sub: a.detail ?? "", font: "inherit", subFont: "inherit" },
      { label: "TIER", val: a.tier ?? "", sub: a.vault, font: "inherit", subFont: "inherit" },
      { label: "REQUESTED", val: a.requestedBy ?? "", sub: a.time, font: "inherit", subFont: "inherit" },
    ];
  }
  return [
    { label: "AMOUNT", val: `${a.btc} BTC`, sub: `$${a.usd}`, font: MONO, subFont: MONO },
    { label: "DESTINATION", val: a.dest ?? "", sub: a.destLabel ?? "", font: MONO, subFont: "inherit" },
    { label: "VAULT", val: a.vault, sub: a.time, font: "inherit", subFont: "inherit" },
  ];
}

function hintFor(a: Approval): string {
  const isRole = a.kind === "role";
  if (a.status === "pending" && a.youSigned) return "You signed. Waiting on other tier members.";
  if (a.status === "pending") {
    const left = a.threshold - a.signed;
    return `${left} more signature${left > 1 ? "s" : ""} needed to reach quorum.`;
  }
  if (a.status === "ready") return isRole ? "Quorum reached. Ready to apply." : "Quorum reached. Ready to broadcast.";
  if (a.status === "broadcast") return isRole ? "Policy reshared — group key and address unchanged." : "Submitted to the Bitcoin network.";
  return isRole ? "This change was rejected." : "This transaction was rejected and will not be broadcast.";
}

const btn = (bg: string, color: string, border = "none"): CSSProperties => ({
  background: bg,
  border,
  color,
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "inherit",
  whiteSpace: "nowrap",
  padding: "9px 18px",
  borderRadius: 9,
  cursor: "pointer",
});

export function ApprovalCard({
  appr,
  busy,
  onSign,
  onReject,
  onBroadcast,
}: {
  appr: Approval;
  busy?: boolean;
  onSign: (id: string) => void;
  onReject: (id: string) => void;
  onBroadcast: (id: string) => void;
}) {
  const st = STATUS[appr.status];
  const isRole = appr.kind === "role";
  const isPending = appr.status === "pending";
  const isReady = appr.status === "ready";
  const done = appr.status === "broadcast" || appr.status === "rejected";
  const pips = Array.from({ length: appr.threshold });

  return (
    <div style={{ background: "#121418", border: `1px solid ${st.border}`, borderRadius: 16, padding: "20px 24px", color: "#EDEEF0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{appr.title}</span>
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: ".3px", color: st.color, background: st.bg, padding: "3px 9px", borderRadius: 20 }}>
          {st.label}
        </span>
        {appr.live && (
          <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: ".4px", color: "#3FB950", background: "rgba(63,185,80,.12)", padding: "3px 8px", borderRadius: 20 }}>
            LIVE DKGKIT
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 22, marginTop: 13, flexWrap: "wrap" }}>
        {columns(appr).map((col) => (
          <div key={col.label}>
            <div style={{ fontSize: 11, color: "#7C828A" }}>{col.label}</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3, color: "#EDEEF0", fontFamily: col.font }}>{col.val}</div>
            <div style={{ fontSize: 11.5, color: "#7C828A", marginTop: 1, fontFamily: col.subFont }}>{col.sub}</div>
          </div>
        ))}
      </div>

      {appr.policyDiff && appr.policyDiff.length > 0 && (
        <div style={{ marginTop: 14, background: "#0E1014", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, padding: "11px 14px" }}>
          <div style={{ fontSize: 10.5, color: "#7C828A", letterSpacing: ".3px", marginBottom: 6 }}>PROPOSED POLICY CHANGE</div>
          {appr.policyDiff.map((d, i) => (
            <div key={i} style={{ fontSize: 12, color: "#C5C9CE", lineHeight: 1.6 }}>{d.text}</div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,.06)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
          <span style={{ fontSize: 12, color: "#9CA1A7" }}>
            Signatures collected <span style={{ color: "#7C828A" }}>· {appr.policy}</span>
          </span>
          <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: st.color }}>
            {appr.signed} / {appr.threshold}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {pips.map((_, i) => (
            <span key={i} style={{ flex: 1, height: 7, borderRadius: 4, background: i < appr.signed ? "#F7931A" : "rgba(255,255,255,.1)" }} />
          ))}
        </div>
      </div>

      {appr.signerSet && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          <div style={{ color: "#8a8f98", marginBottom: 4 }}>
            Chosen signers — {appr.signed}/{appr.signerSet.length} signed
          </div>
          {appr.signerSet.map((s) => (
            <span key={s.npub} style={{ display: "inline-block", marginRight: 8, opacity: 0.9 }}>
              {s.label} · #{s.participantId}
            </span>
          ))}
        </div>
      )}

      {appr.proof && (
        <div style={{ marginTop: 16, background: "#0E1014", border: "1px solid rgba(63,185,80,.25)", borderRadius: 12, padding: "13px 15px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".3px", color: "#3FB950" }}>
              {appr.proof.verified ? "✓ AGGREGATE SIGNATURE VERIFIED (BIP340)" : "✗ VERIFICATION FAILED"}
            </span>
          </div>
          <ProofRow label="GROUP KEY" value={appr.proof.groupKey} />
          <ProofRow label="DIGEST" value={appr.proof.digest} />
          <ProofRow label="AGGREGATE SIG" value={appr.proof.signature} />
          <ProofRow label="SIGNER SET" value={appr.proof.signers.join(", ")} />
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 18, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 11.5, color: "#7C828A" }}>{busy ? "Running grouped HTSS signing round…" : hintFor(appr)}</div>
        <div style={{ display: "flex", gap: 10 }}>
          {isPending && (
            <button onClick={() => onReject(appr.id)} disabled={busy} style={{ ...btn("transparent", "#F0616D", "1px solid rgba(240,97,109,.4)"), opacity: busy ? 0.5 : 1 }}>
              Reject
            </button>
          )}
          {isPending && !appr.youSigned && (
            <button onClick={() => onSign(appr.id)} disabled={busy} style={{ ...btn("#F7931A", "#0A0B0D"), opacity: busy ? 0.6 : 1 }}>
              {busy ? "Signing…" : "Approve & sign"}
            </button>
          )}
          {isReady && (
            <button onClick={() => onBroadcast(appr.id)} disabled={busy} style={btn("#3FB950", "#08130B")}>
              {isRole ? "Apply change" : "Broadcast transaction"}
            </button>
          )}
          {done && (
            <span style={{ fontSize: 13, fontWeight: 600, color: st.color, padding: "9px 4px" }}>
              {appr.status === "broadcast" ? (isRole ? "✓ Applied" : "✓ Broadcast") : "✗ Rejected"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ProofRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginTop: 4 }}>
      <span style={{ fontSize: 9.5, color: "#7C828A", flex: "0 0 92px", letterSpacing: ".3px" }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 11, color: "#9CA1A7", wordBreak: "break-all", lineHeight: 1.5 }}>{value}</span>
    </div>
  );
}
