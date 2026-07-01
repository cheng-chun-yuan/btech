"use client";

import { C, MONO } from "../lib/theme";
import type { WalletState } from "../types";

export function LiveVaultCard({ wstate }: { wstate: WalletState }) {
  const { demo, session } = wstate;
  return (
    <div style={{ background: C.surface, border: "1px solid rgba(63,185,80,.25)", borderRadius: 16, padding: "20px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Live DKGKit vault</span>
        <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: ".4px", color: C.green, background: "rgba(63,185,80,.12)", padding: "3px 8px", borderRadius: 20 }}>
          {demo.verified ? "VERIFIED" : "UNVERIFIED"}
        </span>
        <span style={{ fontSize: 11, color: C.faint2 }}>{demo.network} · {session.htss.threshold}</span>
      </div>
      <div style={{ fontSize: 10.5, color: C.faint2, letterSpacing: ".3px" }}>Receive address</div>
      <div style={{ fontFamily: MONO, fontSize: 13, color: C.ink, marginTop: 4, wordBreak: "break-all" }}>
        {demo.receive_address}
      </div>
      <div style={{ fontSize: 11.5, color: C.faint2, marginTop: 14, lineHeight: 1.5 }}>
        Secured by a <span style={{ color: "#C5C9CE", fontFamily: MONO }}>{session.htss.threshold}</span> grouped
        threshold. No single signer can move funds — every spend needs a quorum from each tier.
      </div>
    </div>
  );
}
