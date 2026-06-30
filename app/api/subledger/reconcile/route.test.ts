import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installTestDb, clearTestDb, TEST_TOKEN } from "../_test-helpers";
import { seedPrices, ingestEvents } from "../../_lib/subledger-api";
import type { DB } from "../../_lib/subledger";

const h = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}));

import { POST } from "./route";

const db = () => (globalThis as unknown as { __btechDb: DB }).__btechDb;
const req = () =>
  new Request("http://x/api/subledger/reconcile", {
    method: "POST",
    body: JSON.stringify({ period: "2026-06", chainBalances: { BTC: "1" } }),
  });

describe("POST /api/subledger/reconcile", () => {
  beforeEach(() => {
    installTestDb();
    seedPrices(db(), [{ asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" }]);
    ingestEvents(db(), [{ event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" }]);
  });
  afterEach(() => clearTestDb());

  it("reconciles a period and reports tie/break per asset", async () => {
    h.token = TEST_TOKEN;
    const res = await POST(req());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { asset: string; status: string }[] };
    expect(json.data.find((r) => r.asset === "BTC")?.status).toBe("tie");
  });

  it("rejects an unauthenticated request with 401", async () => {
    h.token = undefined;
    expect((await POST(req())).status).toBe(401);
  });

  it("returns 400 when period is missing (authenticated)", async () => {
    h.token = TEST_TOKEN;
    const res = await POST(
      new Request("http://x/api/subledger/reconcile", {
        method: "POST",
        body: JSON.stringify({ chainBalances: {} }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed JSON body (authenticated)", async () => {
    h.token = TEST_TOKEN;
    const res = await POST(
      new Request("http://x/api/subledger/reconcile", {
        method: "POST",
        body: "not json",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });
});
