"use client";

import { useState } from "react";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

type ProfilePopoverProps = {
  npub: string;
  name: string;
  initials: string;
  color: string;
  role?: string;
  isSelf: boolean;
  onStartDm: (npub: string) => void;
  onClose: () => void;
};

export function ProfilePopover({
  npub,
  name,
  initials,
  color,
  role,
  isSelf,
  onStartDm,
  onClose,
}: ProfilePopoverProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(npub).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    // Backdrop: click outside closes.
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 320,
          background: "#15181C",
          border: "1px solid #2A2F36",
          borderRadius: 14,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: color,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              fontWeight: 700,
              color: "#0E1013",
            }}
          >
            {initials}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{name}</div>
            {role && <div style={{ fontSize: 11, color: "#7B828B" }}>{role}</div>}
          </div>
        </div>

        <button
          onClick={copy}
          title="Copy npub"
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: "#9AA1AA",
            background: "#0E1013",
            border: "1px solid #2A2F36",
            borderRadius: 8,
            padding: "8px 10px",
            textAlign: "left",
            cursor: "pointer",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {copied ? "copied ✓" : npub}
        </button>

        {!isSelf && (
          <button
            onClick={() => onStartDm(npub)}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#0E1013",
              background: "#F7931A",
              border: "none",
              borderRadius: 9,
              padding: "9px 12px",
              cursor: "pointer",
            }}
          >
            Direct message
          </button>
        )}
      </div>
    </div>
  );
}
