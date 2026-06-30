import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installTestDb, clearTestDb, TEST_TOKEN } from "../../_test-helpers";
import { seedPrices, ingestEvents } from "../../../_lib/subledger-api";
import type { DB } from "../../../_lib/subledger";

const h = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}));

import { GET } from "./route";

const db = () => (globalThis as unknown as { __btechDb: DB }).__btechDb;
const ctx = (kind: string) => ({ params: Promise.resolve({ kind }) });
const get = (kind: string, qs = "") =>
  GET(new Request(`http://x/api/subledger/outputs/${kind}${qs}`), ctx(kind));

describe("GET /api/subledger/outputs/[kind]", () => {
  beforeEach(() => {
    installTestDb();
    seedPrices(db(), [{ asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" }]);
    ingestEvents(db(), [{ event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" }]);
    h.token = TEST_TOKEN;
  });
  afterEach(() => clearTestDb());

  it("returns journal rows", async () => {
    const res = await get("journal");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string; data: unknown[] };
    expect(json.kind).toBe("journal");
    expect(json.data.length).toBeGreaterThan(0);
  });

  it("returns 400 for an unknown kind", async () => {
    expect((await get("nope")).status).toBe(400);
  });

  it("returns 401 without a session", async () => {
    h.token = undefined;
    expect((await get("journal")).status).toBe(401);
  });
});
