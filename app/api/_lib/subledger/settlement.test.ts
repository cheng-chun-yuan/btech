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
const line = (e: JournalEntry, account: string) => e.lines.find((l) => l.account === account);

function holdOneBtc(db: DB) {
  // 1 BTC bought at 60,000 * 31.25 = 1,875,000 carrying
  insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
  ingest(db, { event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" });
}

describe("PAY_SUPPLIER settlement split (§7)", () => {
  it("separates fx_leg (AP revaluation) from disposal_leg (crypto)", () => {
    const db = openTestSubledgerDb();
    holdOneBtc(db);
    // AP of $50,000 booked at 31.00 = 1,550,000 TWD
    insertMonetaryItem(db, { doc_no: "BILL-1", kind: "AP", ccy: "USD", orig_amount: "50000", carrying_twd: "1550000", open: true });
    // settle on 2026-06-10 at rate 31.40 with 1 BTC whose FV settles the bill
    insertPrice(db, { asset: "BTC", date: "2026-06-10", source: "t", market: "CB", price_usd: "50000", usd_twd_rate: "31.40" });

    const pay: SubledgerEvent = {
      event_id: "p1",
      type: "PAY_SUPPLIER",
      timestamp: "2026-06-10T10:00:00Z",
      wallet_id: "w",
      asset: "BTC",
      qty: "1",
      invoice_no: "BILL-1",
      tx_hash: "feed",
    };
    const r = ingest(db, pay);
    expect(r.posted).toBe(true);

    const e = getJournalEntries(db).find((x) => x.event_id === "p1")!;
    expect(isBalanced(e)).toBe(true);

    // AP settled at its book carrying 1,550,000
    expect(line(e, "accounts_payable")!.dr_cr).toBe("DR");
    expect(line(e, "accounts_payable")!.amount_twd).toBe("1550000.00");
    // crypto removed at lot carrying 1,875,000
    expect(line(e, "digital_asset")!.dr_cr).toBe("CR");
    expect(line(e, "digital_asset")!.amount_twd).toBe("1875000.00");
    // fx_leg: AP up 50,000*(31.40-31.00) = 20,000 -> loss (DR), kept separate
    expect(line(e, "fx_gain_loss")!.dr_cr).toBe("DR");
    expect(line(e, "fx_gain_loss")!.amount_twd).toBe("20000.00");
    // disposal_leg: settled value 1,570,000 - carrying 1,875,000 = -305,000 loss (DR)
    expect(line(e, "disposal_loss")!.dr_cr).toBe("DR");
    expect(line(e, "disposal_loss")!.amount_twd).toBe("305000.00");

    expect(getMonetaryItem(db, "BILL-1")!.open).toBe(false);
  });
});

describe("RECEIVE_SETTLE_AR settlement split (§7)", () => {
  it("separates fx_leg (AR revaluation) and opens a lot for the crypto received", () => {
    const db = openTestSubledgerDb();
    // AR of $40,000 booked at 31.00 = 1,240,000 TWD
    insertMonetaryItem(db, { doc_no: "INV-9", kind: "AR", ccy: "USD", orig_amount: "40000", carrying_twd: "1240000", open: true });
    // settle 2026-06-12 at rate 31.50; receive 1 BTC whose FV (40,000*31.50) settles it
    insertPrice(db, { asset: "BTC", date: "2026-06-12", source: "t", market: "CB", price_usd: "40000", usd_twd_rate: "31.50" });

    const r = ingest(db, {
      event_id: "r9",
      type: "RECEIVE_SETTLE_AR",
      timestamp: "2026-06-12T10:00:00Z",
      wallet_id: "w",
      asset: "BTC",
      qty: "1",
      invoice_no: "INV-9",
      tx_hash: "cafe",
    });
    expect(r.posted).toBe(true);

    const e = getJournalEntries(db).find((x) => x.event_id === "r9")!;
    expect(isBalanced(e)).toBe(true);
    // crypto received at FV 1,260,000 -> a new lot
    expect(line(e, "digital_asset")!.dr_cr).toBe("DR");
    expect(line(e, "digital_asset")!.amount_twd).toBe("1260000.00");
    expect(getLot(db, "r9")!.cost_twd).toBe("1260000.0000");
    // AR removed at its book carrying 1,240,000
    expect(line(e, "accounts_receivable")!.dr_cr).toBe("CR");
    expect(line(e, "accounts_receivable")!.amount_twd).toBe("1240000.00");
    // fx_leg: AR up 40,000*(31.50-31.00) = 20,000 -> gain (CR)
    expect(line(e, "fx_gain_loss")!.dr_cr).toBe("CR");
    expect(line(e, "fx_gain_loss")!.amount_twd).toBe("20000.00");
    expect(getMonetaryItem(db, "INV-9")!.open).toBe(false);
  });
});
