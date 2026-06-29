import { describe, it, expect } from "vitest";

import { createLot, consumeLots, getLot } from "./lots";
import { openTestSubledgerDb } from "./store";
import { formatDecimal, TWD_INTERNAL_SCALE } from "./money";

function seedTwoBtcLots(db: ReturnType<typeof openTestSubledgerDb>) {
  // Lot A: 1 BTC @ 2,031,250 TWD/unit (older). Lot B: 1 BTC @ 2,100,000 (newer).
  createLot(db, {
    event_id: "buyA",
    wallet_id: "w",
    asset: "BTC",
    acquire_date: "2026-06-01",
    acquire_fx_rate: "31.25",
    qty: "1",
    cost_twd: "2031250",
  });
  createLot(db, {
    event_id: "buyB",
    wallet_id: "w",
    asset: "BTC",
    acquire_date: "2026-06-05",
    acquire_fx_rate: "31.00",
    qty: "1",
    cost_twd: "2100000",
  });
}

describe("lots FIFO consumption (INV-9)", () => {
  it("consumes oldest lots first and sums carrying net of impairment", () => {
    const db = openTestSubledgerDb();
    seedTwoBtcLots(db);

    const r = consumeLots(db, {
      disposal_event_id: "sell1",
      wallet_id: "w",
      asset: "BTC",
      qty: "1.5",
      cost_flow: "FIFO",
    });

    // all of A (1 @ 2,031,250) + half of B (0.5 @ 2,100,000 = 1,050,000)
    expect(formatDecimal(r.carrying_twd, TWD_INTERNAL_SCALE)).toBe("3081250.0000");
    expect(r.consumed.map((c) => c.lot_id)).toEqual(["buyA", "buyB"]);

    expect(getLot(db, "buyA")!.remaining_qty).toBe("0.00000000");
    expect(getLot(db, "buyB")!.remaining_qty).toBe("0.50000000");
  });

  it("throws when quantity exceeds open lots", () => {
    const db = openTestSubledgerDb();
    seedTwoBtcLots(db);
    expect(() =>
      consumeLots(db, {
        disposal_event_id: "sellX",
        wallet_id: "w",
        asset: "BTC",
        qty: "3",
        cost_flow: "FIFO",
      }),
    ).toThrow(/insufficient/i);
  });
});
