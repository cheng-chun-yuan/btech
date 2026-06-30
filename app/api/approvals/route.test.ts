import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, seed } from "../_lib/db";
import { syncSigners } from "../_lib/identity";

const h = vi.hoisted(() => ({ token: "t" as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
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

describe("POST /api/approvals", () => {
  beforeEach(() => { h.token = "t"; });
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
});
