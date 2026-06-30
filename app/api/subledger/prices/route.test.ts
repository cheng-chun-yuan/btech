import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installTestDb, clearTestDb, TEST_TOKEN } from "../_test-helpers";

// Controllable cookie value (vi.hoisted so the mock factory can read it).
const h = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}));

import { POST } from "./route";

const body = { prices: [{ asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" }] };
const req = () => new Request("http://x/api/subledger/prices", { method: "POST", body: JSON.stringify(body) });

describe("POST /api/subledger/prices", () => {
  beforeEach(() => installTestDb());
  afterEach(() => clearTestDb());

  it("seeds prices for an authenticated user", async () => {
    h.token = TEST_TOKEN;
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(1);
  });

  it("rejects an unauthenticated request with 401", async () => {
    h.token = undefined;
    const res = await POST(req());
    expect(res.status).toBe(401);
  });

  it("returns 400 when prices is not an array", async () => {
    h.token = TEST_TOKEN;
    const res = await POST(
      new Request("http://x/api/subledger/prices", {
        method: "POST",
        body: JSON.stringify({ prices: 5 }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
