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
}));

import { POST } from "./route";

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
