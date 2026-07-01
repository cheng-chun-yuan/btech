import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, seed } from "../_lib/db";
import { syncSigners } from "../_lib/identity";
import type { Approval } from "../../ui/wallet/types";

const h = vi.hoisted(() => ({
  token: "t" as string | undefined,
  quorum: null as number | null,
  cliGroups: null as { required: number }[] | null,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}));
// vaultd is the AUTHORITATIVE source for the live treasury's reshare quorum (its
// tiers are NOT mirrored into the web DB). Mock it like the existing reshare tests
// mock the vaultd clients; `h.quorum` lets each test pick what vaultd "returns"
// (a number, or null to simulate vaultd being unreachable/unconfigured).
// `runSessionProof` is the one-shot DKGKit CLI proof the route falls back to for
// the canonical treasury when vaultd is down; `h.cliGroups` picks the grouped
// tiers it "returns" (or null to simulate the CLI proof being unavailable too).
vi.mock("../_lib/btech", () => ({
  runVaultQuorum: vi.fn(async () => h.quorum),
  runSessionProof: vi.fn(async () => {
    if (!h.cliGroups) throw new Error("CLI proof unavailable");
    return {
      vault_policy_groups: h.cliGroups.map((g, i) => ({
        group_id: `g${i}`,
        chat_name: "",
        rank: i,
        required: g.required,
        total: g.required,
        participant_ids: [],
        joined_ids: [],
      })),
    };
  }),
}));

import { POST } from "./route";

function install() {
  const db = new Database(":memory:");
  migrate(db);
  seed(db);
  syncSigners(
    db,
    Array.from({ length: 10 }, (_, i) => ({ participant_id: i + 1, label: `S${i + 1}`, role: "r" })),
  );
  db.prepare("INSERT INTO sessions (token, npub, created_at, expires_at) VALUES ('t', (SELECT npub FROM signers WHERE participant_id=1), 0, 4102444800000)").run();
  (globalThis as unknown as { __btechDb?: unknown }).__btechDb = db;
  return db;
}

/** Overwrite the seeded treasury chat's current policy with display tiers whose
 * minNeed values sum to a known quorum (the value the role-approval threshold
 * must be pinned to server-side). */
function setTreasuryTiers(db: ReturnType<typeof install>, tiers: { minNeed: number; n: number }[]) {
  const row = db.prepare("SELECT data_json FROM chats WHERE id = 'treasury'").get() as { data_json: string };
  const meta = JSON.parse(row.data_json) as { tiers?: unknown };
  meta.tiers = tiers.map((t, i) => ({
    id: `t${i}`,
    name: `T${i}`,
    short: `T${i}`,
    minNeed: t.minNeed,
    keys: Array.from({ length: t.n }, (_, j) => ({ id: `k${i}-${j}`, initials: "X", name: `S${i}-${j}`, device: "d", status: "online" })),
  }));
  db.prepare("UPDATE chats SET data_json = ? WHERE id = 'treasury'").run(JSON.stringify(meta));
}

describe("POST /api/approvals", () => {
  beforeEach(() => { h.token = "t"; h.quorum = null; h.cliGroups = null; });
  afterEach(() => { (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined; });

  it("defaults to the canonical valid signer set and derives threshold = 6", async () => {
    install();
    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({ title: "Transfer", vault: "#treasury-ops", live: true }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const { approval } = (await res.json()) as { approval: { signerSet: { participantId: number }[]; threshold: number } };
    expect(approval.signerSet.map((s) => s.participantId)).toEqual([1, 3, 4, 6, 7, 8]);
    expect(approval.threshold).toBe(6);
  });

  it("rejects an explicit signer set containing a non-signer with 400", async () => {
    install();
    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({ title: "Transfer", vault: "#treasury-ops", signerNpubs: ["npub-bogus"] }),
    });
    expect((await POST(req)).status).toBe(400);
  });

  it("ignores a raw body.signerSet and falls back to the server-derived default", async () => {
    install();
    // Inject a forged signerSet with a single fake participant
    const injected = [{ participantId: 99, npub: "npub-injected", label: "Evil", role: "signer" }];
    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({ title: "Injected", vault: "#treasury-ops", signerSet: injected }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const { approval } = (await res.json()) as { approval: { signerSet: { participantId: number }[] } };
    // The server must have ignored the injected signerSet and used the canonical default
    expect(approval.signerSet.map((s) => s.participantId)).toEqual([1, 3, 4, 6, 7, 8]);
  });

  // SECURITY (current-quorum bypass): a kind:"role" + proposedPolicy approval is a
  // policy change. It must be ratified by the CURRENT policy's full quorum, so it
  // must carry NO signerSet (which would otherwise set threshold = signerSet.length,
  // lettable down to 1 → self-ratify) and its threshold must be the sum of the
  // current tiers' minNeed — server-computed, never the client-sent value.
  it("role policy-change proposals carry NO signerSet and pin threshold to the current quorum", async () => {
    const db = install();
    // Current treasury policy = 1/2 + 2/3 + 3/5  (sum of minNeed = 6).
    setTreasuryTiers(db, [
      { minNeed: 1, n: 2 },
      { minNeed: 2, n: 3 },
      { minNeed: 3, n: 5 },
    ]);
    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({
        title: "Policy change",
        vault: "#treasury-ops",
        kind: "role",
        proposedPolicy: {
          tiers: [
            {
              id: "t0",
              name: "C-level",
              rank: 0,
              required: 1,
              signers: [
                { participantId: 1, npub: "n1", label: "A", rank: 0 },
                { participantId: 2, npub: "n2", label: "B", rank: 0 },
              ],
            },
          ],
        },
        policyDiff: [{ kind: "threshold", text: "C-level 2/2 → 1/2" }],
        // Attacker attempts to self-ratify by sending threshold = 1.
        threshold: 1,
        total: 1,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const { approval } = (await res.json()) as { approval: Approval };
    expect(approval.signerSet).toBeUndefined();
    expect(approval.threshold).toBe(6); // sum of current minNeed — NOT 1, NOT a signerSet length
    expect(approval.total).toBe(6);
  });

  // Proves the threshold is sourced from minNeed, not coincidentally from the
  // default signer-set length (6) or the client value (99): quorum here is 5.
  it("derives the role threshold from current minNeed, not the default signer-set length", async () => {
    const db = install();
    setTreasuryTiers(db, [
      { minNeed: 1, n: 2 },
      { minNeed: 1, n: 3 },
      { minNeed: 3, n: 5 },
    ]); // sum = 5
    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({
        title: "Policy change",
        vault: "#treasury-ops",
        kind: "role",
        proposedPolicy: {
          tiers: [{ id: "t0", name: "Solo", rank: 0, required: 1, signers: [{ participantId: 1, npub: "n1", label: "A", rank: 0 }] }],
        },
        threshold: 99,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const { approval } = (await res.json()) as { approval: Approval };
    expect(approval.signerSet).toBeUndefined();
    expect(approval.threshold).toBe(5);
  });

  // The live treasury persists tiers:[] (its real 1/2+2/3+3/5 policy lives only in
  // vaultd + the client), so Σ minNeed = 0. The route must then source the quorum
  // AUTHORITATIVELY from vaultd (mocked to 6), NOT fall back to the client threshold.
  it("sources the role threshold from vaultd when the treasury tiers are empty (NOT the client value)", async () => {
    install(); // seeded treasury keeps tiers:[]
    h.quorum = 6; // vaultd reports the real grouped quorum (1 + 2 + 3)
    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({
        title: "Policy change",
        vault: "#treasury-ops",
        kind: "role",
        proposedPolicy: {
          tiers: [{ id: "t0", name: "Solo", rank: 0, required: 1, signers: [{ participantId: 1, npub: "n1", label: "A", rank: 0 }] }],
        },
        // Attacker attempts to self-ratify after one signer.
        threshold: 1,
        total: 1,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const { approval } = (await res.json()) as { approval: Approval };
    expect(approval.signerSet).toBeUndefined();
    expect(approval.threshold).toBe(6); // from vaultd — NOT the client's 1
    expect(approval.total).toBe(6);
  });

  // vaultd HTTP down (null) but the canonical treasury was never reshared
  // (tiers:[] + policyVersion 0): the route sources the quorum from the one-shot
  // DKGKit CLI proof (Σ required = 1 + 2 + 3 = 6), NOT the client's threshold.
  it("sources the role threshold from the DKGKit CLI proof when vaultd is down and treasury is canonical", async () => {
    install(); // seeded treasury keeps tiers:[] and policyVersion undefined (→ 0)
    h.quorum = null; // vaultd unreachable / unconfigured
    h.cliGroups = [{ required: 1 }, { required: 2 }, { required: 3 }]; // canonical grouped policy
    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({
        title: "Policy change",
        vault: "#treasury-ops",
        kind: "role",
        proposedPolicy: {
          tiers: [{ id: "t0", name: "Solo", rank: 0, required: 1, signers: [{ participantId: 1, npub: "n1", label: "A", rank: 0 }] }],
        },
        // Attacker attempts to self-ratify after one signer.
        threshold: 1,
        total: 1,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const { approval } = (await res.json()) as { approval: Approval };
    expect(approval.signerSet).toBeUndefined();
    expect(approval.threshold).toBe(6); // from the CLI proof — NOT the client's 1
    expect(approval.total).toBe(6);
  });

  // Fail-closed: empty tiers AND vaultd indeterminate (null) AND the CLI proof
  // unavailable → the route must 400, never silently accept a threshold:1
  // self-ratification.
  it("fails closed with 400 when the current-policy quorum is indeterminate", async () => {
    install(); // seeded treasury keeps tiers:[]
    h.quorum = null; // vaultd unreachable / unconfigured
    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({
        title: "Policy change",
        vault: "#treasury-ops",
        kind: "role",
        proposedPolicy: {
          tiers: [{ id: "t0", name: "Solo", rank: 0, required: 1, signers: [{ participantId: 1, npub: "n1", label: "A", rank: 0 }] }],
        },
        threshold: 1,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // Membership gate (spec): a kind:"role" + proposedPolicy proposal from a user who
  // is NEITHER a registered signer NOR an explicit chat member of the vault must be
  // rejected 403 and persist NO approval row (audited as a failed reshare).
  it("rejects a policy-change proposal from a non-member with 403 and persists no approval", async () => {
    const db = install();
    // Outsider: a real session user, but absent from `signers` and `chat_members`.
    db.prepare("INSERT INTO users (npub, label, role, created_at) VALUES ('npub-outsider', 'Outsider', 'guest', 0)").run();
    db.prepare("INSERT INTO sessions (token, npub, created_at, expires_at) VALUES ('outsider-t', 'npub-outsider', 0, 4102444800000)").run();
    h.token = "outsider-t";
    setTreasuryTiers(db, [{ minNeed: 1, n: 2 }, { minNeed: 2, n: 3 }, { minNeed: 3, n: 5 }]);

    const req = new Request("http://x/api/approvals", {
      method: "POST",
      body: JSON.stringify({
        title: "Policy change",
        vault: "#treasury-ops",
        kind: "role",
        proposedPolicy: {
          tiers: [{ id: "t0", name: "Solo", rank: 0, required: 1, signers: [{ participantId: 1, npub: "n1", label: "A", rank: 0 }] }],
        },
      }),
    });
    const countApprovals = () => (db.prepare("SELECT COUNT(*) c FROM approvals").get() as { c: number }).c;
    const before = countApprovals();
    const res = await POST(req);
    expect(res.status).toBe(403);
    // No approval row was persisted for the rejected proposal.
    expect(countApprovals()).toBe(before);
  });
});
