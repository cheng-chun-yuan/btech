import { describe, it, expect } from "vitest";

import { runReconcile } from "./reconcile";
import { ingest } from "./engine";
import { openTestSubledgerDb, insertPrice, type DB } from "./store";
import { getLot } from "./lots";
import type { SubledgerEvent } from "./types";

function twoBuysOneSell(db: DB) {
  insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
  insertPrice(db, { asset: "BTC", date: "2026-06-05", source: "t", market: "CB", price_usd: "62000", usd_twd_rate: "31.00" });
  ingest(db, { event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" });
  ingest(db, { event_id: "b2", type: "BUY", timestamp: "2026-06-05T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" });
  const sell: SubledgerEvent = { event_id: "s1", type: "SELL", timestamp: "2026-06-10T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1.5", proceeds_twd: "3000000" };
  ingest(db, sell);
}

describe("reconcile three-way tie (INV-4)", () => {
  it("ties when chain qty == subledger qty and gl twd == subledger twd", () => {
    const db = openTestSubledgerDb();
    twoBuysOneSell(db); // remaining 0.5 BTC, carrying = 961,000
    const res = runReconcile(db, "2026-06", { BTC: "0.5" });
    const btc = res.find((r) => r.asset === "BTC")!;
    expect(btc.status).toBe("tie");
    expect(btc.qty_diff).toBe("0.00000000");
    expect(btc.value_diff).toBe("0.0000");
    expect(btc.gl_twd).toBe("961000.0000");
    expect(btc.subledger_twd).toBe("961000.0000");
  });

  it("breaks and emits an exception when the chain disagrees", () => {
    const db = openTestSubledgerDb();
    twoBuysOneSell(db); // subledger 0.5 BTC
    const res = runReconcile(db, "2026-06", { BTC: "0.4" }); // chain says 0.4
    const btc = res.find((r) => r.asset === "BTC")!;
    expect(btc.status).toBe("break");
    expect(btc.qty_diff).not.toBe("0.00000000");
    const exc = db.prepare("SELECT COUNT(*) c FROM sl_exception WHERE kind='recon_break'").get() as { c: number };
    expect(exc.c).toBeGreaterThan(0);
  });

  it("never auto-fixes: lots are untouched after a break", () => {
    const db = openTestSubledgerDb();
    twoBuysOneSell(db);
    const before = getLot(db, "b2")!.remaining_qty;
    runReconcile(db, "2026-06", { BTC: "999" });
    expect(getLot(db, "b2")!.remaining_qty).toBe(before);
  });

  it("ties after a previously-impaired lot is disposed (gl clears to subledger)", () => {
    const db = openTestSubledgerDb();
    insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
    ingest(db, { event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" });
    insertPrice(db, { asset: "BTC", date: "2026-06-30", source: "t", market: "CB", price_usd: "50000", usd_twd_rate: "31.25" });
    ingest(db, { event_id: "pe1", type: "PERIODEND_REVALUE", timestamp: "2026-06-30T23:59:59Z", wallet_id: "w", asset: "BTC", qty: "0" });
    // dispose the whole impaired lot
    ingest(db, { event_id: "s1", type: "SELL", timestamp: "2026-07-02T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1", proceeds_twd: "1600000" });

    const res = runReconcile(db, "2026-07", { BTC: "0" });
    const btc = res.find((r) => r.asset === "BTC")!;
    expect(btc.status).toBe("tie");
    expect(btc.gl_twd).toBe("0.0000"); // digital_asset and accum_impairment both cleared
  });
});
