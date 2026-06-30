import { describe, it, expect } from "vitest";

import { seedPrices, ingestEvents, getOutput, runPeriodReconcile } from "./subledger-api";
import { openTestSubledgerDb, type DB } from "./subledger";
import type { PricePoint, SubledgerEvent } from "./subledger";

const PRICES: PricePoint[] = [
  { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" },
];
const BUY: SubledgerEvent = {
  event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1",
};

function ready(): DB {
  const db = openTestSubledgerDb();
  seedPrices(db, PRICES);
  ingestEvents(db, [BUY]);
  return db;
}

describe("subledger-api", () => {
  it("seedPrices writes PricePoints and returns the count", () => {
    const db = openTestSubledgerDb();
    expect(seedPrices(db, PRICES)).toBe(1);
  });

  it("ingestEvents posts valid events and reports per-event results", () => {
    const db = openTestSubledgerDb();
    seedPrices(db, PRICES);
    const [r] = ingestEvents(db, [BUY]);
    expect(r.posted).toBe(true);
  });

  it("getOutput dispatches each output kind", () => {
    const db = ready();
    expect(Array.isArray(getOutput(db, "journal"))).toBe(true);
    expect(Array.isArray(getOutput(db, "positions"))).toBe(true);
    expect(getOutput(db, "disclosures")).toHaveProperty("fx_lock_note");
    const pack = getOutput(db, "audit_pack", "2026-06") as { policy_version: string };
    expect(pack.policy_version).toBe("2026-06-29");
  });

  it("getOutput throws on an unknown kind and on audit_pack without a period", () => {
    const db = ready();
    expect(() => getOutput(db, "nope")).toThrow(/unknown output kind/);
    expect(() => getOutput(db, "audit_pack")).toThrow(/period/);
  });

  it("runPeriodReconcile returns a per-asset tie/break result", () => {
    const db = ready();
    const res = runPeriodReconcile(db, "2026-06", { BTC: "1" }) as { asset: string; status: string }[];
    expect(res.find((r) => r.asset === "BTC")?.status).toBe("tie");
  });
});
