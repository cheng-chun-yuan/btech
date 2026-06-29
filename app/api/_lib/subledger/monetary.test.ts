import { describe, it, expect } from "vitest";

import { ingest } from "./engine";
import {
  openTestSubledgerDb,
  insertPrice,
  insertMonetaryItem,
  getMonetaryItem,
  getJournalEntries,
  type DB,
} from "./store";
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

const periodEndUsd = (rate: string): SubledgerEvent => ({
  event_id: "perUSD",
  type: "PERIODEND_REVALUE",
  timestamp: "2026-06-30T23:59:59Z",
  wallet_id: "w",
  asset: "USD",
  qty: "0",
});

function usdClosing(db: DB, rate: string) {
  insertPrice(db, { asset: "USD", date: "2026-06-30", source: "t", market: "-", price_usd: "1", usd_twd_rate: rate });
}

describe("monetary AR/AP period-end FX retranslation (INV-7)", () => {
  it("retranslates a USD AR up at the closing rate -> fx gain", () => {
    const db = openTestSubledgerDb();
    // AR of $10,000 booked at 31.00 = 310,000 TWD
    insertMonetaryItem(db, { doc_no: "INV-1", kind: "AR", ccy: "USD", orig_amount: "10000", carrying_twd: "310000", open: true });
    usdClosing(db, "31.50"); // 10,000 * 31.50 = 315,000 -> gain 5,000
    const r = ingest(db, periodEndUsd("31.50"));
    expect(r.posted).toBe(true);

    const e = getJournalEntries(db).find((x) => x.event_id === "perUSD")!;
    expect(isBalanced(e)).toBe(true);
    const ar = e.lines.find((l) => l.account === "accounts_receivable")!;
    expect(ar.dr_cr).toBe("DR"); // AR asset increases
    expect(ar.amount_twd).toBe("5000.00");
    const fx = e.lines.find((l) => l.account === "fx_gain_loss")!;
    expect(fx.dr_cr).toBe("CR"); // gain
    expect(fx.amount_twd).toBe("5000.00");
    expect(getMonetaryItem(db, "INV-1")!.carrying_twd).toBe("315000.0000");
  });

  it("retranslates a USD AP up at the closing rate -> fx loss", () => {
    const db = openTestSubledgerDb();
    // AP of $20,000 booked at 31.00 = 620,000 TWD
    insertMonetaryItem(db, { doc_no: "BILL-1", kind: "AP", ccy: "USD", orig_amount: "20000", carrying_twd: "620000", open: true });
    usdClosing(db, "31.50"); // 20,000 * 31.50 = 630,000 -> we owe 10,000 more -> loss
    ingest(db, periodEndUsd("31.50"));

    const e = getJournalEntries(db).find((x) => x.event_id === "perUSD")!;
    expect(isBalanced(e)).toBe(true);
    const ap = e.lines.find((l) => l.account === "accounts_payable")!;
    expect(ap.dr_cr).toBe("CR"); // liability increases
    expect(ap.amount_twd).toBe("10000.00");
    const fx = e.lines.find((l) => l.account === "fx_gain_loss")!;
    expect(fx.dr_cr).toBe("DR"); // loss
    expect(fx.amount_twd).toBe("10000.00");
  });
});
