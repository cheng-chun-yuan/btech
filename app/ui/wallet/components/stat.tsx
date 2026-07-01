"use client";

import { C, MONO } from "../lib/theme";

export function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.faint2 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 14, marginTop: 3, color: color ?? C.ink }}>{value}</div>
    </div>
  );
}
