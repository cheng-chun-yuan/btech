"use client";
import { useEffect, useState } from "react";

type Payment = {
  source?: "onchain" | "modeled";
  P: string;
  amount: number;
  vtxId?: string;
  leafIndex?: number;
  txid?: string;
  vout?: number;
  blockHeight?: number;
};

const card: React.CSSProperties = {
  background: "#11151c",
  border: "1px solid #232a36",
  borderRadius: 12,
  padding: 20,
};

export default function StealthPage() {
  const [meta, setMeta] = useState("");
  const [inbound, setInbound] = useState<Payment[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    const r = await fetch("/api/stealth", { cache: "no-store" });
    const j = await r.json();
    setMeta(j.metaAddress);
    setInbound(j.inbound ?? []);
  }
  useEffect(() => {
    void load();
  }, []);

  async function simulate() {
    setBusy(true);
    try {
      const r = await fetch("/api/stealth", { method: "POST" });
      const j = await r.json();
      setInbound(j.inbound ?? []);
    } finally {
      setBusy(false);
    }
  }

  const total = inbound.reduce((s, p) => s + p.amount, 0);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0a0d12",
        color: "#e6e9ef",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        padding: "48px 24px",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>
          Treasury · Stealth receiving
        </h1>
        <p style={{ color: "#8b94a7", margin: "0 0 24px", fontSize: 14 }}>
          One static address. Every inbound payment is unlinkable; the treasury
          detects it with a <strong>view key</strong> alone — never learning the
          one-time key in advance, never able to be linked by third parties.
        </p>

        <div style={{ ...card, marginBottom: 20 }}>
          <div style={{ color: "#8b94a7", fontSize: 12, marginBottom: 8 }}>
            STATIC META-ADDRESS (publish this once)
          </div>
          <div
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              wordBreak: "break-all",
              color: "#7fd1b9",
              lineHeight: 1.6,
            }}
          >
            {meta || "…"}
          </div>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(meta);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            style={{
              marginTop: 12,
              background: "#1b2230",
              color: "#e6e9ef",
              border: "1px solid #2c3445",
              borderRadius: 8,
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>

        <div style={{ ...card }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 16,
            }}
          >
            <div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>Inbound</div>
              <div style={{ color: "#8b94a7", fontSize: 13 }}>
                {inbound.length} payment{inbound.length === 1 ? "" : "s"} ·{" "}
                {total.toLocaleString()} sats detected
              </div>
            </div>
            <button
              onClick={simulate}
              disabled={busy}
              style={{
                background: busy ? "#1b2230" : "#2563eb",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "10px 16px",
                cursor: busy ? "default" : "pointer",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {busy ? "Detecting…" : "Simulate inbound payment"}
            </button>
          </div>

          {inbound.length === 0 ? (
            <div style={{ color: "#6b7385", fontSize: 14, padding: "16px 0" }}>
              No inbound yet. Trigger a payment to this meta-address — the view
              key will detect it.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {inbound.map((p) => (
  <div
    key={(p.txid ?? p.vtxId ?? "") + ":" + p.P}
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      background: "#0d1117",
      border: "1px solid #1c2230",
      borderRadius: 8,
      padding: "10px 14px",
    }}
  >
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.4,
            padding: "2px 6px",
            borderRadius: 4,
            color: p.source === "onchain" ? "#7fd1b9" : "#c7a3ff",
            border: `1px solid ${p.source === "onchain" ? "#2a4d43" : "#3a2d55"}`,
          }}
        >
          {p.source === "onchain" ? "ON-CHAIN L1" : "MODELED"}
        </span>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#8b94a7" }}>
          P {p.P.slice(0, 10)}…{p.P.slice(-6)}
        </span>
      </div>
      {p.txid && (
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#5b6273" }}>
          tx {p.txid.slice(0, 12)}…:{p.vout}
        </span>
      )}
    </div>
    <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 14 }}>
      +{p.amount.toLocaleString()} sats
    </div>
  </div>
))}
            </div>
          )}
        </div>

        <p style={{ color: "#5b6273", fontSize: 12, marginTop: 16 }}>
          Detection runs on a delegated view key (detect-only — it can never spend).
          <strong> ON-CHAIN L1</strong> items are real regtest taproot outputs found by
          block-walking with the view key. <strong>MODELED</strong> items simulate the
          operator stream (the Arkade off-chain rail lands in Phase 2).
        </p>
      </div>
    </main>
  );
}
