import type { CSSProperties } from "react";

export const C = {
  bg: "#0A0B0D",
  sidebar: "#0C0D10",
  surface: "#121418",
  surface2: "#15171B",
  ink: "#EDEEF0",
  muted: "#A9AEB4",
  faint: "#6B7178",
  faint2: "#7C828A",
  line: "rgba(255,255,255,.06)",
  line2: "rgba(255,255,255,.07)",
  orange: "#F7931A",
  orangeSoft: "rgba(247,147,26,.12)",
  green: "#3FB950",
  red: "#F0616D",
  sand: "#C99A5B",
};
export const MONO = "'JetBrains Mono', monospace";
export const SANS = "'Space Grotesk', system-ui, sans-serif";

export const inputStyle: CSSProperties = {
  width: "100%",
  background: C.surface2,
  border: "1px solid rgba(255,255,255,.1)",
  color: C.ink,
  borderRadius: 8,
  padding: "9px 10px",
  fontSize: 12.5,
  fontFamily: "inherit",
  outline: "none",
};
