import { describe, it, expect } from "vitest";

import { journalRows, positions, lotDisposals } from "./outputs";
import { ingest } from "./engine";
import { openTestSubledgerDb, insertPrice, type DB } from "./store";
import { DEFAULT_COA_CODES, type SubledgerEvent } from "./types";

function seed(db: DB) {
  insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
  insertPrice(db, { asset: "BTC", date: "2026-06-05", source: "t", market: "CB", price_usd: "62000", usd_twd_rate: "31.00" });
}
const buy = (id: string, date: string): SubledgerEvent => ({
  event_id: id, type: "BUY", timestamp: `${date}T10:00:00Z`, wallet_id: "w", asset: "BTC", qty: "1",
});
const sell15 = (): SubledgerEvent => ({
  event_id: "s1", type: "SELL", timestamp: "2026-06-10T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1.5", proceeds_twd: "3000000",
});

describe("outputs ① journal", () => {
  it("maps each line to a COA code with the event date and id", () => {
    const db = openTestSubledgerDb();
    seed(db);
    ingest(db, buy("b1", "2026-06-01"));
    const rows = journalRows(db);
    expect(rows.length).toBe(2);
    const da = rows.find((r) => r.coa_code === DEFAULT_COA_CODES.digital_asset)!;
    expect(da.date).toBe("2026-06-01");
    expect(da.event_id).toBe("b1");
    expect(da.dr_cr).toBe("DR");
    expect(da.amount_twd).toBe("1875000.00");
    expect(da.gaap).toBe("TIFRS");
  });
});

describe("outputs ② positions", () => {
  it("lists only open lots, with remaining carrying and unit cost", () => {
    const db = openTestSubledgerDb();
    seed(db);
    ingest(db, buy("b1", "2026-06-01"));
    ingest(db, buy("b2", "2026-06-05"));
    ingest(db, sell15()); // consumes all of b1, half of b2

    const pos = positions(db);
    expect(pos.map((p) => p.lot_id)).toEqual(["b2"]);
    expect(pos[0].remaining_qty).toBe("0.50000000");
    expect(pos[0].carrying_twd).toBe("961000.0000");
    expect(pos[0].unit_cost).toBe("1922000.0000");
  });
});

describe("outputs ④ lot_disposal", () => {
  it("summarizes a disposal: consumed lots, proceeds, carrying, gain/loss", () => {
    const db = openTestSubledgerDb();
    seed(db);
    ingest(db, buy("b1", "2026-06-01"));
    ingest(db, buy("b2", "2026-06-05"));
    ingest(db, sell15());

    const d = lotDisposals(db).find((x) => x.disposal_event === "s1")!;
    expect(d.consumed_lots).toEqual(["b1", "b2"]);
    expect(d.carrying).toBe("2836000.0000");
    expect(d.proceeds).toBe("3000000.0000");
    expect(d.gain_loss).toBe("164000.0000");
    expect(d.cost_flow).toBe("FIFO");
  });
});
