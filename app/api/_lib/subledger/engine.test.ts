import { describe, it, expect } from "vitest";

import { ingest } from "./engine";
import { openTestSubledgerDb, insertPrice, getJournalEntries, type DB } from "./store";
import { getLot } from "./lots";
import { parseDecimal, TWD_POSTING_SCALE } from "./money";
import type { JournalEntry, SubledgerEvent } from "./types";

function seedPrices(db: DB) {
  insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
  insertPrice(db, { asset: "BTC", date: "2026-06-05", source: "t", market: "CB", price_usd: "62000", usd_twd_rate: "31.00" });
}

const buy = (id: string, date: string): SubledgerEvent => ({
  event_id: id,
  type: "BUY",
  timestamp: `${date}T10:00:00Z`,
  wallet_id: "w",
  asset: "BTC",
  qty: "1",
});

/** INV-1: a journal entry's debits equal its credits at posting scale. */
function isBalanced(e: JournalEntry): boolean {
  let dr = BigInt(0);
  let cr = BigInt(0);
  for (const l of e.lines) {
    const amt = parseDecimal(l.amount_twd, TWD_POSTING_SCALE);
    if (l.dr_cr === "DR") dr += amt;
    else cr += amt;
  }
  return dr === cr;
}

describe("engine.ingest — BUY (acquire)", () => {
  it("posts a balanced entry and opens a lot", () => {
    const db = openTestSubledgerDb();
    seedPrices(db);
    const r = ingest(db, buy("b1", "2026-06-01"));
    expect(r.posted).toBe(true);

    const [e] = getJournalEntries(db);
    expect(isBalanced(e)).toBe(true);
    // 1 BTC * 60000 * 31.25 = 1,875,000.00
    const da = e.lines.find((l) => l.account === "digital_asset")!;
    expect(da.dr_cr).toBe("DR");
    expect(da.amount_twd).toBe("1875000.00");
    expect(getLot(db, "b1")!.cost_twd).toBe("1875000.0000");
  });
});

describe("engine.ingest — disposal (FIFO)", () => {
  it("SELL consumes lots and books a disposal gain, balanced", () => {
    const db = openTestSubledgerDb();
    seedPrices(db);
    ingest(db, buy("b1", "2026-06-01")); // cost 1,875,000
    ingest(db, buy("b2", "2026-06-05")); // cost 1,922,000

    const sell: SubledgerEvent = {
      event_id: "s1",
      type: "SELL",
      timestamp: "2026-06-10T10:00:00Z",
      wallet_id: "w",
      asset: "BTC",
      qty: "1.5",
      proceeds_twd: "3000000",
    };
    const r = ingest(db, sell);
    expect(r.posted).toBe(true);

    const entry = getJournalEntries(db).find((e) => e.event_id === "s1")!;
    expect(isBalanced(entry)).toBe(true);
    // carrying = 1,875,000 + 0.5*1,922,000 (=961,000) = 2,836,000 ; gain = 164,000
    const gain = entry.lines.find((l) => l.account === "disposal_gain")!;
    expect(gain.dr_cr).toBe("CR");
    expect(gain.amount_twd).toBe("164000.00");
  });

  it("OFFRAMP propagates tx_hash onto every line (INV-2)", () => {
    const db = openTestSubledgerDb();
    seedPrices(db);
    ingest(db, buy("b1", "2026-06-01"));
    const offramp: SubledgerEvent = {
      event_id: "o1",
      type: "OFFRAMP",
      timestamp: "2026-06-10T10:00:00Z",
      wallet_id: "w",
      asset: "BTC",
      qty: "1",
      proceeds_twd: "1800000",
      tx_hash: "deadbeef",
    };
    ingest(db, offramp);
    const entry = getJournalEntries(db).find((e) => e.event_id === "o1")!;
    expect(isBalanced(entry)).toBe(true);
    expect(entry.lines.every((l) => l.tx_hash === "deadbeef")).toBe(true);
    // proceeds 1,800,000 < carrying 1,875,000 -> loss 75,000
    expect(entry.lines.find((l) => l.account === "disposal_loss")?.amount_twd).toBe("75000.00");
  });
});

describe("engine.ingest — quarantine (INV-10)", () => {
  it("does not post an invalid event; records it as quarantined", () => {
    const db = openTestSubledgerDb();
    seedPrices(db);
    const bad = { ...buy("bad", "2026-06-01"), qty: "0" };
    const r = ingest(db, bad);
    expect(r.posted).toBe(false);
    expect(getJournalEntries(db).length).toBe(0);
    const ev = db.prepare("SELECT status FROM sl_event WHERE event_id=?").get("bad") as { status: string };
    expect(ev.status).toBe("quarantined");
    const exc = db.prepare("SELECT COUNT(*) c FROM sl_exception").get() as { c: number };
    expect(exc.c).toBe(1);
  });
});
