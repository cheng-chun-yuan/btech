"use client";

import { useEffect, useState } from "react";
import { nip19, getPublicKey } from "nostr-tools";

type Persona = { npub: string; label: string; role: string; participant_id: number };

const C = {
  bg: "#0A0B0D",
  surface: "#121418",
  line: "rgba(255,255,255,.08)",
  ink: "#EDEEF0",
  muted: "#A9AEB4",
  orange: "#F7931A",
  red: "#F0616D",
};
const MONO = "'JetBrains Mono', monospace";

declare global {
  interface Window {
    nostr?: { getPublicKey(): Promise<string> };
  }
}

export default function LoginForm() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [nsec, setNsec] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/personas")
      .then((r) => r.json())
      .then((d) => setPersonas(d.personas ?? []))
      .catch(() => setPersonas([]));
  }, []);

  async function login(npub: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npub }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Login failed");
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
      setBusy(false);
    }
  }

  async function connectNip07() {
    try {
      if (!window.nostr) throw new Error("No NIP-07 extension found (try Alby or nos2x)");
      const hex = await window.nostr.getPublicKey();
      await login(nip19.npubEncode(hex));
    } catch (e) {
      setError(e instanceof Error ? e.message : "NIP-07 connect failed");
    }
  }

  function loginWithNsec() {
    try {
      const dec = nip19.decode(nsec.trim());
      if (dec.type !== "nsec") throw new Error("Not an nsec key");
      const hex = getPublicKey(dec.data as Uint8Array);
      void login(nip19.npubEncode(hex));
    } catch {
      setError("Invalid nsec");
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: C.bg,
        color: C.ink,
        display: "grid",
        placeItems: "center",
        fontFamily: "'Space Grotesk', system-ui, sans-serif",
        padding: 20,
      }}
    >
      <div style={{ width: 380, padding: 28, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>BTech DKGKit Console</h1>
        <p style={{ color: C.muted, fontSize: 13, marginTop: 6 }}>
          Sign in with a Nostr key to access the vault.
        </p>

        <button onClick={connectNip07} disabled={busy} style={btn(C.orange, "#0A0B0D")}>
          Connect Nostr extension
        </button>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input
            value={nsec}
            onChange={(e) => setNsec(e.target.value)}
            placeholder="nsec1…"
            aria-label="nsec private key"
            style={{
              flex: 1,
              padding: "10px 12px",
              background: C.bg,
              border: `1px solid ${C.line}`,
              borderRadius: 8,
              color: C.ink,
              fontFamily: MONO,
              fontSize: 12,
            }}
          />
          <button onClick={loginWithNsec} disabled={busy || !nsec} style={btn("transparent", C.ink, C.line)}>
            Use
          </button>
        </div>

        {personas.length > 0 && (
          <>
            <div
              style={{
                color: C.muted,
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 1,
                margin: "18px 0 8px",
              }}
            >
              Demo personas
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {personas.map((p) => (
                <button
                  key={p.npub}
                  onClick={() => login(p.npub)}
                  disabled={busy}
                  style={{ ...btn(C.bg, C.ink, C.line), display: "flex", justifyContent: "space-between" }}
                >
                  <span>{p.label}</span>
                  <span style={{ color: C.muted, fontFamily: MONO, fontSize: 11 }}>
                    {p.role} · #{p.participant_id}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {error && (
          <p role="alert" style={{ color: C.red, fontSize: 12, marginTop: 14 }}>
            ⚠ {error}
          </p>
        )}
      </div>
    </main>
  );
}

function btn(bg: string, fg: string, border = "transparent") {
  return {
    width: "100%",
    marginTop: 10,
    padding: "11px 14px",
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    borderRadius: 9,
    fontSize: 13,
    cursor: "pointer",
  } as const;
}
