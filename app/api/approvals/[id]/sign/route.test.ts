import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, seed } from "../../../_lib/db";
import { syncSigners } from "../../../_lib/identity";

const h = vi.hoisted(() => ({ npub: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "tok" }) }),
}));
// vaultd two-round stubbed: precommit is a no-op package; finalize verifies.
vi.mock("../../../_lib/btech", () => ({
  VAULTD_CONFIGURED: true,
  runPrecommit: vi.fn(async () => ({ participant_id: 1, nonce_package: { c: "pkg" } })),
  runFinalize: vi.fn(async () => ({
    authorization_digest: "d".repeat(64),
    aggregate_signature: "a".repeat(128),
    group_xonly_public_key: "g".repeat(64),
    signers: [1, 3, 4, 6, 7, 8],
    verified: true,
  })),
  runSignApproval: vi.fn(),
  // Reshare stubbed: the aggregate authorization verifies. policyConfigToWire is
  // a pure flatten — a stub is fine since the wire only feeds the mocked reshare.
  runReshare: vi.fn(async () => ({
    authorization_digest: "r".repeat(64),
    aggregate_signature: "s".repeat(128),
    group_xonly_public_key: "g".repeat(64),
    signers: [1, 6],
    verified: true,
  })),
  policyConfigToWire: vi.fn(() => ({ participants: [], requirements: [] })),
}));

import { POST } from "./route";
import { runReshare, runPrecommit } from "../../../_lib/btech";

let db: Database.Database;
function asUser(participantId: number) {
  const row = db.prepare("SELECT npub FROM signers WHERE participant_id = ?").get(participantId) as { npub: string };
  db.prepare("INSERT OR REPLACE INTO sessions (token, npub, created_at, expires_at) VALUES ('tok', ?, 0, 4102444800000)").run(row.npub);
  return row.npub;
}
const ctx = () => ({ params: Promise.resolve({ id: "tx1" }) });
const post = () => POST(new Request("http://x/api/approvals/tx1/sign", { method: "POST" }), ctx());

describe("POST /api/approvals/[id]/sign — propose-picks-signers", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    seed(db);
    syncSigners(db, Array.from({ length: 10 }, (_, i) => ({ participant_id: i + 1, label: `S${i + 1}`, role: "r" })));
    const set = [1, 3, 4, 6, 7, 8].map((pid) => {
      const r = db.prepare("SELECT npub, label FROM signers WHERE participant_id = ?").get(pid) as { npub: string; label: string };
      return { participantId: pid, npub: r.npub, label: r.label };
    });
    db.prepare("INSERT INTO approvals (id, vault, kind, data_json, status, is_live, created_at) VALUES ('tx1','#treasury-ops','send',?, 'pending',1,0)").run(
      JSON.stringify({ id: "tx1", title: "Transfer", vault: "#treasury-ops", live: true, threshold: 6, signerSet: set, recipientAddress: "bcrt1qx", amountSats: 100000 }),
    );
    (globalThis as unknown as { __btechDb?: unknown }).__btechDb = db;
  });
  afterEach(() => { (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined; });

  it("rejects a signer who is not in the chosen set (participant 2)", async () => {
    asUser(2);
    expect((await post()).status).toBe(403);
  });

  it("finalizes once all six chosen signers have pre-committed", async () => {
    for (const pid of [1, 3, 4, 6, 7]) { asUser(pid); expect((await post()).status).toBe(200); }
    // Not ready until the sixth signs.
    let row = db.prepare("SELECT status FROM approvals WHERE id='tx1'").get() as { status: string };
    expect(row.status).toBe("pending");
    asUser(8);
    const res = await post();
    const { approval } = (await res.json()) as { approval: { status: string; proof?: { verified: boolean } } };
    expect(approval.status).toBe("ready");
    expect(approval.proof?.verified).toBe(true);
  });
});

describe("POST /api/approvals/[id]/sign — policy-change reshare", () => {
  const proposedPolicy = {
    tiers: [
      { id: "t0", name: "C-level", rank: 0, required: 1, signers: [{ participantId: 1, npub: "n1", label: "S1", rank: 0 }] },
      { id: "t1", name: "Operators", rank: 2, required: 1, signers: [{ participantId: 6, npub: "n6", label: "S6", rank: 2 }] },
    ],
  };
  function seedRole(basePolicyVersion: number) {
    db.prepare("INSERT INTO approvals (id, vault, kind, data_json, status, is_live, created_at) VALUES ('rc1','#treasury-ops','role',?, 'pending',1,0)").run(
      // No signerSet: a reshare ratifies on DISTINCT current signers (threshold).
      JSON.stringify({ id: "rc1", kind: "role", title: "Policy change", vault: "#treasury-ops", live: true, threshold: 2, basePolicyVersion, proposedPolicy }),
    );
  }
  const chatRow = () =>
    JSON.parse((db.prepare("SELECT data_json FROM chats WHERE id='treasury'").get() as { data_json: string }).data_json);
  const postRc = () => POST(new Request("http://x/api/approvals/rc1/sign", { method: "POST" }), { params: Promise.resolve({ id: "rc1" }) });

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(":memory:");
    migrate(db);
    seed(db);
    syncSigners(db, Array.from({ length: 10 }, (_, i) => ({ participant_id: i + 1, label: `S${i + 1}`, role: "r" })));
    (globalThis as unknown as { __btechDb?: unknown }).__btechDb = db;
  });
  afterEach(() => { (globalThis as unknown as { __btechDb?: unknown }).__btechDb = undefined; });

  it("applies the reshare + bumps policyVersion once 2 distinct signers ratify", async () => {
    seedRole(0);
    asUser(1);
    expect((await postRc()).status).toBe(200);
    // Below quorum: no reshare yet, version unchanged.
    expect(chatRow().policyVersion ?? 0).toBe(0);
    expect(runReshare).not.toHaveBeenCalled();

    asUser(6);
    const res = await postRc();
    expect(res.status).toBe(200);
    const { approval } = (await res.json()) as { approval: { status: string; proof?: { verified: boolean } } };
    expect(approval.status).toBe("ready");
    expect(approval.proof?.verified).toBe(true);

    expect(runReshare).toHaveBeenCalledTimes(1);
    // Ratifier set = the two voters' participant ids (built from actual voters).
    expect([...(vi.mocked(runReshare).mock.calls[0][0].signerSet)].sort((a, b) => a - b)).toEqual([1, 6]);
    // Reshare approvals carry no signerSet → the precommit round never ran.
    expect(runPrecommit).not.toHaveBeenCalled();

    // Mirror: new tiers + bumped version, address (chat row) otherwise intact.
    const chat = chatRow();
    expect(chat.policyVersion).toBe(1);
    expect(chat.tiers).toHaveLength(2);
    expect(chat.tiers[0]).toMatchObject({ short: "C-L", minNeed: 1 });
    expect(chat.tiers[0].keys[0]).toMatchObject({ id: "k1", name: "S1", device: "Active", status: "online" });
  });

  it("rejects with 409 when the live policy moved on (stale basePolicyVersion)", async () => {
    seedRole(5); // chat is at version 0
    asUser(1);
    expect((await postRc()).status).toBe(200);
    asUser(6);
    const res = await postRc();
    expect(res.status).toBe(409);
    // Guard fires before runReshare; the live policy is untouched.
    expect(runReshare).not.toHaveBeenCalled();
    expect(chatRow().policyVersion ?? 0).toBe(0);
  });
});
