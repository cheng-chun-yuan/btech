"use client";

import { C } from "../lib/theme";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: C.faint2, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}
