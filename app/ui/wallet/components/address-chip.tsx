"use client";

import { useEffect, useState } from "react";
import { C, MONO } from "../lib/theme";

// ===========================================================================
// Address chip — compact receive address with copy, shown in the chat header
// ===========================================================================

export function AddressChip({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const short = `${address.slice(0, 8)}…${address.slice(-5)}`;
  const copy = () => {
    navigator.clipboard?.writeText(address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <button
      onClick={copy}
      title={copied ? "Copied" : `Copy ${address}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: C.surface2,
        border: `1px solid ${copied ? "rgba(63,185,80,.4)" : C.line2}`,
        color: copied ? C.green : "#9CA1A7",
        fontFamily: MONO,
        fontSize: 11.5,
        fontWeight: 500,
        padding: "3px 9px",
        borderRadius: 7,
        cursor: "pointer",
      }}
    >
      {copied ? "Copied" : short}
      <span aria-hidden style={{ fontSize: 12 }}>
        {copied ? "✓" : "⧉"}
      </span>
    </button>
  );
}

// The treasury's one reusable BIP-352 silent-payment address (tsp1…). Shown next
// to the L1/Arkade receive address so anyone can copy it — one static address,
// every payment to it lands on a fresh, unlinkable output. Fetched once from
// /api/stealth (the published meta-address; B_scan‖B_spend).
export function MetaAddressChip() {
  const [meta, setMeta] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/stealth")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { metaAddress?: string } | null) => {
        if (alive && d?.metaAddress) setMeta(d.metaAddress);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!meta) return null;
  const short = `${meta.slice(0, 10)}…${meta.slice(-5)}`;
  const copy = () => {
    navigator.clipboard?.writeText(meta).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <button
      onClick={copy}
      title={copied ? "Copied" : `Silent-payment address — one reusable BIP-352 address, every payment unlinkable. Copy:\n${meta}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "rgba(167,139,250,.08)",
        border: `1px solid ${copied ? "rgba(63,185,80,.4)" : "rgba(167,139,250,.35)"}`,
        color: copied ? C.green : "#C4B5FD",
        fontFamily: MONO,
        fontSize: 11.5,
        fontWeight: 500,
        padding: "3px 9px",
        borderRadius: 7,
        cursor: "pointer",
        maxWidth: "100%",
      }}
    >
      <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".4px", color: "#A78BFA", background: "rgba(167,139,250,.16)", padding: "1px 5px", borderRadius: 20 }}>STEALTH</span>
      {copied ? "Copied" : short}
      <span aria-hidden style={{ fontSize: 12 }}>{copied ? "✓" : "⧉"}</span>
    </button>
  );
}
