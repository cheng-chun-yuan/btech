"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { ApprovalCard } from "./approval-card";
import {
  BTC_USD,
  buildLiveApproval,
  buildLiveVault,
} from "./data";
import type {
  Approval,
  Chat,
  ChatMessage,
  SignerKey,
  Tier,
  WalletState,
} from "./types";

const C = {
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
const MONO = "'JetBrains Mono', monospace";
const SANS = "'Space Grotesk', system-ui, sans-serif";

type View = "overview" | "approvals" | "chat" | "plan";
type Tab = "send" | "admin";

type AuditEntryUI = {
  id: string;
  actor_label: string;
  action: "propose" | "sign" | "message" | "join";
  detail: string | null;
  created_at: number;
};

const STATUS_COLOR: Record<SignerKey["status"], string> = {
  online: "#3FB950",
  reattesting: "#E0A23C",
  proposed: "#F7931A",
};

function clampNeed(t: Tier): number {
  return Math.max(1, Math.min(t.minNeed, t.keys.length));
}
function quorumOf(tiers: Tier[]): string {
  return tiers.map((t) => `${clampNeed(t)}/${t.keys.length}`).join(" + ");
}
function spendOf(tiers: Tier[]): string {
  return "spend = " + tiers.map((t) => `(${clampNeed(t)} of ${t.keys.length} ${t.short})`).join("  AND  ");
}
function statusLabelOf(k: SignerKey): string {
  if (k.statusText) return k.statusText;
  if (k.status === "reattesting") return "Re-attesting";
  if (k.status === "proposed") return "Proposed";
  return "Online";
}

export default function Wallet() {
  const [view, setView] = useState<View>("overview");
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [showVault, setShowVault] = useState(false);
  const [tab, setTab] = useState<Tab>("send");
  const [draft, setDraft] = useState("");
  const [sendForm, setSendForm] = useState({ open: false, module: "Bitcoin mainnet", dest: "", amount: "" });

  const [chats, setChats] = useState<Chat[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);

  const [wstate, setWstate] = useState<WalletState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [signingId, setSigningId] = useState<string | null>(null);
  const [me, setMe] = useState<{ npub: string; label: string; participant_id: number | null } | null>(null);
  const [audit, setAudit] = useState<{ entries?: AuditEntryUI[]; restricted?: boolean }>({});

  const refreshAudit = useCallback(async (chatId: string) => {
    const res = await fetch(`/api/chats/${chatId}/audit`);
    if (res.status === 403) return setAudit({ restricted: true });
    if (!res.ok) return setAudit({});
    setAudit({ entries: ((await res.json()) as { entries: AuditEntryUI[] }).entries });
  }, []);

  // Load persisted chats/approvals/identity plus the real DKGKit vault state,
  // and fold the live vault in on top.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [chatsRes, apprRes, stateRes, meRes] = await Promise.all([
          fetch("/api/chats"),
          fetch("/api/approvals"),
          fetch("/api/wallet/state"),
          fetch("/api/auth/me"),
        ]);
        if (cancelled) return;

        const apiChats: Chat[] = (await chatsRes.json().catch(() => ({}))).chats ?? [];
        const apiApprovals: Approval[] = (await apprRes.json().catch(() => ({}))).approvals ?? [];
        if (meRes.ok) {
          const m = await meRes.json().catch(() => null);
          if (m) setMe({ npub: m.npub, label: m.label, participant_id: m.participant_id });
        }

        if (stateRes.ok) {
          const ws = (await stateRes.json()) as WalletState;
          setWstate(ws);
          const apiTreasury = apiChats.find((c) => c.id === "treasury");
          const liveVault = buildLiveVault(ws);
          const liveChat: Chat = {
            ...liveVault,
            messages: [...liveVault.messages, ...(apiTreasury?.messages ?? [])],
          };
          setChats([liveChat, ...apiChats.filter((c) => c.id !== "treasury")]);
          const live = buildLiveApproval(ws);
          const apiTx1 = apiApprovals.find((a) => a.id === "tx1");
          const mergedLive: Approval = apiTx1
            ? {
                ...live,
                signed: Math.max(live.signed, apiTx1.signed),
                youSigned: apiTx1.youSigned,
                status: apiTx1.status,
                proof: apiTx1.proof ?? live.proof,
              }
            : live;
          setApprovals([mergedLive, ...apiApprovals.filter((a) => a.id !== "tx1")]);
        } else {
          const sj = await stateRes.json().catch(() => ({}));
          setStateError(sj.error ?? "Failed to load live vault");
          setChats(apiChats);
          setApprovals(apiApprovals);
        }
      } catch (e) {
        if (!cancelled) setStateError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const go = (v: View) => () => {
    setView(v);
    if (v !== "chat") setActiveChat(null);
  };
  const openChat = (id: string) => () => {
    setView("chat");
    setActiveChat(id);
    setDraft("");
  };
  const toggleVault = () => setShowVault((s) => !s);

  const active = useMemo(
    () => chats.find((c) => c.id === activeChat) ?? (view === "chat" ? chats[0] : null),
    [chats, activeChat, view],
  );

  // Load the audit trail whenever the open chat changes.
  useEffect(() => {
    if (view !== "chat" || !active) {
      setAudit({});
      return;
    }
    void refreshAudit(active.id);
  }, [view, active, refreshAudit]);

  // ---- approval actions ----
  // All signing is persisted server-side. For live approvals the route runs a
  // real grouped HTSS round in Rust and stores the aggregate signature; for
  // mock approvals it just records the signer. We take only the signing-result
  // fields back so the live approval keeps its richer display values.
  const onSign = useCallback(
    async (id: string) => {
      setSigningId(id);
      try {
        const res = await fetch(`/api/approvals/${id}/sign`, { method: "POST" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Signing failed");
        const updated = json.approval as Approval;
        setApprovals((prev) =>
          prev.map((t) =>
            t.id !== id
              ? t
              : {
                  ...t,
                  signed: updated.signed,
                  youSigned: updated.youSigned,
                  status: updated.status,
                  proof: updated.proof ?? t.proof,
                },
          ),
        );
        if (active) void refreshAudit(active.id);
      } catch (e) {
        setStateError(e instanceof Error ? e.message : "Signing failed");
      } finally {
        setSigningId(null);
      }
    },
    [active, refreshAudit],
  );
  const onReject = (id: string) =>
    setApprovals((prev) => prev.map((t) => (t.id === id ? { ...t, status: "rejected" } : t)));
  const onBroadcast = (id: string) =>
    setApprovals((prev) => prev.map((t) => (t.id === id ? { ...t, status: "broadcast" } : t)));

  // ---- vault policy editing ----
  const setThreshold = (chatId: string, tierId: string, delta: number) => () =>
    setChats((prev) =>
      prev.map((c) =>
        c.id !== chatId
          ? c
          : {
              ...c,
              tiers: c.tiers.map((t) =>
                t.id !== tierId ? t : { ...t, minNeed: Math.max(1, Math.min(t.minNeed + delta, t.keys.length)) },
              ),
            },
      ),
    );
  const removeKey = (chatId: string, tierId: string, keyId: string) => () =>
    setChats((prev) =>
      prev.map((c) =>
        c.id !== chatId
          ? c
          : { ...c, tiers: c.tiers.map((t) => (t.id !== tierId ? t : { ...t, keys: t.keys.filter((k) => k.id !== keyId) })) },
      ),
    );
  const proposeKey = (chatId: string, tierId: string) => () => {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return;
    const tier = chat.tiers.find((t) => t.id === tierId);
    if (!tier) return;
    const threshold = chat.tiers.reduce((a, t) => a + clampNeed(t), 0);
    const policy = chat.tiers.map((t) => `${clampNeed(t)}/${t.keys.length}`).join(" + ");
    const newKey: SignerKey = { id: `k${Date.now()}`, initials: "?", name: "Proposed signer", device: "Pending ratification in chat", status: "proposed" };
    setChats((prev) =>
      prev.map((c) =>
        c.id !== chatId ? c : { ...c, tiers: c.tiers.map((t) => (t.id !== tierId ? t : { ...t, keys: [...t.keys, newKey] })) },
      ),
    );
    setApprovals((prev) => [
      {
        id: `rc${Date.now()}`,
        kind: "role",
        title: `Add signer to ${tier.name}`,
        changeLabel: "Add signer — new key",
        detail: `Proposed in ${chat.name}`,
        tier: tier.name,
        requestedBy: "You",
        vault: chat.name,
        time: "just now",
        policy,
        threshold,
        total: threshold,
        signed: 0,
        youSigned: false,
        status: "pending",
      },
      ...prev,
    ]);
  };

  // ---- chat messaging ----
  const sendMsg = () => {
    const text = draft.trim();
    if (!text || !activeChat) return;
    if (text.toLowerCase() === "/send") {
      setDraft("");
      setSendForm({ open: true, module: "Bitcoin mainnet", dest: "", amount: "" });
      return;
    }
    const cid = activeChat;
    setDraft("");
    void (async () => {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: cid, text }),
      });
      if (!res.ok) {
        setStateError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Message failed");
        return;
      }
      const { message } = (await res.json()) as { message: ChatMessage };
      setChats((prev) =>
        prev.map((c) => (c.id === cid ? { ...c, messages: [...c.messages, message] } : c)),
      );
      void refreshAudit(cid);
    })();
  };
  const submitSend = () => {
    const amt = parseFloat(sendForm.amount);
    if (!activeChat || !sendForm.dest.trim() || !(amt > 0)) return;
    const chat = chats.find((c) => c.id === activeChat);
    if (!chat) return;
    const threshold = chat.tiers.reduce((a, t) => a + clampNeed(t), 0);
    const policy = chat.tiers.map((t) => `${clampNeed(t)}/${t.keys.length}`).join(" + ");
    const dest = sendForm.dest.trim();
    const destShort = dest.length > 16 ? `${dest.slice(0, 8)}…${dest.slice(-4)}` : dest;
    const usd = Math.round(amt * BTC_USD).toLocaleString("en-US");
    const cid = activeChat;
    const module = sendForm.module;
    setSendForm({ open: false, module: "Bitcoin mainnet", dest: "", amount: "" });
    const proposal: Approval = {
      id: `tx${Date.now()}`,
      kind: "send",
      title: `Transfer · ${module}`,
      dest: destShort,
      destLabel: module,
      btc: amt.toFixed(2),
      usd,
      vault: chat.name,
      time: "just now",
      policy,
      threshold,
      total: threshold,
      signed: 0,
      youSigned: false,
      status: "pending",
    };
    const announce = `Requested a transfer — ${amt} BTC to ${destShort} on ${module}. Needs a ${policy} quorum — please review and sign in Approvals.`;
    void (async () => {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposal),
      });
      const created = res.ok ? ((await res.json()) as { approval: Approval }).approval : proposal;
      setApprovals((prev) => [created, ...prev]);

      const mres = await fetch("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: cid, text: announce }),
      });
      if (mres.ok) {
        const { message } = (await mres.json()) as { message: ChatMessage };
        setChats((prev) =>
          prev.map((c) => (c.id === cid ? { ...c, messages: [...c.messages, message] } : c)),
        );
      }
      void refreshAudit(cid);
    })();
  };

  // ---- derived values ----
  const totalBtc = chats.reduce((s, c) => s + parseFloat(c.balanceBtc), 0);
  const totalKeys = chats.reduce((s, c) => s + c.tiers.reduce((a, t) => a + t.keys.length, 0), 0);
  const vaultCount = chats.length;
  const pendingCount = approvals.filter((t) => t.status === "pending" || t.status === "ready").length;
  const youNeed = approvals.filter((t) => !t.youSigned && t.status === "pending").length;
  const sendApprovals = approvals.filter((a) => a.kind !== "role");
  const roleApprovals = approvals.filter((a) => a.kind === "role");

  const titles: Record<Exclude<View, "chat">, [string, string]> = {
    overview: ["Overview", "Treasury at a glance"],
    approvals: ["Approvals", "Transactions awaiting a signing quorum"],
    plan: ["Plan", "Your BTech subscription"],
  };
  let pageTitle: string;
  let pageSub: string;
  if (view === "chat") {
    if (active) {
      pageTitle = active.name;
      pageSub = (active.type === "direct" ? "Direct message · secured by a " : `${active.members} members · secured by a `) + quorumOf(active.tiers) + " vault";
    } else {
      pageTitle = "Chats";
      pageSub = "Every treasury group you belong to";
    }
  } else {
    [pageTitle, pageSub] = titles[view];
  }

  return (
    <div style={{ display: "flex", width: "100%", height: "100vh", minHeight: 760, background: C.bg, color: C.ink, fontFamily: SANS, overflow: "hidden" }}>
      <Sidebar
        view={view}
        active={active}
        chats={chats}
        youNeed={youNeed}
        go={go}
        openChat={openChat}
        goPlan={go("plan")}
      />

      <main style={{ flex: 1, height: "100%", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header style={{ height: 66, flex: "0 0 66px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 30px", background: C.bg }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-.3px" }}>{pageTitle}</div>
            <div style={{ fontSize: 12, color: C.faint, marginTop: 1 }}>{pageSub}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface2, border: `1px solid ${C.line2}`, borderRadius: 9, padding: "8px 12px", fontSize: 12.5, color: "#9CA1A7" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, boxShadow: "0 0 0 3px rgba(63,185,80,.16)" }} />
              BTC ${BTC_USD.toLocaleString("en-US")}
            </div>
            <button onClick={go("approvals")} style={{ display: "flex", alignItems: "center", gap: 9, background: C.orange, color: C.bg, border: "none", borderRadius: 9, padding: "9px 15px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
              New transfer
            </button>
          </div>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: 30 }}>
          {stateError && (
            <div style={{ marginBottom: 18, background: "rgba(240,97,109,.08)", border: "1px solid rgba(240,97,109,.3)", color: C.red, borderRadius: 12, padding: "12px 16px", fontSize: 12.5 }}>
              Live vault error: {stateError}. The DKGKit backend may still be compiling — refresh in a moment.
            </div>
          )}

          {view === "overview" && (
            <Overview
              wstate={wstate}
              balanceBtc={totalBtc.toFixed(2)}
              balanceUsd={Math.round(totalBtc * BTC_USD).toLocaleString("en-US")}
              vaultCount={vaultCount}
              totalKeys={totalKeys}
              pendingCount={pendingCount}
              primary={chats[0]}
              goApprovals={go("approvals")}
              goPrimaryVault={openChat("treasury")}
            />
          )}

          {view === "approvals" && (
            <Approvals
              tab={tab}
              setTab={setTab}
              sendApprovals={sendApprovals}
              roleApprovals={roleApprovals}
              signingId={signingId}
              onSign={onSign}
              onReject={onReject}
              onBroadcast={onBroadcast}
            />
          )}

          {view === "chat" && active && (
            <ChatDetail
              chat={active}
              showVault={showVault}
              toggleVault={toggleVault}
              wstate={wstate}
              draft={draft}
              setDraft={setDraft}
              onSendMsg={sendMsg}
              sendForm={sendForm}
              setSendForm={setSendForm}
              submitSend={submitSend}
              setThreshold={setThreshold}
              removeKey={removeKey}
              proposeKey={proposeKey}
            />
          )}

          {view === "plan" && <Plan />}
        </div>
      </main>
    </div>
  );
}

// ===========================================================================
// Sidebar
// ===========================================================================

function Sidebar({
  view,
  active,
  chats,
  youNeed,
  go,
  openChat,
  goPlan,
}: {
  view: View;
  active: Chat | null;
  chats: Chat[];
  youNeed: number;
  go: (v: View) => () => void;
  openChat: (id: string) => () => void;
  goPlan: () => void;
}) {
  const nav = [
    { key: "overview" as const, label: "Overview", icon: "◉", badge: "" },
    { key: "approvals" as const, label: "Approvals", icon: "✎", badge: youNeed ? String(youNeed) : "" },
  ];
  const channels = chats.filter((c) => c.type !== "direct");
  const directs = chats.filter((c) => c.type === "direct");

  return (
    <aside style={{ width: 248, flex: "0 0 248px", height: "100%", background: C.sidebar, borderRight: `1px solid ${C.line2}`, display: "flex", flexDirection: "column", padding: "22px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "4px 8px 22px" }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: C.orange, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 19, color: C.bg, fontFamily: MONO }}>₿</div>
        <div style={{ lineHeight: 1.05 }}>
          <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-.2px" }}>BTech</div>
          <div style={{ fontSize: 10.5, color: C.faint, letterSpacing: ".3px" }}>TREASURY VAULT</div>
        </div>
      </div>

      <nav style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {nav.map((item) => {
          const on = view === item.key;
          return (
            <button
              key={item.key}
              onClick={go(item.key)}
              style={{ position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "10px 12px", border: "none", borderRadius: 10, background: "transparent", fontFamily: "inherit", fontSize: 13.5, fontWeight: 500, cursor: "pointer", textAlign: "left", color: on ? C.orange : C.muted }}
            >
              {on && <span style={{ position: "absolute", inset: 0, background: C.orangeSoft, borderRadius: 10, zIndex: 0 }} />}
              <span style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: 11 }}>
                <span style={{ width: 18, display: "flex", justifyContent: "center", color: on ? C.orange : C.faint }}>{item.icon}</span>
                <span>{item.label}</span>
              </span>
              {item.badge && (
                <span style={{ position: "relative", zIndex: 1, fontFamily: MONO, fontSize: 11, fontWeight: 600, background: C.orange, color: C.bg, padding: "1px 7px", borderRadius: 20 }}>{item.badge}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div style={{ marginTop: 7, paddingLeft: 8, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ fontSize: 10, color: "#5E6369", letterSpacing: ".5px", padding: "5px 10px 3px" }}>CHANNELS</div>
        {channels.map((c) => {
          const on = view === "chat" && !!active && c.id === active.id;
          return (
            <button key={c.id} onClick={openChat(c.id)} style={{ position: "relative", overflow: "hidden", display: "flex", alignItems: "center", width: "100%", border: "none", background: "transparent", borderRadius: 9, padding: "7px 10px 7px 12px", fontFamily: MONO, fontSize: 12.5, fontWeight: 500, cursor: "pointer", textAlign: "left", color: on ? C.orange : "#8B9096" }}>
              {on && <span style={{ position: "absolute", inset: 0, background: "rgba(247,147,26,.1)", borderRadius: 9, zIndex: 0 }} />}
              <span style={{ position: "relative", zIndex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
            </button>
          );
        })}
        <div style={{ fontSize: 10, color: "#5E6369", letterSpacing: ".5px", padding: "10px 10px 3px" }}>DIRECT</div>
        {directs.map((c) => {
          const on = view === "chat" && !!active && c.id === active.id;
          return (
            <button key={c.id} onClick={openChat(c.id)} style={{ position: "relative", overflow: "hidden", display: "flex", alignItems: "center", gap: 9, width: "100%", border: "none", background: "transparent", borderRadius: 9, padding: "6px 10px", fontFamily: "inherit", fontSize: 12.5, fontWeight: 500, cursor: "pointer", textAlign: "left", color: on ? C.orange : "#C5C9CE" }}>
              {on && <span style={{ position: "absolute", inset: 0, background: "rgba(247,147,26,.1)", borderRadius: 9, zIndex: 0 }} />}
              <span style={{ position: "relative", zIndex: 1, width: 22, height: 22, flex: "0 0 22px", borderRadius: 6, background: c.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9.5, fontWeight: 700, color: C.bg }}>{c.initials}</span>
              <span style={{ position: "relative", zIndex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <Link href="/console" style={{ fontSize: 11.5, color: C.faint2, textDecoration: "none", padding: "0 8px", display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ color: C.orange }}>↗</span> DKGKit protocol console
        </Link>
        <div style={{ background: "rgba(247,147,26,.07)", border: "1px solid rgba(247,147,26,.22)", borderRadius: 12, padding: "13px 14px" }}>
          <div style={{ fontSize: 11, color: C.sand, letterSpacing: ".3px", marginBottom: 6 }}>SELF-CUSTODY</div>
          <div style={{ fontSize: 12.5, color: "#C5C9CE", lineHeight: 1.45 }}>No keys held by BTech. Your quorum, your coins.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 8px 4px", borderTop: `1px solid ${C.line}` }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: "#23262B", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, color: C.muted }}>DK</div>
          <div style={{ lineHeight: 1.15, flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Dana Klein</div>
            <div style={{ fontSize: 11, color: C.faint }}>Business plan</div>
          </div>
          <button onClick={goPlan} style={{ flex: "0 0 auto", background: C.orangeSoft, border: "1px solid rgba(247,147,26,.32)", color: C.orange, fontSize: 11, fontWeight: 600, fontFamily: "inherit", padding: "6px 11px", borderRadius: 8, cursor: "pointer" }}>Upgrade</button>
        </div>
      </div>
    </aside>
  );
}

// ===========================================================================
// Overview
// ===========================================================================

function shortHex(hex: string): string {
  return hex && hex.length > 20 ? `${hex.slice(0, 12)}…${hex.slice(-10)}` : hex;
}

function Overview({
  wstate,
  balanceBtc,
  balanceUsd,
  vaultCount,
  totalKeys,
  pendingCount,
  primary,
  goApprovals,
  goPrimaryVault,
}: {
  wstate: WalletState | null;
  balanceBtc: string;
  balanceUsd: string;
  vaultCount: number;
  totalKeys: number;
  pendingCount: number;
  primary: Chat | undefined;
  goApprovals: () => void;
  goPrimaryVault: () => void;
}) {
  const activity = [
    { icon: "↓", dotBg: "rgba(63,185,80,.12)", dotColor: C.green, label: "Received from exchange", meta: "Coinbase Prime · #cold-reserve", amount: "+12.50 BTC", time: "2h ago" },
    { icon: "✎", dotBg: "rgba(247,147,26,.12)", dotColor: C.orange, label: "CEO signed — Payroll batch", meta: "#treasury-ops · 4/4", amount: "—", time: "3h ago" },
    { icon: "↑", dotBg: "rgba(240,97,109,.12)", dotColor: C.red, label: "Sent to vendor", meta: "#treasury-ops · whitelisted", amount: "−1.10 BTC", time: "1d ago" },
    { icon: "#", dotBg: "rgba(255,255,255,.06)", dotColor: C.muted, label: "New chat created", meta: "#ops-petty-cash · 2-of-3 vault", amount: "—", time: "2d ago" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 1160 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 18 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.line2}`, borderRadius: 16, padding: "22px 24px", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", right: -30, top: -30, width: 150, height: 150, borderRadius: "50%", background: "radial-gradient(circle,rgba(247,147,26,.16),transparent 70%)" }} />
          <div style={{ fontSize: 12, color: C.faint2, letterSpacing: ".3px" }}>TOTAL ACROSS VAULTS</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 10 }}>
            <span style={{ fontFamily: MONO, fontSize: 38, fontWeight: 600, letterSpacing: "-1px" }}>{balanceBtc}</span>
            <span style={{ fontSize: 18, color: C.orange, fontWeight: 600 }}>BTC</span>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 15, color: "#9CA1A7", marginTop: 4 }}>${balanceUsd}</div>
          <div style={{ display: "flex", gap: 26, marginTop: 18, paddingTop: 16, borderTop: `1px solid ${C.line}` }}>
            <Stat label="VAULTS" value={String(vaultCount)} />
            <Stat label="SIGNERS" value={String(totalKeys)} />
            <Stat label="30D CHANGE" value="+2.1%" color={C.green} />
          </div>
        </div>
        <div onClick={goApprovals} style={{ background: C.surface, border: "1px solid rgba(247,147,26,.3)", borderRadius: 16, padding: "22px 24px", cursor: "pointer" }}>
          <div style={{ fontSize: 12, color: C.sand, letterSpacing: ".3px" }}>AWAITING YOUR SIGNATURE</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 10 }}>
            <span style={{ fontFamily: MONO, fontSize: 34, fontWeight: 600, color: C.orange }}>{pendingCount}</span>
            <span style={{ fontSize: 14, color: C.faint2 }}>transactions</span>
          </div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 16, background: C.orange, color: C.bg, fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 8 }}>Review approvals →</div>
        </div>
      </div>

      {wstate && <LiveVaultCard wstate={wstate} />}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.line2}`, borderRadius: 16, padding: "6px 4px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, padding: "16px 20px 12px" }}>Recent activity</div>
          {activity.map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 13, padding: "11px 20px", borderTop: "1px solid rgba(255,255,255,.05)" }}>
              <span style={{ width: 32, height: 32, borderRadius: 9, background: a.dotBg, color: a.dotColor, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flex: "0 0 32px" }}>{a.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{a.label}</div>
                <div style={{ fontSize: 11.5, color: C.faint2 }}>{a.meta}</div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 12.5, color: "#9CA1A7", textAlign: "right" }}>
                {a.amount}
                <div style={{ fontSize: 10.5, color: C.faint }}>{a.time}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.line2}`, borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{primary?.name ?? "#treasury-ops"} quorum</div>
            <button onClick={goPrimaryVault} style={{ background: "transparent", border: `1px solid ${C.line2}`, color: "#C5C9CE", fontSize: 11.5, fontFamily: "inherit", padding: "5px 11px", borderRadius: 7, cursor: "pointer" }}>Open chat &amp; vault</button>
          </div>
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 11 }}>
            {(primary?.tiers ?? []).map((t, i) => (
              <div key={t.id}>
                {i > 0 && <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: C.faint, letterSpacing: 1, margin: "11px 0" }}>AND</div>}
                <div style={{ display: "flex", alignItems: "center", gap: 13, background: C.surface2, border: `1px solid ${C.line}`, borderRadius: 11, padding: "13px 15px" }}>
                  <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: C.orange, background: C.orangeSoft, padding: "4px 9px", borderRadius: 7 }}>{clampNeed(t)} / {t.keys.length}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{t.name}</div>
                    <div style={{ fontSize: 11.5, color: C.faint2 }}>{t.keys.map((k) => k.name.split(" ")[0]).join(" · ")}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: "auto", paddingTop: 16, fontSize: 11.5, color: C.faint2, lineHeight: 1.5 }}>
            Every spend needs a quorum from <span style={{ color: "#C5C9CE" }}>each</span> tier. Edit the policy inside the chat.
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.faint2 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 14, marginTop: 3, color: color ?? C.ink }}>{value}</div>
    </div>
  );
}

function LiveVaultCard({ wstate }: { wstate: WalletState }) {
  const { demo, session } = wstate;
  return (
    <div style={{ background: C.surface, border: "1px solid rgba(63,185,80,.25)", borderRadius: 16, padding: "20px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Live DKGKit vault</span>
        <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: ".4px", color: C.green, background: "rgba(63,185,80,.12)", padding: "3px 8px", borderRadius: 20 }}>
          {demo.verified ? "BIP340 VERIFIED" : "UNVERIFIED"}
        </span>
        <span style={{ fontSize: 11, color: C.faint2 }}>{demo.network} · {session.htss.threshold}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 26px", marginTop: 12 }}>
        <KV label="Group x-only key" value={shortHex(demo.group_xonly_public_key)} />
        <KV label="Receive address" value={shortHex(demo.receive_address)} />
        <KV label="Receive path" value={demo.receive_path} />
        <KV label="Aggregate signature" value={shortHex(demo.aggregate_signature)} />
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <Proof ok={session.invalid_htss_signer_set_rejected} text="Invalid signer set rejected" />
        <Proof ok={session.high_rank_cannot_substitute_low_group} text="High-rank can't substitute a low-rank quorum" />
        <Proof ok={session.tss.verified} text={`Base TSS ${session.tss.threshold} verified`} />
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: C.faint2, letterSpacing: ".3px" }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 12, color: "#C5C9CE", marginTop: 3, wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}

function Proof({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: ok ? C.green : C.red, background: ok ? "rgba(63,185,80,.1)" : "rgba(240,97,109,.1)", padding: "5px 10px", borderRadius: 20 }}>
      {ok ? "✓" : "✗"} {text}
    </span>
  );
}

// ===========================================================================
// Approvals
// ===========================================================================

function Approvals({
  tab,
  setTab,
  sendApprovals,
  roleApprovals,
  signingId,
  onSign,
  onReject,
  onBroadcast,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  sendApprovals: Approval[];
  roleApprovals: Approval[];
  signingId: string | null;
  onSign: (id: string) => void;
  onReject: (id: string) => void;
  onBroadcast: (id: string) => void;
}) {
  const list = tab === "send" ? sendApprovals : roleApprovals;
  const empty = list.length === 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div style={{ display: "flex", gap: 6, background: C.surface2, border: `1px solid ${C.line2}`, borderRadius: 11, padding: 5, width: "fit-content" }}>
        <TabButton active={tab === "send"} onClick={() => setTab("send")} label="Sending transactions" count={sendApprovals.length} />
        <TabButton active={tab === "admin"} onClick={() => setTab("admin")} label="Manage admin" count={roleApprovals.length} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {list.map((a) => (
          <ApprovalCard key={a.id} appr={a} busy={signingId === a.id} onSign={onSign} onReject={onReject} onBroadcast={onBroadcast} />
        ))}
        {empty && (
          <div style={{ color: C.faint, fontSize: 13, padding: 34, textAlign: "center", border: "1px dashed rgba(255,255,255,.1)", borderRadius: 14 }}>
            {tab === "send" ? (
              <>No transfers awaiting signatures. Type <span style={{ color: C.sand, fontFamily: MONO }}>/send</span> in a chat to request one.</>
            ) : (
              <>No admin changes pending. Propose or remove a signer in a chat&apos;s vault panel.</>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button onClick={onClick} style={{ position: "relative", overflow: "hidden", border: "none", background: "transparent", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", color: active ? C.bg : "#9CA1A7", display: "flex", alignItems: "center", gap: 9 }}>
      {active && <span style={{ position: "absolute", inset: 0, background: C.orange, borderRadius: 8, zIndex: 0 }} />}
      <span style={{ position: "relative", zIndex: 1 }}>{label}</span>
      <span style={{ position: "relative", zIndex: 1, fontFamily: MONO, fontSize: 11, opacity: 0.75 }}>{count}</span>
    </button>
  );
}

// ===========================================================================
// Chat detail
// ===========================================================================

function ChatDetail({
  chat,
  showVault,
  toggleVault,
  draft,
  setDraft,
  onSendMsg,
  sendForm,
  setSendForm,
  submitSend,
  setThreshold,
  removeKey,
  proposeKey,
}: {
  chat: Chat;
  showVault: boolean;
  toggleVault: () => void;
  wstate: WalletState | null;
  draft: string;
  setDraft: (s: string) => void;
  onSendMsg: () => void;
  sendForm: { open: boolean; module: string; dest: string; amount: string };
  setSendForm: (f: { open: boolean; module: string; dest: string; amount: string }) => void;
  submitSend: () => void;
  setThreshold: (chatId: string, tierId: string, delta: number) => () => void;
  removeKey: (chatId: string, tierId: string, keyId: string) => () => void;
  proposeKey: (chatId: string, tierId: string) => () => void;
}) {
  const quorum = quorumOf(chat.tiers);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 126px)", gap: 14 }}>
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 9 }}>
            {chat.name}
            {chat.live && <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: ".4px", color: C.green, background: "rgba(63,185,80,.12)", padding: "2px 7px", borderRadius: 20 }}>LIVE</span>}
          </div>
          <div style={{ fontSize: 11.5, color: C.faint2, display: "flex", alignItems: "center", gap: 7, marginTop: 2 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.green }} />
            {chat.type === "direct" ? "Direct message" : "Channel"} · {chat.members} members · {chat.balanceBtc} BTC
          </div>
        </div>
        <button onClick={toggleVault} style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8, background: C.surface2, border: `1px solid ${showVault ? C.orange : "rgba(255,255,255,.1)"}`, color: showVault ? C.orange : "#C5C9CE", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap", padding: "9px 14px", borderRadius: 9, cursor: "pointer" }}>
          <span style={{ fontFamily: MONO }}>{quorum}</span> {showVault ? "Hide vault policy" : "Vault policy"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 18, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "#101216", border: `1px solid ${C.line2}`, borderRadius: 16, overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
            {chat.messages.map((m) => (
              <div key={m.id} style={{ display: "flex", gap: 12 }}>
                <span style={{ width: 34, height: 34, borderRadius: 10, background: m.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: C.bg, flex: "0 0 34px" }}>{m.initials}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{m.who}</span>
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.faint }}>{m.handle}</span>
                    <span style={{ fontSize: 10.5, color: C.faint }}>{m.time}</span>
                    {m.signed && <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: ".3px", color: C.green, background: "rgba(63,185,80,.12)", padding: "2px 7px", borderRadius: 20 }}>SIGNED EVENT</span>}
                  </div>
                  <div style={{ fontSize: 13, color: "#C5C9CE", lineHeight: 1.55, marginTop: 4 }}>{m.text}</div>
                  {m.zaps && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: C.sand, background: "rgba(247,147,26,.1)", padding: "3px 9px", borderRadius: 20, marginTop: 8, fontFamily: MONO }}>{m.zaps}</span>}
                </div>
              </div>
            ))}
          </div>
          <div style={{ flex: "0 0 auto", borderTop: `1px solid ${C.line}`, padding: "14px 16px" }}>
            {sendForm.open && (
              <div style={{ background: "#0E1014", border: "1px solid rgba(247,147,26,.3)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: C.orange }}>Propose a BTC transfer</span>
                  <button onClick={() => setSendForm({ open: false, module: "Bitcoin mainnet", dest: "", amount: "" })} title="Cancel" style={{ width: 22, height: 22, border: "none", background: "transparent", color: C.faint2, fontSize: 16, cursor: "pointer", fontFamily: "inherit" }}>×</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Field label="CHAIN / MODULE">
                    <select value={sendForm.module} onChange={(e) => setSendForm({ ...sendForm, module: e.target.value })} style={inputStyle}>
                      <option>Bitcoin mainnet</option>
                      <option>Lightning</option>
                      <option>Liquid</option>
                    </select>
                  </Field>
                  <Field label="DESTINATION">
                    <input value={sendForm.dest} onChange={(e) => setSendForm({ ...sendForm, dest: e.target.value })} placeholder="bc1q… address or invoice" style={{ ...inputStyle, fontFamily: MONO }} />
                  </Field>
                  <Field label="AMOUNT (BTC)">
                    <input value={sendForm.amount} onChange={(e) => setSendForm({ ...sendForm, amount: e.target.value })} inputMode="decimal" placeholder="0.00" style={{ ...inputStyle, fontFamily: MONO }} />
                  </Field>
                </div>
                <button onClick={submitSend} style={{ width: "100%", marginTop: 12, background: C.orange, border: "none", color: C.bg, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", padding: 10, borderRadius: 8, cursor: "pointer" }}>
                  Request signatures from {quorum}
                </button>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", background: C.surface2, border: "1px solid rgba(255,255,255,.08)", borderRadius: 11, padding: "6px 6px 6px 8px" }}>
              <button onClick={() => setSendForm({ open: true, module: "Bitcoin mainnet", dest: "", amount: "" })} title="Propose a BTC transfer" style={{ flex: "0 0 auto", width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "rgba(247,147,26,.14)", color: C.orange, borderRadius: 8, cursor: "pointer", fontFamily: MONO, fontSize: 17, fontWeight: 700 }}>₿</button>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSendMsg(); } }} placeholder={`Message ${chat.name}`} style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: C.ink, fontSize: 13, fontFamily: "inherit" }} />
              <button onClick={onSendMsg} style={{ flex: "0 0 auto", background: C.orange, border: "none", color: C.bg, fontSize: 13, fontWeight: 600, fontFamily: "inherit", padding: "8px 18px", borderRadius: 8, cursor: "pointer" }}>Send</button>
            </div>
            <div style={{ fontSize: 10.5, color: "#5E6369", marginTop: 9, padding: "0 2px", lineHeight: 1.5 }}>
              Tap <span style={{ color: C.sand }}>₿</span> (or type <span style={{ color: C.sand, fontFamily: MONO }}>/send</span>) to propose a BTC transfer. Signed with your Nostr key and relayed to the group.
            </div>
          </div>
        </div>

        {showVault && (
          <VaultPanel chat={chat} setThreshold={setThreshold} removeKey={removeKey} proposeKey={proposeKey} />
        )}
      </div>
    </div>
  );
}

const inputStyle: CSSProperties = {
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: C.faint2, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}

function VaultPanel({
  chat,
  setThreshold,
  removeKey,
  proposeKey,
}: {
  chat: Chat;
  setThreshold: (chatId: string, tierId: string, delta: number) => () => void;
  removeKey: (chatId: string, tierId: string, keyId: string) => () => void;
  proposeKey: (chatId: string, tierId: string) => () => void;
}) {
  const quorum = quorumOf(chat.tiers);
  const multiTier = chat.tiers.length > 1;
  return (
    <div style={{ flex: "0 0 348px", width: 348, display: "flex", flexDirection: "column", background: "#101216", border: `1px solid ${C.line2}`, borderRadius: 16, overflowY: "auto" }}>
      <div style={{ padding: "18px 20px", borderBottom: `1px solid ${C.line}` }}>
        <div style={{ fontSize: 11, color: C.sand, letterSpacing: ".4px" }}>VAULT POLICY</div>
        <div style={{ fontFamily: MONO, fontSize: 12, color: "#9CA1A7", marginTop: 8, lineHeight: 1.5 }}>{spendOf(chat.tiers)}</div>
        <div style={{ fontSize: 10.5, color: C.faint, marginTop: 8 }}>Set each tier&apos;s required signers with the steppers below</div>
        {chat.live && (
          <div style={{ fontSize: 10.5, color: C.green, marginTop: 8, lineHeight: 1.5 }}>Live DKGKit vault. Receive {shortHex(chat.receiveAddress ?? "")} · group key {shortHex(chat.groupKey ?? "")}. Threshold edits here are proposals — applying them re-runs DKG.</div>
        )}
        {multiTier && (
          <div style={{ fontSize: 10.5, color: C.sand, marginTop: 8, lineHeight: 1.5 }}>Each signer belongs to one tier only — a member of one tier can&apos;t satisfy the other. Both quorums are required.</div>
        )}
      </div>
      <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 18 }}>
        {chat.tiers.map((tier) => (
          <div key={tier.id}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{tier.name}</div>
                <div style={{ fontSize: 11, color: C.faint2 }}>{tier.short} tier</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Stepper onClick={setThreshold(chat.id, tier.id, -1)} title="Fewer required signers">−</Stepper>
                <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: C.orange, whiteSpace: "nowrap", minWidth: 46, textAlign: "center" }}>{clampNeed(tier)} of {tier.keys.length}</span>
                <Stepper onClick={setThreshold(chat.id, tier.id, 1)} title="More required signers">+</Stepper>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              {tier.keys.map((k) => {
                const proposed = k.status === "proposed";
                return (
                  <div key={k.id} style={{ display: "flex", alignItems: "center", gap: 10, background: proposed ? "rgba(247,147,26,.05)" : "#0E1014", border: `1px ${proposed ? "dashed" : "solid"} ${proposed ? "rgba(247,147,26,.4)" : C.line2}`, borderRadius: 10, padding: "9px 11px" }}>
                    <span style={{ width: 28, height: 28, borderRadius: 8, background: proposed ? "rgba(247,147,26,.18)" : "#23262B", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: "#C5C9CE", flex: "0 0 28px" }}>{k.initials}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{k.name}</div>
                      <div style={{ fontSize: 10.5, color: C.faint2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{k.device}</div>
                    </div>
                    {proposed && <span style={{ fontSize: 8.5, fontWeight: 600, letterSpacing: ".3px", color: C.sand, background: "rgba(247,147,26,.14)", padding: "3px 6px", borderRadius: 20, whiteSpace: "nowrap" }}>PROPOSED</span>}
                    {!proposed && <span style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_COLOR[k.status], flex: "0 0 8px" }} title={statusLabelOf(k)} />}
                    <button onClick={removeKey(chat.id, tier.id, k.id)} title="Remove signer" style={{ width: 20, height: 20, flex: "0 0 20px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", color: "#5E6369", fontSize: 15, lineHeight: 1, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>×</button>
                  </div>
                );
              })}
              <button onClick={proposeKey(chat.id, tier.id)} style={{ width: "100%", background: "transparent", border: "1px dashed rgba(247,147,26,.4)", color: C.sand, borderRadius: 10, padding: 9, fontSize: 12, fontWeight: 500, fontFamily: "inherit", cursor: "pointer" }}>+ Propose new signer</button>
            </div>
          </div>
        ))}
        <div style={{ background: "rgba(247,147,26,.07)", border: "1px solid rgba(247,147,26,.22)", borderRadius: 12, padding: "14px 16px" }}>
          <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 600, color: C.orange }}>{quorum}</div>
          <div style={{ fontSize: 11, color: C.sand, marginTop: 3 }}>required from each tier · quorums never overlap</div>
        </div>
        <div style={{ fontSize: 11, color: C.faint2, lineHeight: 1.5 }}>Adding or removing a signer is proposed and ratified by the group in this chat — there is no fixed rulebook.</div>
      </div>
    </div>
  );
}

function Stepper({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} style={{ width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(255,255,255,.12)", background: "transparent", color: "#C5C9CE", borderRadius: 7, cursor: "pointer", fontSize: 15, fontFamily: "inherit", lineHeight: 1 }}>
      {children}
    </button>
  );
}

// ===========================================================================
// Plan
// ===========================================================================

function Plan() {
  const plans = [
    { name: "Starter", nameColor: C.ink, price: "$0", per: "/mo", tagline: "One chat and vault for small teams getting off the exchange.", bg: C.surface, border: C.line2, featured: false, features: ["1 chat · up to 3 keys", "2-of-3 single-tier quorum", "Nostr team chat", "Email support"], cta: "Downgrade", btnBg: "transparent", btnColor: "#C5C9CE", btnBorder: "1px solid rgba(255,255,255,.14)" },
    { name: "Business", nameColor: C.orange, price: "$499", per: "/mo", tagline: "Unlimited chats with hierarchical vaults for operating treasuries.", bg: "#15120C", border: "rgba(247,147,26,.4)", featured: true, features: ["Unlimited chats · up to 15 keys each", "Multi-tier hierarchical signatures", "Nostr team chat & proposals", "Audit log & SSO", "Priority signing support"], cta: "Current plan", btnBg: C.orange, btnColor: C.bg, btnBorder: "none" },
    { name: "Enterprise", nameColor: C.ink, price: "Custom", per: "", tagline: "Dedicated infrastructure, SLAs and white-glove key ceremonies.", bg: C.surface, border: C.line2, featured: false, features: ["Unlimited keys & tiers", "On-site key ceremony", "Dedicated infra + 24/7 SLA", "Self-hosted Nostr relays", "Named solutions engineer"], cta: "Contact sales", btnBg: "transparent", btnColor: "#C5C9CE", btnBorder: "1px solid rgba(255,255,255,.14)" },
  ];
  return (
    <div style={{ maxWidth: 1080 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, alignItems: "stretch" }}>
        {plans.map((pl) => (
          <div key={pl.name} style={{ background: pl.bg, border: `1px solid ${pl.border}`, borderRadius: 18, padding: "26px 24px", display: "flex", flexDirection: "column", position: "relative" }}>
            {pl.featured && <span style={{ position: "absolute", top: 18, right: 20, fontSize: 10.5, fontWeight: 600, color: C.bg, background: C.orange, padding: "3px 10px", borderRadius: 20 }}>CURRENT</span>}
            <div style={{ fontSize: 14, fontWeight: 600, color: pl.nameColor }}>{pl.name}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 14 }}>
              <span style={{ fontFamily: MONO, fontSize: 32, fontWeight: 600 }}>{pl.price}</span>
              <span style={{ fontSize: 13, color: C.faint2 }}>{pl.per}</span>
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>{pl.tagline}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 11, marginTop: 20, flex: 1 }}>
              {pl.features.map((f) => (
                <div key={f} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12.5, color: "#C5C9CE", lineHeight: 1.4 }}>
                  <span style={{ color: C.orange, fontWeight: 600 }}>✓</span>
                  {f}
                </div>
              ))}
            </div>
            <button style={{ marginTop: 22, background: pl.btnBg, color: pl.btnColor, border: pl.btnBorder, borderRadius: 10, padding: 11, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>{pl.cta}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
