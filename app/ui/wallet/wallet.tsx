"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { finalizeEvent } from "nostr-tools";
import type { EventTemplate } from "nostr-tools";

import { ApprovalCard } from "./approval-card";
import { buildLiveVault } from "./data";
import { useBtcPrice } from "./use-btc-price";
import { ProfilePopover } from "./profile-popover";
import { resolveSigner, type NostrSigner } from "./nostr-signer";
import { NostrChatClient, relayUrl, scopeFor, type DecryptedMessage } from "./nostr-chat";
import { mergeNewChats } from "./chat-merge";
import { PolicyEditor } from "./policy-editor";
import type {
  Approval,
  Chat,
  PolicyConfig,
  PolicyDiffItem,
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
  outcome: "success" | "failed" | null;
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

/** Map the display `tiers` of a chat to the editable `PolicyConfig` the
 * PolicyEditor works on. Each tier becomes a rank (0,1,2…). A display `SignerKey`
 * carries no npub, so we derive the Rust signer id by parsing `k.id` ("k1"→1,
 * "k0-2"→0) and look the npub up from the vault roster by that id; falling back to
 * the slot index + 1 and an empty npub when neither is available. */
function chatToPolicyConfig(
  chat: Chat,
  roster: { npub: string; label: string; participantId: number }[],
): PolicyConfig {
  const byPid = new Map(roster.map((r) => [r.participantId, r]));
  return {
    tiers: chat.tiers.map((t, i) => ({
      id: t.id,
      name: t.name,
      rank: i,
      required: clampNeed(t),
      signers: t.keys.map((k, j) => {
        const pid = Number.parseInt(k.id.replace(/\D/g, ""), 10) || j + 1;
        const r = byPid.get(pid);
        return { participantId: pid, npub: r?.npub ?? "", label: k.name, rank: i };
      }),
    })),
  };
}
function statusLabelOf(k: SignerKey): string {
  if (k.statusText) return k.statusText;
  if (k.status === "reattesting") return "Re-attesting";
  if (k.status === "proposed") return "Proposed";
  return "Online";
}

// On-chain activity derived from /api/chain/activity (real esplora tx history).
type ActivityApiEntry = {
  txid: string;
  address: string;
  direction: "in" | "out";
  deltaSats: number;
  confirmed: boolean;
  blockHeight: number | null;
  blockTime: number | null;
  txUrl: string;
};
type ActivityRow = ActivityApiEntry & { vault: string };

function fmtBtc(sats: number): string {
  return (Math.abs(sats) / 1e8).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}
function relTime(unixSec: number | null): string {
  if (unixSec == null) return "pending";
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

// Demo persona switching. The login screen logs a persona in with one tap by
// signing the challenge with a deterministic per-participant secret; we reuse
// the exact same path from the sidebar so the demo can hop between signers
// without re-entering a key. Real users still bring their own NIP-07/nsec.
type Persona = { npub: string; label: string; role: string; participant_id: number };

function challengeTemplate(nonce: string): EventTemplate {
  return {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["challenge", nonce]],
    content: `btech-login:${nonce}`,
  };
}

/** Same deterministic secret the server derives for a demo persona. */
async function personaSecret(participantId: number): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`btech-signer-v1:${participantId}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Wallet() {
  const [view, setView] = useState<View>("overview");
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [showVault, setShowVault] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [tab, setTab] = useState<Tab>("send");
  const [draft, setDraft] = useState("");
  const [sendForm, setSendForm] = useState({ open: false, module: "Bitcoin regtest", dest: "", amount: "" });

  const [chats, setChats] = useState<Chat[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);

  const [wstate, setWstate] = useState<WalletState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [signingId, setSigningId] = useState<string | null>(null);
  const [me, setMe] = useState<{ npub: string; label: string; participant_id: number | null } | null>(null);
  const [popover, setPopover] = useState<{
    npub: string;
    name: string;
    initials: string;
    color: string;
    role?: string;
  } | null>(null);
  const [signer, setSigner] = useState<NostrSigner | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [audit, setAudit] = useState<{ entries?: AuditEntryUI[]; restricted?: boolean }>({});
  const [members, setMembers] = useState<
    { npub: string; label: string; role: string; initials: string; color: string }[]
  >([]);
  const [relayMsgs, setRelayMsgs] = useState<Record<string, DecryptedMessage[]>>({});
  const [relayConnected, setRelayConnected] = useState<boolean | null>(null);
  const chatClientRef = useRef<NostrChatClient | null>(null);
  // Also held in state so the subscription effect can depend on the live client;
  // the ref stays for imperative reads in sendMsg/submitSend.
  const [chatClient, setChatClient] = useState<NostrChatClient | null>(null);
  const [chainTip, setChainTip] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const btcPrice = useBtcPrice();
  const VALID_DEFAULT_IDS = [1, 3, 4, 6, 7, 8];
  const [signerPick, setSignerPick] = useState<Set<number>>(new Set(VALID_DEFAULT_IDS));

  useEffect(() => {
    fetch("/api/chain/tip")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.height != null) setChainTip(d.height);
      })
      .catch(() => {});
  }, []);

  // Replace placeholder balances with the real on-chain balance of each vault's
  // receive address (fetched once per address). Deposits to the address show up.
  const balancedAddrs = useRef<Set<string>>(new Set());
  useEffect(() => {
    const targets = chats.filter(
      (c) => c.receiveAddress && !balancedAddrs.current.has(c.receiveAddress),
    );
    if (targets.length === 0) return;
    const targetIds = new Set(targets.map((c) => c.id));
    targets.forEach((c) => balancedAddrs.current.add(c.receiveAddress!));
    // Mark pending ("") so the UI shows a loading state, not the seeded number.
    setChats((prev) => prev.map((x) => (targetIds.has(x.id) ? { ...x, balanceBtc: "" } : x)));
    for (const c of targets) {
      void (async () => {
        let sats = 0;
        try {
          const r = await fetch(`/api/chain/address/${c.receiveAddress}`);
          if (r.ok) sats = ((await r.json()) as { totalSats: number }).totalSats;
        } catch {
          /* unreachable / demo address → treat as 0 */
        }
        const btc = sats / 1e8;
        setChats((prev) => prev.map((x) => (x.id === c.id ? { ...x, balanceBtc: btc.toFixed(8) } : x)));
      })();
    }
  }, [chats]);

  // Derive the real "Recent activity" feed from the on-chain tx history of every
  // vault receive address. Keyed on the address set (not the whole chats array)
  // so per-address balance ticks don't trigger a refetch.
  const vaultAddrPairs = JSON.stringify(
    chats.filter((c) => c.receiveAddress).map((c) => [c.receiveAddress, c.name] as const),
  );
  useEffect(() => {
    const pairs = JSON.parse(vaultAddrPairs) as [string, string][];
    if (pairs.length === 0) return; // no live addresses yet → keep loading state
    const addrToVault = new Map(pairs);
    const addrs = pairs.map(([a]) => a).join(",");
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/chain/activity?addrs=${encodeURIComponent(addrs)}&limit=8`);
        if (!r.ok || cancelled) return;
        const { activity: rows } = (await r.json()) as { activity: ActivityApiEntry[] };
        if (cancelled) return;
        setActivity(rows.map((e) => ({ ...e, vault: addrToVault.get(e.address) ?? e.address })));
      } catch {
        /* esplora unreachable → leave the prior activity state in place */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultAddrPairs]);

  const refreshAudit = useCallback(async (chatId: string) => {
    const res = await fetch(`/api/chats/${chatId}/audit`);
    if (res.status === 403) return setAudit({ restricted: true });
    if (!res.ok) return setAudit({});
    setAudit({ entries: ((await res.json()) as { entries: AuditEntryUI[] }).entries });
  }, []);

  const onLogout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }, []);

  // Demo signer roster for the sidebar switcher (empty if the backend is offline).
  useEffect(() => {
    fetch("/api/auth/personas")
      .then((r) => r.json())
      .then((d) => setPersonas((d.personas ?? []) as Persona[]))
      .catch(() => setPersonas([]));
  }, []);

  // One-tap switch to another demo persona: sign a fresh challenge with that
  // signer's deterministic secret, swap the session cookie, reload as them.
  const onSwitchPersona = useCallback(async (participantId: number) => {
    try {
      const { nonce } = (await (await fetch("/api/auth/challenge")).json()) as { nonce: string };
      const event = finalizeEvent(challengeTemplate(nonce), await personaSecret(participantId));
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event, nonce }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Switch failed");
      window.location.href = "/";
    } catch (e) {
      setStateError(e instanceof Error ? e.message : "Switch failed");
    }
  }, []);

  // A 401 from an authenticated route means the session cookie is stale: it's
  // *present* (so proxy.ts admitted us into the wallet) but no longer valid in
  // the DB — an expired or reset login. The cookie is httpOnly, so JS can't
  // clear it directly; hit logout to clear it server-side, then send the user
  // to re-authenticate. Beats stranding them on a wallet where every action
  // 401s behind a misleading "backend compiling" banner.
  const handleSessionExpired = useCallback(async () => {
    setStateError("Your session expired — taking you to sign in…");
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* redirect regardless of the logout result */
    }
    window.location.href = "/login";
  }, []);

  const onCreateChannel = useCallback(async () => {
    const name = window.prompt("New channel name (e.g. marketing)");
    if (!name?.trim()) return;
    try {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Create failed");
      const { chat } = (await res.json()) as { chat: Chat };
      setChats((prev) => [...prev, { ...chat, messages: [] }]);
      setView("chat");
      setActiveChat(chat.id);
      setDraft("");
    } catch (e) {
      setStateError(e instanceof Error ? e.message : "Create channel failed");
    }
  }, []);

  const [provisioningId, setProvisioningId] = useState<string | null>(null);
  const onCreateVault = useCallback(
    async (chatId: string) => {
      setProvisioningId(chatId);
      setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, vaultStatus: "pending" } : c)));
      try {
        const res = await fetch(`/api/vaults/${chatId}/provision`, { method: "POST" });
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Provision failed");
        const { chat } = (await res.json()) as { chat: Partial<Chat> };
        setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, ...chat } : c)));
        void refreshAudit(chatId);
      } catch (e) {
        setStateError(e instanceof Error ? e.message : "Provision failed");
        setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, vaultStatus: undefined } : c)));
      } finally {
        setProvisioningId(null);
      }
    },
    [refreshAudit],
  );

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
        } else if (meRes.status === 401) {
          // Cookie present but session invalid (proxy.ts is presence-only). Don't
          // render a wallet where every signed action will 401 — re-authenticate.
          if (!cancelled) void handleSessionExpired();
          return;
        }

        if (stateRes.ok) {
          const ws = (await stateRes.json()) as WalletState;
          setWstate(ws);
          const apiTreasury = apiChats.find((c) => c.id === "treasury");
          const liveVault = buildLiveVault(ws);
          const liveChat: Chat = {
            ...liveVault,
            // buildLiveVault has no member roster, so carry over the API's member
            // npubs — without them treasury contributes nothing to the relay
            // subscription's known-author gate and its messages get dropped.
            memberNpubs: apiTreasury?.memberNpubs ?? liveVault.memberNpubs,
            messages: [...liveVault.messages, ...(apiTreasury?.messages ?? [])],
          };
          setChats([liveChat, ...apiChats.filter((c) => c.id !== "treasury")]);
          // Approvals come straight from the DB — no hardcoded fixture overlay.
          setApprovals(apiApprovals);
        } else {
          const sj = await stateRes.json().catch(() => ({}));
          setStateError(
            sj.error ??
              "Couldn't load the live vault — the DKGKit backend may still be compiling; refresh in a moment.",
          );
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
  }, [handleSessionExpired]);

  // Poll for chats created after our initial load — e.g. a DM a peer just opened
  // with us — so they surface in the sidebar and the relay subscription (keyed on
  // the chat-id set) picks them up without a full reload. We only APPEND unknown
  // chats; existing ones keep their live-vault merge + fetched balances.
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/chats");
        if (!res.ok || cancelled) return;
        const fresh = ((await res.json()) as { chats?: Chat[] }).chats ?? [];
        if (!cancelled) setChats((prev) => mergeNewChats(prev, fresh));
      } catch {
        /* transient — retry on the next tick */
      }
    };
    const h = setInterval(() => void poll(), 7000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [me]);

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
  const toggleMembers = () => setShowMembers((s) => !s);

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

  // Load members roster when the active chat changes.
  useEffect(() => {
    setShowMembers(false); // close the channel-info dialog when switching chats
    if (!active) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/chats/${active.id}/members`);
      if (!res.ok) {
        if (!cancelled) setMembers([]);
        return;
      }
      const { members: rows } = (await res.json()) as { members: typeof members };
      if (!cancelled) setMembers(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [active?.id]);

  // Reset the signer picker whenever the send dialog opens.
  useEffect(() => {
    if (sendForm.open) setSignerPick(new Set(VALID_DEFAULT_IDS));
  }, [sendForm.open]);

  // Resolve the NIP-44 signer whenever the logged-in user changes.
  useEffect(() => {
    if (!me) {
      setSigner(null);
      return;
    }
    let cancelled = false;
    void resolveSigner({ npub: me.npub, participant_id: me.participant_id }).then((s) => {
      if (!cancelled) setSigner(s);
    });
    return () => {
      cancelled = true;
    };
  }, [me]);

  // Relay client lifecycle: connect ONCE per signer/me. The pool persists across
  // chat-set changes (only the subscription below refreshes), so opening a DM no
  // longer tears down and reconnects the relay.
  useEffect(() => {
    if (!signer || !me) return;
    let cancelled = false;
    const client = new NostrChatClient(signer, me.npub, relayUrl());
    chatClientRef.current = client;
    setChatClient(client);
    void client.ensureConnected().then((ok) => { if (!cancelled) setRelayConnected(ok); });
    return () => {
      cancelled = true;
      client.close();
      chatClientRef.current = null;
      setChatClient(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer, me?.npub]);

  // Subscription: (re)subscribe to all chats on the EXISTING client whenever the
  // chat-set or the known-author set changes. The old SubCloser is closed before
  // the new one opens (effect cleanup runs first). Re-subscribing replays relay
  // backfill, but the functional setRelayMsgs updater dedups by event id, so the
  // pool itself is never reconnected on a chat switch.
  const chatIdsKey = chats.map((c) => c.id).join(",");
  const knownAuthorsKey = [me?.npub ?? "", ...chats.flatMap((c) => c.memberNpubs ?? [])].join(",");
  useEffect(() => {
    if (!chatClient || !me || chats.length === 0) return;
    const chatIds = chats.map((c) => c.id);
    const knownAuthors = new Set<string>([me.npub, ...chats.flatMap((c) => c.memberNpubs ?? [])]);
    const sub = chatClient.subscribe(chatIds, knownAuthors, (m) => {
      setRelayMsgs((prev) => {
        const list = prev[m.chatId] ?? [];
        if (list.some((x) => x.id === m.id)) return prev; // dedup
        return { ...prev, [m.chatId]: [...list, m].sort((a, b) => a.createdAt - b.createdAt) };
      });
    });
    return () => {
      sub.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatClient, chatIdsKey, knownAuthorsKey]);

  // ---- approval actions ----
  // All signing is persisted server-side. For live approvals the route runs a
  // real grouped HTSS round in Rust and stores the aggregate signature; for
  // mock approvals it just records the signer. We take only the signing-result
  // fields back so the live approval keeps its richer display values.
  const onSign = useCallback(
    async (id: string) => {
      setSigningId(id);
      setStateError(null);
      try {
        const res = await fetch(`/api/approvals/${id}/sign`, { method: "POST" });
        if (res.status === 401) {
          await handleSessionExpired();
          return;
        }
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
    [active, refreshAudit, handleSessionExpired],
  );
  const onReject = (id: string) =>
    setApprovals((prev) => prev.map((t) => (t.id === id ? { ...t, status: "rejected" } : t)));
  // Broadcasting is a SEPARATE action from signing: only a `ready` transfer (quorum
  // reached + aggregate verified) can broadcast, and it settles the real tx on-chain.
  const onBroadcast = useCallback(
    async (id: string) => {
      setSigningId(id);
      setStateError(null);
      try {
        const res = await fetch(`/api/approvals/${id}/broadcast`, { method: "POST" });
        if (res.status === 401) {
          await handleSessionExpired();
          return;
        }
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Broadcast failed");
        const updated = json.approval as Approval;
        setApprovals((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: "broadcast", txid: updated.txid } : t)),
        );
        if (active) void refreshAudit(active.id);
      } catch (e) {
        setStateError(e instanceof Error ? e.message : "Broadcast failed");
      } finally {
        setSigningId(null);
      }
    },
    [active, refreshAudit, handleSessionExpired],
  );

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
  // Persisted policy-change propose flow (mirrors submitSend): POST a kind:"role"
  // approval carrying the full proposedPolicy + diff, then announce in chat. We do
  // NOT send a signerSet and do NOT trust the threshold — the server pins it to the
  // current quorum (see app/api/approvals/route.ts), so a proposer can't self-ratify.
  const proposePolicyChange = (chatId: string) => (draft: PolicyConfig, diff: PolicyDiffItem[]) => {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return;
    const policy = chat.tiers.map((t) => `${clampNeed(t)}/${t.keys.length}`).join(" + ");
    const threshold = chat.tiers.reduce((a, t) => a + clampNeed(t), 0);
    const proposal: Approval = {
      id: `rc${Date.now()}`,
      kind: "role",
      title: `Policy change · ${chat.name}`,
      changeLabel: diff.map((d) => d.text).join("  ·  "),
      detail: `Proposed in ${chat.name}`,
      requestedBy: "You",
      vault: chat.name,
      time: "just now",
      policy,
      threshold,
      total: threshold,
      signed: 0,
      youSigned: false,
      status: "pending",
      live: !!chat.receiveAddress,
      proposedPolicy: draft,
      policyDiff: diff,
    };
    const announce = `Proposed a policy change — ${diff.map((d) => d.text).join(", ")}. Needs the current ${policy} quorum to ratify.`;
    void (async () => {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposal),
      });
      if (!res.ok) {
        setStateError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Proposal failed");
        return;
      }
      const created = ((await res.json()) as { approval: Approval }).approval;
      setApprovals((prev) => [created, ...prev]);
      const relayClient = chatClientRef.current;
      if (relayClient) {
        const memberNpubs = members.map((m) => m.npub);
        if (memberNpubs.filter((n) => n !== me?.npub).length > 0) {
          try {
            await relayClient.publish(chatId, scopeFor(chat.type), memberNpubs, announce);
          } catch {
            // best-effort; the approval was already created
          }
        }
      }
      void fetch(`/api/chats/${chatId}/audit`, { method: "POST" }).then(() => refreshAudit(chatId));
    })();
  };

  // ---- chat messaging ----
  const sendMsg = () => {
    const text = draft.trim();
    if (!text || !activeChat) return;
    if (text.toLowerCase() === "/send") {
      setDraft("");
      setSendForm({ open: true, module: "Bitcoin regtest", dest: "", amount: "" });
      return;
    }
    const cid = activeChat;
    const chat = active;
    setDraft("");
    void (async () => {
      const client = chatClientRef.current;
      if (!client || !chat) {
        setStateError("Chat unavailable — the relay isn't connected yet");
        return;
      }
      const memberNpubs = members.map((m) => m.npub);
      const others = memberNpubs.filter((n) => n !== me?.npub);
      if (others.length === 0) {
        setStateError("No recipients yet — the member list is still loading. Try again in a moment.");
        return;
      }
      try {
        await client.publish(cid, scopeFor(chat.type), memberNpubs, text);
      } catch (e) {
        setStateError(e instanceof Error ? e.message : "Message failed to send");
        return;
      }
      // Metadata-only audit ping (no content); best-effort.
      void fetch(`/api/chats/${cid}/audit`, { method: "POST" }).then(() => refreshAudit(cid));
      // The sender's own fan-out copy comes back via the relay subscription, so
      // no optimistic insert is needed — it appears when the relay echoes it.
    })();
  };
  const startDm = useCallback(
    async (targetNpub: string) => {
      setPopover(null);
      const res = await fetch("/api/dms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetNpub }),
      });
      if (!res.ok) {
        setStateError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not open DM");
        return;
      }
      const { chat } = (await res.json()) as { chat: Chat };
      setChats((prev) => (prev.some((c) => c.id === chat.id) ? prev : [...prev, chat]));
      setActiveChat(chat.id);
      setView("chat");
    },
    [],
  );

  const submitSend = () => {
    const amt = parseFloat(sendForm.amount);
    if (!activeChat || !sendForm.dest.trim() || !(amt > 0)) return;
    const chat = chats.find((c) => c.id === activeChat);
    if (!chat) return;
    const chosen = personas.filter((p) => signerPick.has(p.participant_id));
    const threshold = chosen.length > 0 ? chosen.length : chat.tiers.reduce((a, t) => a + clampNeed(t), 0);
    const policy = chosen.length > 0 ? `${chosen.length} chosen signers` : chat.tiers.map((t) => `${clampNeed(t)}/${t.keys.length}`).join(" + ");
    const dest = sendForm.dest.trim();
    const destShort = dest.length > 16 ? `${dest.slice(0, 8)}…${dest.slice(-4)}` : dest;
    const usd = btcPrice != null ? Math.round(amt * btcPrice).toLocaleString("en-US") : "";
    const cid = activeChat;
    const module = sendForm.module;
    setSendForm({ open: false, module: "Bitcoin regtest", dest: "", amount: "" });
    const proposal: Approval = {
      id: `tx${Date.now()}`,
      kind: "send",
      title: `Transfer · ${module}`,
      dest: destShort,
      destLabel: module,
      recipientAddress: dest,
      amountSats: Math.round(amt * 1e8),
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
      // A transfer out of a real DKG vault signs a live grouped HTSS round and
      // can be broadcast on-chain. Plain DMs (no receive address) stay mock.
      live: !!chat.receiveAddress,
    };
    const announce = `Requested a transfer — ${amt} BTC to ${destShort} on ${module}. Needs a ${policy} quorum — please review and sign in Approvals.`;
    void (async () => {
      const signerNpubs = chosen.map((p) => p.npub);
      const postBody = chosen.length > 0 ? { ...proposal, signerNpubs } : proposal;
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(postBody),
      });
      const created = res.ok ? ((await res.json()) as { approval: Approval }).approval : proposal;
      setApprovals((prev) => [created, ...prev]);

      const relayClient = chatClientRef.current;
      if (relayClient) {
        const memberNpubs = members.map((m) => m.npub);
        const others = memberNpubs.filter((n) => n !== me?.npub);
        if (others.length > 0) {
          try {
            await relayClient.publish(cid, scopeFor(chat.type), memberNpubs, announce);
          } catch {
            // best-effort; the approval was already created
          }
        }
      }
      // Metadata-only audit ping (no content); best-effort.
      void fetch(`/api/chats/${cid}/audit`, { method: "POST" }).then(() => refreshAudit(cid));
    })();
  };

  // ---- derived values ----
  // Only chats with a shared vault count toward treasury totals (DMs are chat-only).
  const vaultChats = chats.filter((c) => c.vaultStatus || c.tiers.length > 0);
  const totalBtc = vaultChats.reduce((s, c) => s + (parseFloat(c.balanceBtc) || 0), 0);
  const balancesPending = vaultChats.some((c) => c.receiveAddress && c.balanceBtc === "");
  const totalKeys = vaultChats.reduce((s, c) => s + c.tiers.reduce((a, t) => a + t.keys.length, 0), 0);
  const vaultCount = vaultChats.length;
  const youNeed = approvals.filter((t) => {
    if (t.status !== "pending" || t.youSigned) return false;
    if (!t.signerSet) return true;
    return t.signerSet.some((s) => s.npub === (me?.npub ?? ""));
  }).length;
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
      const activeHasVault = !!active.vaultStatus || active.tiers.length > 0;
      if (active.type === "direct") {
        pageSub = activeHasVault
          ? `Direct message · secured by a ${quorumOf(active.tiers)} vault`
          : "Direct message";
      } else {
        pageSub = `${active.members} members · secured by a ${quorumOf(active.tiers)} vault`;
      }
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
        onCreateChannel={onCreateChannel}
        me={me}
        personas={personas}
        onSwitchPersona={onSwitchPersona}
        onLogout={onLogout}
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
              {btcPrice != null ? `BTC $${btcPrice.toLocaleString("en-US")}` : "BTC · syncing…"}
            </div>
            {chainTip != null && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface2, border: `1px solid ${C.line2}`, borderRadius: 9, padding: "8px 12px", fontSize: 12.5, color: "#9CA1A7" }} title="Live regtest chain tip">
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.orange, boxShadow: "0 0 0 3px rgba(247,147,26,.16)" }} />
                regtest · tip {chainTip.toLocaleString("en-US")}
              </div>
            )}
            {me && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface2, border: `1px solid ${C.line2}`, borderRadius: 9, padding: "6px 8px 6px 12px", fontSize: 12.5, color: "#9CA1A7" }}>
                <span>
                  {me.label}
                  {me.participant_id != null ? (
                    <span style={{ color: C.green }}> · signer #{me.participant_id}</span>
                  ) : (
                    <span style={{ color: C.faint }}> · observer</span>
                  )}
                </span>
                <button onClick={onLogout} title="Sign out" style={{ background: "transparent", border: `1px solid ${C.line2}`, color: "#C5C9CE", borderRadius: 7, padding: "4px 9px", fontSize: 11.5, fontFamily: "inherit", cursor: "pointer" }}>
                  Sign out
                </button>
              </div>
            )}
            <button onClick={go("approvals")} style={{ display: "flex", alignItems: "center", gap: 9, background: C.orange, color: C.bg, border: "none", borderRadius: 9, padding: "9px 15px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
              New transfer
            </button>
          </div>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: 30 }}>
          {stateError && (
            <div style={{ marginBottom: 18, background: "rgba(240,97,109,.08)", border: "1px solid rgba(240,97,109,.3)", color: C.red, borderRadius: 12, padding: "12px 16px", fontSize: 12.5 }}>
              {stateError}
            </div>
          )}

          {view === "overview" && (
            <Overview
              wstate={wstate}
              balanceBtc={balancesPending ? "…" : totalBtc.toFixed(2)}
              balanceUsd={balancesPending || btcPrice == null ? "…" : Math.round(totalBtc * btcPrice).toLocaleString("en-US")}
              vaultCount={vaultCount}
              totalKeys={totalKeys}
              youNeed={youNeed}
              activity={activity}
              vaultChats={vaultChats}
              openChat={openChat}
              goApprovals={go("approvals")}
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
              audit={audit}
              pendingApprovals={approvals.filter(
                (a) => a.vault === active.name && a.status === "pending",
              )}
              onSign={onSign}
              signingId={signingId}
              provisioning={provisioningId === active.id}
              showVault={showVault}
              toggleVault={toggleVault}
              showMembers={showMembers}
              toggleMembers={toggleMembers}
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
              proposePolicy={proposePolicyChange}
              onAuthorClick={(m) =>
                m.npub &&
                setPopover({ npub: m.npub, name: m.name, initials: m.initials, color: m.color })
              }
              members={members}
              onMemberClick={(mem) =>
                setPopover({ npub: mem.npub, name: mem.label, initials: mem.initials, color: mem.color, role: mem.role })
              }
              relayMessages={relayMsgs[active.id] ?? []}
              relayConnected={relayConnected}
              meNpub={me?.npub ?? ""}
              personas={personas}
              signerPick={signerPick}
              setSignerPick={setSignerPick}
            />
          )}

          {view === "plan" && <Plan />}
        </div>
      </main>
      {popover && me && (
        <ProfilePopover
          npub={popover.npub}
          name={popover.name}
          initials={popover.initials}
          color={popover.color}
          role={popover.role}
          isSelf={popover.npub === me.npub}
          onStartDm={(npub) => void startDm(npub)}
          onClose={() => setPopover(null)}
        />
      )}
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
  onCreateChannel,
  me,
  personas,
  onSwitchPersona,
  onLogout,
}: {
  view: View;
  active: Chat | null;
  chats: Chat[];
  youNeed: number;
  go: (v: View) => () => void;
  openChat: (id: string) => () => void;
  goPlan: () => void;
  onCreateChannel: () => void;
  me: { npub: string; label: string; participant_id: number | null } | null;
  personas: Persona[];
  onSwitchPersona: (participantId: number) => void;
  onLogout: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 10px 3px" }}>
          <span style={{ fontSize: 10, color: "#5E6369", letterSpacing: ".5px" }}>CHANNELS</span>
          <button
            onClick={onCreateChannel}
            title="Create a channel vault"
            style={{ background: "transparent", border: "none", color: C.orange, fontSize: 15, lineHeight: 1, cursor: "pointer", fontFamily: "inherit", padding: "0 2px" }}
          >
            +
          </button>
        </div>
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
        <div style={{ background: "rgba(247,147,26,.07)", border: "1px solid rgba(247,147,26,.22)", borderRadius: 12, padding: "13px 14px" }}>
          <div style={{ fontSize: 11, color: C.sand, letterSpacing: ".3px", marginBottom: 6 }}>SELF-CUSTODY</div>
          <div style={{ fontSize: 12.5, color: "#C5C9CE", lineHeight: 1.45 }}>No keys held by BTech. Your quorum, your coins.</div>
        </div>
        <div style={{ position: "relative", borderTop: `1px solid ${C.line}`, paddingTop: 11 }}>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
              <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, zIndex: 31, background: C.surface2, border: `1px solid ${C.line2}`, borderRadius: 12, padding: 6, boxShadow: "0 14px 36px rgba(0,0,0,.55)" }}>
                <div style={{ fontSize: 10, color: C.faint, letterSpacing: ".4px", padding: "6px 8px 5px" }}>SWITCH SIGNER · DEMO</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 248, overflowY: "auto" }}>
                  {personas.length === 0 && (
                    <div style={{ fontSize: 11.5, color: C.faint, padding: "6px 8px" }}>No demo signers loaded.</div>
                  )}
                  {personas.map((p) => {
                    const current = me?.npub === p.npub;
                    return (
                      <button
                        key={p.npub}
                        onClick={() => {
                          setMenuOpen(false);
                          if (!current) void onSwitchPersona(p.participant_id);
                        }}
                        style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", border: "none", background: current ? C.orangeSoft : "transparent", borderRadius: 8, padding: "7px 8px", cursor: current ? "default" : "pointer", fontFamily: "inherit", textAlign: "left", color: C.ink }}
                      >
                        <span style={{ width: 22, height: 22, flex: "0 0 22px", borderRadius: 6, background: current ? C.orange : "#23262B", color: current ? C.bg : C.muted, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9.5, fontWeight: 700 }}>{initialsOf(p.label)}</span>
                        <span style={{ flex: 1, minWidth: 0, lineHeight: 1.2 }}>
                          <span style={{ display: "block", fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.label}</span>
                          <span style={{ display: "block", fontSize: 10.5, color: C.faint }}>{p.role} · #{p.participant_id}</span>
                        </span>
                        {current && <span style={{ flex: "0 0 auto", fontSize: 9, color: C.orange }}>● now</span>}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    void onLogout();
                  }}
                  style={{ width: "100%", marginTop: 4, border: "none", borderTop: `1px solid ${C.line2}`, background: "transparent", color: C.faint2, fontSize: 11.5, fontFamily: "inherit", padding: "9px 8px 5px", textAlign: "left", cursor: "pointer" }}
                >
                  Sign out
                </button>
              </div>
            </>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 8px 4px" }}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              disabled={!me}
              title="Switch signer"
              style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, border: "none", background: "transparent", padding: 0, cursor: me ? "pointer" : "default", fontFamily: "inherit", textAlign: "left", color: C.ink }}
            >
              <div style={{ width: 30, height: 30, flex: "0 0 30px", borderRadius: 8, background: "#23262B", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, color: C.muted }}>{me ? initialsOf(me.label) : "…"}</div>
              <div style={{ lineHeight: 1.15, flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{me?.label ?? "Signing in…"}</div>
                <div style={{ fontSize: 11, color: C.faint }}>
                  {me ? (me.participant_id != null ? `Signer #${me.participant_id} · switch` : "Observer · switch") : ""}
                </div>
              </div>
              <span style={{ flex: "0 0 auto", color: C.faint, fontSize: 9, transform: menuOpen ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }}>▲</span>
            </button>
            <button onClick={goPlan} style={{ flex: "0 0 auto", background: C.orangeSoft, border: "1px solid rgba(247,147,26,.32)", color: C.orange, fontSize: 11, fontWeight: 600, fontFamily: "inherit", padding: "6px 11px", borderRadius: 8, cursor: "pointer" }}>Upgrade</button>
          </div>
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
  youNeed,
  activity,
  vaultChats,
  openChat,
  goApprovals,
}: {
  wstate: WalletState | null;
  balanceBtc: string;
  balanceUsd: string;
  vaultCount: number;
  totalKeys: number;
  youNeed: number;
  activity: ActivityRow[] | null;
  vaultChats: Chat[];
  openChat: (id: string) => () => void;
  goApprovals: () => void;
}) {
  const [selId, setSelId] = useState("");
  const sel =
    vaultChats.find((c) => c.id === selId) ?? vaultChats.find((c) => c.live) ?? vaultChats[0];
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
            <span style={{ fontFamily: MONO, fontSize: 34, fontWeight: 600, color: C.orange }}>{youNeed}</span>
            <span style={{ fontSize: 14, color: C.faint2 }}>transactions</span>
          </div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 16, background: C.orange, color: C.bg, fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 8 }}>Review approvals →</div>
        </div>
      </div>

      {wstate && <LiveVaultCard wstate={wstate} />}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.line2}`, borderRadius: 16, padding: "6px 4px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, padding: "16px 20px 12px" }}>Recent activity</div>
          {activity == null ? (
            <div style={{ fontSize: 12, color: C.faint, padding: "8px 20px 16px" }}>Loading on-chain activity…</div>
          ) : activity.length === 0 ? (
            <div style={{ fontSize: 12, color: C.faint, padding: "8px 20px 16px" }}>No on-chain activity yet.</div>
          ) : (
            activity.map((a) => {
              const inbound = a.direction === "in";
              return (
                <div key={`${a.txid}:${a.address}`} style={{ display: "flex", alignItems: "center", gap: 13, padding: "11px 20px", borderTop: "1px solid rgba(255,255,255,.05)" }}>
                  <span style={{ width: 32, height: 32, borderRadius: 9, background: inbound ? "rgba(63,185,80,.12)" : "rgba(240,97,109,.12)", color: inbound ? C.green : C.red, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flex: "0 0 32px" }}>{inbound ? "↓" : "↑"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{inbound ? "Receive" : "Send"}</div>
                    <div style={{ fontSize: 11.5, color: C.faint2, fontFamily: MONO }}>
                      {a.vault} · {a.txid.slice(0, 8)}…{!a.confirmed && " · pending"}
                    </div>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 12.5, color: inbound ? C.green : C.red, textAlign: "right" }}>
                    {inbound ? "+" : "−"}{fmtBtc(a.deltaSats)} BTC
                    <div style={{ fontSize: 10.5, color: C.faint }}>{relTime(a.blockTime)}</div>
                  </div>
                  <a
                    href={a.txUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="View transaction on block explorer"
                    style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 8, border: `1px solid ${C.line2}`, color: C.faint2, textDecoration: "none", fontSize: 13 }}
                  >
                    ↗
                  </a>
                </div>
              );
            })
          )}
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.line2}`, borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column" }}>
          {!sel ? (
            <div style={{ fontSize: 12.5, color: C.faint2 }}>No vaults yet.</div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <select
                  value={sel.id}
                  onChange={(e) => setSelId(e.target.value)}
                  style={{ background: C.surface2, border: `1px solid ${C.line2}`, color: C.ink, borderRadius: 8, padding: "6px 10px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", outline: "none", maxWidth: "60%" }}
                  title="Switch vault"
                >
                  {vaultChats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button onClick={openChat(sel.id)} style={{ flex: "0 0 auto", background: "transparent", border: `1px solid ${C.line2}`, color: "#C5C9CE", fontSize: 11.5, fontFamily: "inherit", padding: "5px 11px", borderRadius: 7, cursor: "pointer" }}>Open chat &amp; vault</button>
              </div>

              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginTop: 16 }}>
                <span style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600, letterSpacing: "-.5px" }}>
                  {sel.balanceBtc === "" ? "…" : sel.balanceBtc}
                  <span style={{ fontSize: 13, color: C.orange, fontWeight: 600 }}> BTC</span>
                </span>
                {sel.tiers.length > 0 && (
                  <span style={{ fontFamily: MONO, fontSize: 12, color: C.faint2, textAlign: "right" }}>{quorumOf(sel.tiers)}</span>
                )}
              </div>

              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 11 }}>
                {sel.tiers.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: C.faint2 }}>No signing tiers configured for this vault.</div>
                ) : (
                  sel.tiers.map((t, i) => (
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
                  ))
                )}
              </div>

              <div style={{ marginTop: "auto", paddingTop: 16, fontSize: 11.5, color: C.faint2, lineHeight: 1.5 }}>
                Every spend needs a quorum from <span style={{ color: "#C5C9CE" }}>each</span> tier. Edit the policy inside the chat.
              </div>
            </>
          )}
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
  audit,
  pendingApprovals,
  onSign,
  signingId,
  provisioning,
  showVault,
  toggleVault,
  showMembers,
  toggleMembers,
  draft,
  setDraft,
  onSendMsg,
  sendForm,
  setSendForm,
  submitSend,
  setThreshold,
  removeKey,
  proposeKey,
  proposePolicy,
  onAuthorClick,
  members,
  onMemberClick,
  relayMessages,
  relayConnected,
  meNpub,
  personas,
  signerPick,
  setSignerPick,
}: {
  chat: Chat;
  audit: { entries?: AuditEntryUI[]; restricted?: boolean };
  pendingApprovals: Approval[];
  onSign: (id: string) => void;
  signingId: string | null;
  provisioning: boolean;
  showVault: boolean;
  toggleVault: () => void;
  showMembers: boolean;
  toggleMembers: () => void;
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
  proposePolicy: (chatId: string) => (draft: PolicyConfig, diff: PolicyDiffItem[]) => void;
  onAuthorClick: (a: { npub: string; name: string; initials: string; color: string; role?: string }) => void;
  members: { npub: string; label: string; role: string; initials: string; color: string }[];
  onMemberClick: (m: { npub: string; label: string; role: string; initials: string; color: string }) => void;
  relayMessages: DecryptedMessage[];
  relayConnected: boolean | null;
  meNpub: string;
  personas: Persona[];
  signerPick: Set<number>;
  setSignerPick: (updater: Set<number> | ((prev: Set<number>) => Set<number>)) => void;
}) {
  const quorum = quorumOf(chat.tiers);
  const hasVault = !!chat.vaultStatus || chat.tiers.length > 0;
  const isDirect = chat.type === "direct";
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 126px)", gap: 14 }}>
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            {chat.name}
            {chat.live && <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: ".4px", color: C.green, background: "rgba(63,185,80,.12)", padding: "2px 7px", borderRadius: 20 }}>LIVE</span>}
            {chat.receiveAddress && <AddressChip address={chat.receiveAddress} />}
          </div>
          <div style={{ fontSize: 11.5, color: C.faint2, display: "flex", alignItems: "center", gap: 7, marginTop: 2 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.green }} />
            {isDirect ? "Direct message" : "Channel"} · {chat.members} members
            <span style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: relayConnected === true ? C.green : relayConnected === null ? "#F0A500" : "#E05252", flexShrink: 0 }} />
              <span style={{ fontSize: 10.5, color: C.faint }}>
                {relayConnected === true ? "relay" : relayConnected === null ? "connecting…" : "relay offline"}
              </span>
            </span>
          </div>
          {hasVault &&
            (chat.receiveAddress ? (
              <VaultBalance address={chat.receiveAddress} />
            ) : (
              <div style={{ marginTop: 8, fontSize: 11.5, color: C.sand, display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.sand }} />
                {provisioning || chat.vaultStatus === "pending" ? "Provisioning vault… running DKG" : "Address provisioning…"}
              </div>
            ))}
        </div>
        <button onClick={toggleMembers} title="Channel info" style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8, background: C.surface2, border: `1px solid ${showMembers ? C.orange : "rgba(255,255,255,.1)"}`, color: showMembers ? C.orange : "#C5C9CE", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap", padding: "9px 14px", borderRadius: 9, cursor: "pointer" }}>
          <span style={{ fontFamily: MONO }}>{members.length}</span> Members
        </button>
        {hasVault && (
          <button onClick={toggleVault} style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8, background: C.surface2, border: `1px solid ${showVault ? C.orange : "rgba(255,255,255,.1)"}`, color: showVault ? C.orange : "#C5C9CE", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap", padding: "9px 14px", borderRadius: 9, cursor: "pointer" }}>
            <span style={{ fontFamily: MONO }}>{quorum}</span> {showVault ? "Hide vault policy" : "Vault policy"}
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 18, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "#101216", border: `1px solid ${C.line2}`, borderRadius: 16, overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
            {/* Seeded/historical context for channels (plaintext demo content).
                DMs are relay-only — their persisted rows may be ciphertext from the
                pre-relay path — so we render stored history for channels only. */}
            {chat.type !== "direct" &&
              chat.messages.map((m) => (
                <div key={m.id} style={{ display: "flex", gap: 12 }}>
                  <button
                    type="button"
                    onClick={() => m.authorNpub && onAuthorClick({ npub: m.authorNpub, name: m.who, initials: m.initials, color: m.color })}
                    disabled={!m.authorNpub}
                    title={m.authorNpub ? "View profile" : undefined}
                    style={{ background: "none", border: "none", padding: 0, cursor: m.authorNpub ? "pointer" : "default" }}
                  >
                    <span style={{ width: 34, height: 34, borderRadius: 10, background: m.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: C.bg, flex: "0 0 34px" }}>{m.initials}</span>
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{m.who}</span>
                      <span style={{ fontSize: 10.5, color: C.faint }}>{m.time}</span>
                    </div>
                    <div style={{ fontSize: 13, color: "#C5C9CE", lineHeight: 1.55, marginTop: 4 }}>{m.text}</div>
                  </div>
                </div>
              ))}
            {relayMessages.map((m) => {
              const mem = members.find((x) => x.npub === m.authorNpub);
              const who = m.authorNpub === meNpub ? "You" : mem?.label ?? `${m.authorNpub.slice(0, 12)}…`;
              const initials = mem?.initials ?? (who === "You" ? "ME" : "??");
              const color = mem?.color ?? "#6FB1FF";
              return (
                <div key={m.id} style={{ display: "flex", gap: 12 }}>
                  <button
                    type="button"
                    onClick={() => onAuthorClick({ npub: m.authorNpub, name: who, initials, color })}
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
                  >
                    <span style={{ width: 34, height: 34, borderRadius: 10, background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: C.bg, flex: "0 0 34px" }}>{initials}</span>
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{who}</span>
                      <span style={{ fontSize: 10.5, color: C.faint }}>{new Date(m.createdAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      <span title="NIP-44 encrypted · signed" style={{ fontSize: 10, fontWeight: 600, color: C.green, background: "rgba(63,185,80,.12)", padding: "2px 6px", borderRadius: 20 }}>🔒</span>
                    </div>
                    <div style={{ fontSize: 13, color: "#C5C9CE", lineHeight: 1.55, marginTop: 4 }}>{m.text}</div>
                  </div>
                </div>
              );
            })}
            {(chat.type === "direct"
              ? relayMessages.length === 0
              : chat.messages.length === 0 && relayMessages.length === 0) && (
              <div style={{ margin: "auto", textAlign: "center", color: C.faint, fontSize: 12.5, maxWidth: 300, lineHeight: 1.6 }}>
                {relayConnected === false
                  ? "Relay offline — messages can't be delivered right now."
                  : relayConnected === null
                    ? "Connecting to the relay…"
                    : "No messages yet. Say hello — messages are NIP-44 encrypted and delivered peer-to-peer over the relay."}
              </div>
            )}
          </div>
          <div style={{ flex: "0 0 auto", borderTop: `1px solid ${C.line}`, padding: "14px 16px" }}>
            {hasVault && sendForm.open && (
              <div style={{ background: "#0E1014", border: "1px solid rgba(247,147,26,.3)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: C.orange }}>Propose a BTC transfer</span>
                  <button onClick={() => setSendForm({ open: false, module: "Bitcoin regtest", dest: "", amount: "" })} title="Cancel" style={{ width: 22, height: 22, border: "none", background: "transparent", color: C.faint2, fontSize: 16, cursor: "pointer", fontFamily: "inherit" }}>×</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Field label="CHAIN / MODULE">
                    <select value={sendForm.module} onChange={(e) => setSendForm({ ...sendForm, module: e.target.value })} style={inputStyle}>
                      <option>Bitcoin regtest</option>
                      <option>Lightning</option>
                      <option>Liquid</option>
                    </select>
                  </Field>
                  <Field label="DESTINATION">
                    <input value={sendForm.dest} onChange={(e) => setSendForm({ ...sendForm, dest: e.target.value })} placeholder="bcrt1q… address or invoice" style={{ ...inputStyle, fontFamily: MONO }} />
                  </Field>
                  <Field label="AMOUNT (BTC)">
                    <input value={sendForm.amount} onChange={(e) => setSendForm({ ...sendForm, amount: e.target.value })} inputMode="decimal" placeholder="0.00" style={{ ...inputStyle, fontFamily: MONO }} />
                  </Field>
                </div>
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: C.faint, marginBottom: 6 }}>
                    Signers ({signerPick.size} chosen · all must sign)
                  </div>
                  {personas.map((p) => {
                    const on = signerPick.has(p.participant_id);
                    return (
                      <label key={p.participant_id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setSignerPick((prev) => {
                              const next = new Set(prev);
                              if (on) next.delete(p.participant_id);
                              else next.add(p.participant_id);
                              return next;
                            })
                          }
                        />
                        <span>{p.label}</span>
                        <span style={{ color: C.faint }}>· {p.role} · #{p.participant_id}</span>
                      </label>
                    );
                  })}
                </div>
                <button onClick={submitSend} style={{ width: "100%", marginTop: 12, background: C.orange, border: "none", color: C.bg, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", padding: 10, borderRadius: 8, cursor: "pointer" }}>
                  Request signatures from {quorum}
                </button>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", background: C.surface2, border: "1px solid rgba(255,255,255,.08)", borderRadius: 11, padding: "6px 6px 6px 8px" }}>
              {hasVault && (
                <button onClick={() => setSendForm({ open: true, module: "Bitcoin regtest", dest: "", amount: "" })} title="Propose a BTC transfer" style={{ flex: "0 0 auto", width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "rgba(247,147,26,.14)", color: C.orange, borderRadius: 8, cursor: "pointer", fontFamily: MONO, fontSize: 17, fontWeight: 700 }}>₿</button>
              )}
              <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSendMsg(); } }} placeholder={`Message ${chat.name}`} style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: C.ink, fontSize: 13, fontFamily: "inherit" }} />
              <button onClick={onSendMsg} style={{ flex: "0 0 auto", background: C.orange, border: "none", color: C.bg, fontSize: 13, fontWeight: 600, fontFamily: "inherit", padding: "8px 18px", borderRadius: 8, cursor: "pointer" }}>Send</button>
            </div>
            <div style={{ fontSize: 10.5, color: "#5E6369", marginTop: 9, padding: "0 2px", lineHeight: 1.5 }}>
              {hasVault ? (
                <>Tap <span style={{ color: C.sand }}>₿</span> (or type <span style={{ color: C.sand, fontFamily: MONO }}>/send</span>) to propose a BTC transfer. Signed with your Nostr key and relayed over Nostr.</>
              ) : (
                <>Direct message. Create a shared vault from the panel to send bitcoin together.</>
              )}
            </div>
          </div>
        </div>

        {showVault && hasVault && (
          <VaultPanel
            chat={chat}
            setThreshold={setThreshold}
            removeKey={removeKey}
            proposeKey={proposeKey}
            roster={personas.map((p) => ({ npub: p.npub, label: p.label, participantId: p.participant_id }))}
            onProposePolicy={proposePolicy}
          />
        )}
        {!isDirect && (
          <div style={{ flex: "0 0 296px", display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
            <OngoingProposals proposals={pendingApprovals} onSign={onSign} signingId={signingId} />
            <AuditPanel audit={audit} />
          </div>
        )}
      </div>

      {showMembers && (
        <>
          <div onClick={toggleMembers} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 60 }} />
          <div
            role="dialog"
            aria-label="Channel info"
            style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 61, width: 380, maxWidth: "90vw", maxHeight: "80vh", overflowY: "auto", background: C.surface, border: `1px solid ${C.line2}`, borderRadius: 16, padding: 18, boxShadow: "0 24px 64px rgba(0,0,0,.6)" }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                  {chat.name}
                  {chat.live && <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: ".4px", color: C.green, background: "rgba(63,185,80,.12)", padding: "2px 7px", borderRadius: 20 }}>LIVE</span>}
                </div>
                <div style={{ fontSize: 11.5, color: C.faint2, marginTop: 3 }}>
                  {isDirect ? "Direct message" : "Channel"} · {members.length} member{members.length === 1 ? "" : "s"}
                  {hasVault && <> · secured by a {quorum} vault</>}
                </div>
              </div>
              <button onClick={toggleMembers} title="Close" aria-label="Close" style={{ flex: "0 0 auto", border: "none", background: "transparent", color: C.faint2, fontSize: 22, lineHeight: 1, cursor: "pointer", fontFamily: "inherit" }}>×</button>
            </div>

            <div style={{ fontSize: 10, color: "#5E6369", letterSpacing: ".5px", margin: "18px 0 8px" }}>MEMBERS · {members.length}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {members.length === 0 && <div style={{ fontSize: 11.5, color: C.faint, padding: "4px 6px" }}>No members loaded.</div>}
              {members.map((mem) => (
                <button
                  key={mem.npub}
                  type="button"
                  onClick={() => {
                    toggleMembers();
                    onMemberClick(mem);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", padding: "7px 6px", borderRadius: 8, cursor: "pointer", textAlign: "left", color: "inherit", width: "100%" }}
                >
                  <span style={{ width: 26, height: 26, borderRadius: 7, background: mem.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10.5, fontWeight: 700, color: "#0E1013", flex: "0 0 26px" }}>{mem.initials}</span>
                  <span style={{ flex: 1, minWidth: 0, lineHeight: 1.2 }}>
                    <span style={{ display: "block", fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mem.label}</span>
                    <span style={{ display: "block", fontSize: 10.5, color: C.faint }}>{mem.role}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ===========================================================================
// Address chip — compact receive address with copy, shown in the chat header
// ===========================================================================

function AddressChip({ address }: { address: string }) {
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

// ===========================================================================
// Vault balance — live on-chain balance for the receive address, shown in the
// chat header right under the address (no separate "Shared vault" card).
// ===========================================================================

function VaultBalance({ address }: { address: string }) {
  const [chain, setChain] = useState<{ totalSats: number; confirmedSats: number; mempoolSats: number } | null>(null);
  const [chainErr, setChainErr] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setChain(null);
    setChainErr(false);
    fetch(`/api/chain/address/${address}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("chain"))))
      .then((d) => !cancelled && setChain(d))
      .catch(() => !cancelled && setChainErr(true));
    return () => {
      cancelled = true;
    };
  }, [address]);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10.5, color: C.faint2, letterSpacing: ".3px" }}>On-chain balance · regtest</div>
      <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 600, color: chain && chain.totalSats > 0 ? C.green : "#C5C9CE", marginTop: 2 }}>
        {chain
          ? `${(chain.totalSats / 1e8).toFixed(8)} BTC`
          : chainErr
            ? "—"
            : "checking…"}
        {chain && chain.mempoolSats > 0 && (
          <span style={{ color: C.sand, fontSize: 12, fontWeight: 400 }}> ({(chain.mempoolSats / 1e8).toFixed(8)} pending)</span>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Ongoing proposals — pending approvals for this vault, awaiting a quorum
// ===========================================================================

function OngoingProposals({
  proposals,
  onSign,
  signingId,
}: {
  proposals: Approval[];
  onSign: (id: string) => void;
  signingId: string | null;
}) {
  return (
    <aside style={{ flex: "0 0 auto", background: C.surface, border: `1px solid ${C.line2}`, borderRadius: 16, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Ongoing proposals</div>
      <div style={{ fontSize: 10.5, color: C.faint, marginTop: 2, marginBottom: 12 }}>
        Awaiting a signing quorum
      </div>
      {proposals.length === 0 ? (
        <div style={{ fontSize: 11.5, color: C.faint2 }}>No proposals in flight.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {proposals.map((p) => {
            const pct = Math.min(100, Math.round((p.signed / Math.max(1, p.threshold)) * 100));
            return (
              <div key={p.id} style={{ borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{p.title}</div>
                {p.btc && (
                  <div style={{ fontFamily: MONO, fontSize: 11, color: C.faint2, marginTop: 2 }}>
                    {p.btc} BTC{p.dest ? ` → ${p.dest}` : ""}
                  </div>
                )}
                <div style={{ marginTop: 8, height: 5, background: "rgba(255,255,255,.06)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: C.orange }} />
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7 }}>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.faint2 }}>
                    {p.signed}/{p.threshold} signed
                  </span>
                  <button
                    onClick={() => onSign(p.id)}
                    disabled={p.youSigned || signingId === p.id}
                    style={{
                      background: p.youSigned ? "transparent" : C.orange,
                      color: p.youSigned ? C.faint2 : C.bg,
                      border: p.youSigned ? `1px solid ${C.line2}` : "none",
                      borderRadius: 7,
                      padding: "4px 10px",
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: "inherit",
                      cursor: p.youSigned ? "default" : "pointer",
                    }}
                  >
                    {signingId === p.id ? "Signing…" : p.youSigned ? "You signed" : "Sign"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

// ===========================================================================
// Audit panel — per-chat activity, visible to vault members only
// ===========================================================================

const AUDIT_GLYPH: Record<AuditEntryUI["action"], string> = {
  sign: "✓",
  propose: "◆",
  message: "·",
  join: "→",
};
const AUDIT_VERB: Record<AuditEntryUI["action"], string> = {
  sign: "signed",
  propose: "proposed",
  message: "posted a message",
  join: "joined",
};

function AuditPanel({ audit }: { audit: { entries?: AuditEntryUI[]; restricted?: boolean } }) {
  return (
    <aside
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: C.surface,
        border: `1px solid ${C.line2}`,
        borderRadius: 16,
        padding: 16,
        overflow: "hidden",
      }}
    >
      <div style={{ flex: "0 0 auto", fontSize: 13, fontWeight: 600 }}>Audit log</div>
      <div style={{ flex: "0 0 auto", fontSize: 10.5, color: C.faint, marginTop: 2, marginBottom: 14 }}>
        Visible to vault members only
      </div>

      {audit.restricted ? (
        <div style={{ fontSize: 11.5, color: C.faint2, lineHeight: 1.5 }}>
          🔒 Restricted to vault members. Sign in as a vault signer to view the activity trail.
        </div>
      ) : !audit.entries || audit.entries.length === 0 ? (
        <div style={{ fontSize: 11.5, color: C.faint2 }}>No activity recorded yet.</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          {audit.entries.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 9, fontSize: 11.5 }}>
              <span
                aria-hidden
                style={{
                  fontFamily: MONO,
                  flex: "0 0 auto",
                  color: e.action === "sign" ? C.green : e.action === "propose" ? C.orange : C.faint2,
                }}
              >
                {AUDIT_GLYPH[e.action] ?? "·"}
              </span>
              <div style={{ minWidth: 0 }}>
                <div>
                  <span style={{ fontWeight: 600 }}>{e.actor_label}</span>{" "}
                  <span style={{ color: C.muted }}>{AUDIT_VERB[e.action] ?? e.action}</span>
                  {e.outcome && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 9,
                        fontWeight: 600,
                        letterSpacing: ".3px",
                        padding: "1px 6px",
                        borderRadius: 20,
                        color: e.outcome === "success" ? C.green : C.red,
                        background: e.outcome === "success" ? "rgba(63,185,80,.12)" : "rgba(240,97,109,.12)",
                      }}
                    >
                      {e.outcome === "success" ? "✓ SUCCESS" : "✗ FAILED"}
                    </span>
                  )}
                </div>
                {e.detail && (
                  <div style={{ color: C.faint2, fontSize: 10.5, marginTop: 2, wordBreak: "break-word" }}>
                    {e.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
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
  roster,
  onProposePolicy,
}: {
  chat: Chat;
  setThreshold: (chatId: string, tierId: string, delta: number) => () => void;
  removeKey: (chatId: string, tierId: string, keyId: string) => () => void;
  proposeKey: (chatId: string, tierId: string) => () => void;
  roster: { npub: string; label: string; participantId: number }[];
  onProposePolicy: (chatId: string) => (draft: PolicyConfig, diff: PolicyDiffItem[]) => void;
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
        <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 16 }}>
          <div style={{ fontSize: 11, color: C.sand, letterSpacing: ".4px", marginBottom: 12 }}>PROPOSE A POLICY CHANGE</div>
          <PolicyEditor
            current={chatToPolicyConfig(chat, roster)}
            roster={roster}
            onPropose={onProposePolicy(chat.id)}
          />
        </div>
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
    { name: "Open Source", nameColor: C.ink, price: "Free", per: "· self-hosted", tagline: "The full stack, open source. Every feature unlocked — you run it on your own infra.", bg: C.surface, border: C.line2, featured: false, features: ["Unlimited chats, vaults & keys", "All hierarchical quorum tiers", "Self-host Nostr relays & vaultd", "Full on-chain audit log", "Community support"], cta: "View source", btnBg: "transparent", btnColor: "#C5C9CE", btnBorder: "1px solid rgba(255,255,255,.14)" },
    { name: "Business", nameColor: C.orange, price: "$499", per: "/mo", tagline: "Fully managed hosting — we run the relays and signing infra so your team doesn't have to.", bg: "#15120C", border: "rgba(247,147,26,.4)", featured: true, features: ["Up to 10 team chats", "Up to 3 signing groups per vault", "Managed Nostr relays & vaultd", "Audit log & SSO", "Priority signing support"], cta: "Current plan", btnBg: C.orange, btnColor: C.bg, btnBorder: "none" },
    { name: "Enterprise", nameColor: C.ink, price: "Contact us", per: "", tagline: "Deal-based pricing for large treasuries. Scoped to your security and scale.", bg: C.surface, border: C.line2, featured: false, features: ["Unlimited chats & groups", "Dedicated infra + 24/7 SLA", "On-site key ceremony", "Self-hosted or managed", "Named solutions engineer"], cta: "Contact sales", btnBg: "transparent", btnColor: "#C5C9CE", btnBorder: "1px solid rgba(255,255,255,.14)" },
  ];
  return (
    <div style={{ maxWidth: 1080 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, alignItems: "stretch" }}>
        {plans.map((pl) => (
          <div key={pl.name} style={{ background: pl.bg, border: `1px solid ${pl.border}`, borderRadius: 18, padding: "26px 24px", display: "flex", flexDirection: "column", position: "relative" }}>
            {pl.featured && <span style={{ position: "absolute", top: 18, right: 20, fontSize: 10.5, fontWeight: 600, color: C.bg, background: C.orange, padding: "3px 10px", borderRadius: 20 }}>CURRENT</span>}
            <div style={{ fontSize: 14, fontWeight: 600, color: pl.nameColor }}>{pl.name}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 14 }}>
              <span style={{ fontFamily: MONO, fontSize: pl.price.startsWith("$") ? 32 : 22, fontWeight: 600, whiteSpace: "nowrap" }}>{pl.price}</span>
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
