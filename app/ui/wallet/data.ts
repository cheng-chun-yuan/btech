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
    vaultStatus: "active",
    // Real Taproot address is provisioned from its own DKG vault on first load
    // (see app/api/chats/route.ts) so this channel is fundable like the treasury.
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
    vaultStatus: "active",
    // Real Taproot address is provisioned from its own DKG vault on first load.
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
];

// Approvals are user-created and stored in the DB (see POST /api/approvals);
// there are no seeded approval fixtures. Use the "New transfer" flow to create
// a real, live, broadcastable transfer.
export const MOCK_APPROVALS: Approval[] = [];

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
    vaultStatus: "active",
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

export { BTC_USD, RANK_COLOR };
