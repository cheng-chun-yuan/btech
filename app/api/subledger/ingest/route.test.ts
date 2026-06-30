import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installTestDb, clearTestDb, TEST_TOKEN } from "../_test-helpers";
import { seedPrices } from "../../_lib/subledger-api";

const h = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}));

import { POST } from "./route";

const events = [{ event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" }];
const req = () => new Request("http://x/api/subledger/ingest", { method: "POST", body: JSON.stringify({ events }) });

describe("POST /api/subledger/ingest", () => {
  beforeEach(() => {
    installTestDb();
    seedPrices((globalThis as unknown as { __btechDb: import("../../_lib/subledger").DB }).__btechDb, [
      { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" },
    ]);
  });
  afterEach(() => clearTestDb());

  it("ingests events and returns per-event results", async () => {
    h.token = TEST_TOKEN;
    const res = await POST(req());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: { posted: boolean }[] };
    expect(json.results[0].posted).toBe(true);
  });

  it("rejects an unauthenticated request with 401", async () => {
    h.token = undefined;
    expect((await POST(req())).status).toBe(401);
  });

  it("returns 400 when events is not an array", async () => {
    h.token = TEST_TOKEN;
    const res = await POST(
      new Request("http://x/api/subledger/ingest", {
        method: "POST",
        body: JSON.stringify({ events: 5 }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
