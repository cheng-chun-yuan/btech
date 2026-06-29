import { describe, it, expect } from "vitest";

import { ingest } from "./engine";
import { openTestSubledgerDb, insertPrice, getJournalEntries, type DB } from "./store";
import { getLot } from "./lots";
import { parseDecimal, TWD_POSTING_SCALE } from "./money";
import type { JournalEntry, SubledgerEvent } from "./types";

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

const buyBtc = (id: string, date: string): SubledgerEvent => ({
  event_id: id, type: "BUY", timestamp: `${date}T10:00:00Z`, wallet_id: "w", asset: "BTC", qty: "1",
});
const revalue = (id: string, date: string): SubledgerEvent => ({
  event_id: id, type: "PERIODEND_REVALUE", timestamp: `${date}T23:59:59Z`, wallet_id: "w", asset: "BTC", qty: "0",
});

function buyAt(db: DB, id: string, date: string, priceUsd: string, fx: string) {
  insertPrice(db, { asset: "BTC", date, source: "t", market: "CB", price_usd: priceUsd, usd_twd_rate: fx });
  ingest(db, buyBtc(id, date));
}
function priceAt(db: DB, date: string, priceUsd: string, fx: string) {
  insertPrice(db, { asset: "BTC", date, source: "t", market: "CB", price_usd: priceUsd, usd_twd_rate: fx });
}

describe("PERIODEND_REVALUE — impairment (INV-8)", () => {
  it("impairs a lot when recoverable < carrying", () => {
    const db = openTestSubledgerDb();
    buyAt(db, "b1", "2026-06-01", "60000", "31.25"); // cost 1,875,000
    priceAt(db, "2026-06-30", "50000", "31.25"); // recoverable 1,562,500
    const r = ingest(db, revalue("pe1", "2026-06-30"));
    expect(r.posted).toBe(true);

    const e = getJournalEntries(db).find((x) => x.event_id === "pe1")!;
    expect(isBalanced(e)).toBe(true);
    const loss = e.lines.find((l) => l.account === "impairment_loss")!;
    expect(loss.dr_cr).toBe("DR");
    expect(loss.amount_twd).toBe("312500.00");
    expect(e.lines.find((l) => l.account === "accum_impairment")?.dr_cr).toBe("CR");
    expect(getLot(db, "b1")!.accum_impairment_twd).toBe("312500.0000");
  });

  it("emits no entry when recoverable >= carrying and nothing was impaired", () => {
    const db = openTestSubledgerDb();
    buyAt(db, "b1", "2026-06-01", "60000", "31.25");
    priceAt(db, "2026-06-30", "70000", "31.25"); // above cost, no prior impairment
    const r = ingest(db, revalue("pe1", "2026-06-30"));
    expect(r.posted).toBe(false); // no measurable change -> nothing to post
    expect(getJournalEntries(db).find((x) => x.event_id === "pe1")).toBeUndefined();
  });
});

describe("PERIODEND_REVALUE — reversal capped at cost (INV-8)", () => {
  it("reverses only up to original cost; recognizes no upside above it", () => {
    const db = openTestSubledgerDb();
    buyAt(db, "b1", "2026-06-01", "60000", "31.25"); // cost 1,875,000
    priceAt(db, "2026-06-30", "50000", "31.25"); // impair to 1,562,500
    ingest(db, revalue("pe1", "2026-06-30"));
    priceAt(db, "2026-07-31", "70000", "31.25"); // recoverable 2,187,500 > cost
    const r = ingest(db, revalue("pe2", "2026-07-31"));
    expect(r.posted).toBe(true);

    const e = getJournalEntries(db).find((x) => x.event_id === "pe2")!;
    expect(isBalanced(e)).toBe(true);
    const gain = e.lines.find((l) => l.account === "impairment_reversal_gain")!;
    expect(gain.dr_cr).toBe("CR");
    // reversal capped at cost: 1,875,000 - 1,562,500 = 312,500 (full reversal, no upside)
    expect(gain.amount_twd).toBe("312500.00");
    expect(getLot(db, "b1")!.accum_impairment_twd).toBe("0.0000");
  });
});

describe("PERIODEND_REVALUE — fx is locked at acquisition (INV-7)", () => {
  it("computes recoverable with acquire fx, ignoring the period-end rate", () => {
    const db = openTestSubledgerDb();
    buyAt(db, "b1", "2026-06-01", "60000", "31.25"); // cost 1,875,000, acquire fx 31.25
    // Period-end USD price drops to 50,000 but TWD weakens to 40.00. If the engine
    // (wrongly) used the period-end rate, recoverable = 2,000,000 > carrying and
    // NO impairment would post. With the locked acquire rate, recoverable =
    // 1,562,500 and a 312,500 impairment must post.
    priceAt(db, "2026-06-30", "50000", "40.00");
    ingest(db, revalue("pe1", "2026-06-30"));
    const e = getJournalEntries(db).find((x) => x.event_id === "pe1")!;
    expect(e.lines.find((l) => l.account === "impairment_loss")?.amount_twd).toBe("312500.00");
  });
});
