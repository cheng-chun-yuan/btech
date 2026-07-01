"use client";

import { C, MONO } from "../lib/theme";

export function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button onClick={onClick} style={{ position: "relative", overflow: "hidden", border: "none", background: "transparent", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", color: active ? C.bg : "#9CA1A7", display: "flex", alignItems: "center", gap: 9 }}>
      {active && <span style={{ position: "absolute", inset: 0, background: C.orange, borderRadius: 8, zIndex: 0 }} />}
      <span style={{ position: "relative", zIndex: 1 }}>{label}</span>
      <span style={{ position: "relative", zIndex: 1, fontFamily: MONO, fontSize: 11, opacity: 0.75 }}>{count}</span>
    </button>
  );
}
