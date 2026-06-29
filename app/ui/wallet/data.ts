import type {
  Approval,
  Chat,
  SignerKey,
  Tier,
  WalletState,
} from "./types";

const BTC_USD = 64210;

// Avatar accent per rank tier, reused for the live vault rows.
const RANK_COLOR = ["#6FB1FF", "#C99A5B", "#5FD08A"];

// ---------------------------------------------------------------------------
// Mock chats from the design that the single-vault backend does not model.
// These stay client-side; they are clearly not marked `live`.
// ---------------------------------------------------------------------------

export const MOCK_CHATS: Chat[] = [
  {
    id: "cold",
    type: "channel",
    name: "#cold-reserve",
    desc: "Deep cold storage",
    members: 5,
    balanceBtc: "420.00",
    balanceUsd: "26,968,200",
    tiers: [
      {
        id: "board",
        name: "Board reserve",
        short: "Board",
        minNeed: 3,
        keys: [
          { id: "mk", initials: "MK", name: "Maya Ksiazek", device: "CEO · SeedSigner", status: "online" },
          { id: "dk", initials: "DK", name: "Dana Klein", device: "CFO · Coldcard Q", status: "online" },
          { id: "rb", initials: "RB", name: "Ravi Bose", device: "Chair · Coldcard Mk4", status: "online" },
          { id: "lo", initials: "LO", name: "Lena Ortiz", device: "Director · BitBox02", status: "online" },
          { id: "th", initials: "TH", name: "Tom Haas", device: "Director · Foundation", status: "reattesting" },
        ],
      },
    ],
    messages: [
      { id: "c1", who: "Ravi Bose", handle: "npub1rb…chr", initials: "RB", color: "#C99A5B", time: "Mon", text: "Quarterly cold-storage audit complete. All 5 board keys verified on-site.", signed: true, zaps: "" },
      { id: "c2", who: "Maya Ksiazek", handle: "npub1c8…ceo", initials: "MK", color: "#6FB1FF", time: "Mon", text: "Thanks. Let us keep the 3-of-5 threshold for the reserve — no changes this quarter.", signed: false, zaps: "⚡︎ 5 zaps" },
    ],
  },
  {
    id: "petty",
    type: "channel",
    name: "#ops-petty-cash",
    desc: "Day-to-day spend",
    members: 4,
    balanceBtc: "3.20",
    balanceUsd: "205,472",
    tiers: [
      {
        id: "pops",
        name: "Ops signers",
        short: "Ops",
        minNeed: 2,
        keys: [
          { id: "ar", initials: "AR", name: "Ana Rivera", device: "Ops Lead · Coldcard Mk4", status: "online" },
          { id: "po", initials: "PO", name: "Paul Osei", device: "Treasurer · BitBox02", status: "online" },
          { id: "jl", initials: "JL", name: "Jin Lee", device: "Controller · Ledger", status: "online" },
        ],
      },
    ],
    messages: [
      { id: "p1", who: "Ana Rivera", handle: "npub1qz…ops", initials: "AR", color: "#F7931A", time: "14:02", text: "Topping up petty cash for the conference travel — 0.5 BTC. Quick sign?", signed: false, zaps: "" },
      { id: "p2", who: "Jin Lee", handle: "npub1jl…ctl", initials: "JL", color: "#B79BFF", time: "14:05", text: "Signed. Have a good trip.", signed: true, zaps: "" },
    ],
  },
  {
    id: "dm-ana",
    type: "direct",
    name: "Ana Rivera",
    handle: "npub1qz…ops",
    initials: "AR",
    color: "#F7931A",
    members: 2,
    balanceBtc: "0.85",
    balanceUsd: "54,578",
    tiers: [
      {
        id: "pair",
        name: "Both parties",
        short: "Pair",
        minNeed: 2,
        keys: [
          { id: "dk", initials: "DK", name: "Dana Klein (you)", device: "CFO · Ledger Stax", status: "online" },
          { id: "ar", initials: "AR", name: "Ana Rivera", device: "Ops Lead · Coldcard Mk4", status: "online" },
        ],
      },
    ],
    messages: [
      { id: "da1", who: "Ana Rivera", handle: "npub1qz…ops", initials: "AR", color: "#F7931A", time: "10:12", text: "Want to set up our 2-of-2 escrow for the contractor milestone?", signed: false, zaps: "" },
      { id: "da2", who: "Dana Klein", handle: "npub1dk…cfo", initials: "DK", color: "#C99A5B", time: "10:15", text: "Yes — funding it with 0.85 BTC now. Both of us co-sign to release.", signed: true, zaps: "" },
    ],
  },
  {
    id: "dm-ravi",
    type: "direct",
    name: "Ravi Bose",
    handle: "npub1rb…chr",
    initials: "RB",
    color: "#C99A5B",
    members: 2,
    balanceBtc: "0.10",
    balanceUsd: "6,421",
    tiers: [
      {
        id: "pair",
        name: "Both parties",
        short: "Pair",
        minNeed: 2,
        keys: [
          { id: "dk", initials: "DK", name: "Dana Klein (you)", device: "CFO · Ledger Stax", status: "online" },
          { id: "rb", initials: "RB", name: "Ravi Bose", device: "Board Chair · Tapsigner", status: "online" },
        ],
      },
    ],
    messages: [
      { id: "dr1", who: "Ravi Bose", handle: "npub1rb…chr", initials: "RB", color: "#C99A5B", time: "Yesterday", text: "Quick 1:1 before the board call — all good on the reserve audit.", signed: false, zaps: "" },
    ],
  },
];

// Mock approvals from other vaults (not backed by the live crate).
export const MOCK_APPROVALS: Approval[] = [
  {
    id: "tx2",
    kind: "send",
    title: "Cold storage rebalance",
    dest: "bcrt1q…c0ld",
    destLabel: "Internal cold vault",
    btc: "18.00",
    usd: "1,155,780",
    vault: "#cold-reserve",
    time: "1h ago",
    policy: "3/5 Board",
    threshold: 5,
    total: 5,
    signed: 3,
    youSigned: false,
    status: "pending",
  },
  {
    id: "tx3",
    kind: "send",
    title: "Payroll batch — June",
    dest: "bcrt1q…p4yr",
    destLabel: "Payroll module",
    btc: "6.25",
    usd: "401,312",
    vault: "#ops-petty-cash",
    time: "3h ago",
    policy: "2/3 Ops",
    threshold: 2,
    total: 3,
    signed: 2,
    youSigned: true,
    status: "ready",
  },
  {
    id: "rc2",
    kind: "role",
    title: "Tighten reserve threshold",
    changeLabel: "Threshold 3/5 → 4/5",
    detail: "Stronger board control",
    tier: "Board reserve",
    requestedBy: "R. Bose",
    vault: "#cold-reserve",
    time: "2h ago",
    policy: "3/5 Board",
    threshold: 3,
    total: 5,
    signed: 1,
    youSigned: false,
    status: "pending",
  },
];

// ---------------------------------------------------------------------------
// Live vault built from the real DKGKit backend state.
// ---------------------------------------------------------------------------

function shortKey(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

/** Build the live treasury vault (chat) from the real grouped HTSS policy. */
export function buildLiveVault(state: WalletState): Chat {
  const { demo, session } = state;
  const inviteById = new Map(session.invites.map((i) => [i.participant_id, i]));

  const tiers: Tier[] = session.vault_policy_groups.map((g, idx) => {
    const keys: SignerKey[] = g.participant_ids.map((pid) => {
      const inv = inviteById.get(pid);
      const joined = g.joined_ids.includes(pid);
      const label = inv?.label ?? `Signer ${pid}`;
      const initials = label
        .split(" ")
        .map((p) => p[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
      return {
        id: `p${pid}`,
        initials,
        name: label,
        device: `${inv?.role ?? "Signer"} · DKGKit share #${pid}`,
        status: joined ? "online" : "reattesting",
        statusText: joined ? "Joined · share live" : "Invited · not yet joined",
      };
    });
    return {
      id: g.group_id,
      name: g.chat_name,
      short: ["C-level", "Managers", "Operators"][idx] ?? `Rank ${g.rank}`,
      minNeed: g.required,
      keys,
    };
  });

  return {
    id: "treasury",
    type: "channel",
    name: "#treasury-ops",
    desc: "Live DKGKit grouped vault",
    members: session.invites.length,
    balanceBtc: "100.13",
    balanceUsd: "6,429,287",
    live: true,
    receiveAddress: demo.receive_address,
    groupKey: demo.group_xonly_public_key,
    tiers,
    messages: [
      { id: "m1", who: "Ana Rivera", handle: "npub1qz…ops", initials: "AR", color: "#F7931A", time: "09:24", text: "Vendor payment to Blockstream is queued — 2.4 BTC. Please sign when you have a moment.", signed: false, zaps: "⚡︎ 3 zaps" },
      { id: "m2", who: "Maya Ksiazek", handle: "npub1c8…ceo", initials: "MK", color: "#6FB1FF", time: "09:31", text: "Reviewed the destination, it is whitelisted. Signing from my Coldcard now.", signed: true, zaps: "" },
      { id: "m3", who: "BTech", handle: "dkgkit", initials: "₿", color: "#F7931A", time: "now", text: `This vault is live. Group key ${shortKey(demo.group_xonly_public_key)} · receive ${shortKey(demo.receive_address)} on ${demo.network}. Signing runs a real grouped HTSS round and verifies the aggregate Schnorr signature under BIP340.`, signed: true, zaps: "" },
    ],
  };
}

/** Real policy string for the live vault, e.g. "1/2 + 2/3 + 3/5". */
export function livePolicyString(state: WalletState): string {
  return state.session.vault_policy_groups
    .map((g) => `${g.required}/${g.total}`)
    .join(" + ");
}

/** The live, backend-backed pending transfer that opens the Approvals view. */
export function buildLiveApproval(state: WalletState): Approval {
  const groups = state.session.vault_policy_groups;
  const threshold = groups.reduce((a, g) => a + g.required, 0);
  const total = groups.reduce((a, g) => a + g.total, 0);
  const btc = 2.4;
  const recipientAddress = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  return {
    id: "tx1",
    kind: "send",
    title: "Vendor payment — Blockstream",
    dest: "bcrt1q…f3t4",
    destLabel: "Whitelisted vendor",
    recipientAddress,
    amountSats: Math.round(btc * 1e8),
    btc: btc.toFixed(2),
    usd: Math.round(btc * BTC_USD).toLocaleString("en-US"),
    vault: "#treasury-ops",
    time: "12m ago",
    policy: livePolicyString(state),
    threshold,
    total,
    signed: 1,
    youSigned: false,
    status: "pending",
    live: true,
  };
}

export { BTC_USD, RANK_COLOR };
