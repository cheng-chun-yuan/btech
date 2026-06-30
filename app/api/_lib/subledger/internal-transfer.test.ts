import { describe, it, expect } from "vitest";

import { ingest } from "./engine";
import { runReconcile } from "./reconcile";
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
const line = (e: JournalEntry, account: string) => e.lines.find((l) => l.account === account);

function holdOneBtc(db: DB) {
  // 1 BTC at 60,000 * 31.25 = 1,875,000 carrying (unit basis 1,875,000/BTC)
  insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
  ingest(db, { event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "cold", asset: "BTC", qty: "1" });
}

describe("INTERNAL_TRANSFER — own-wallet move, gas-only (A)", () => {
  it("books only the gas; the principal is not disposed and its basis is preserved", () => {
    const db = openTestSubledgerDb();
    holdOneBtc(db);
    insertPrice(db, { asset: "BTC", date: "2026-06-10", source: "t", market: "CB", price_usd: "50000", usd_twd_rate: "31.40" });

    // move 0.5 BTC cold -> petty (own vaults); 0.0001 BTC miner fee
    const xfer: SubledgerEvent = {
      event_id: "it1",
      type: "INTERNAL_TRANSFER",
      timestamp: "2026-06-10T10:00:00Z",
      wallet_id: "cold",
      asset: "BTC",
      qty: "0.5",
      fee_gas: "0.0001",
      tx_hash: "deadbeef",
    };
    const r = ingest(db, xfer);
    expect(r.posted).toBe(true);

    const e = getJournalEntries(db).find((x) => x.event_id === "it1")!;
    expect(isBalanced(e)).toBe(true);
    // gas: FV = 0.0001 * 50000 * 31.40 = 157.00 ; carrying = 0.0001 * 1,875,000 = 187.50
    expect(line(e, "fee_expense")!.dr_cr).toBe("DR");
    expect(line(e, "fee_expense")!.amount_twd).toBe("157.00");
    expect(line(e, "digital_asset")!.dr_cr).toBe("CR");
    expect(line(e, "digital_asset")!.amount_twd).toBe("187.50");
    // disposal on the gas only: 157.00 - 187.50 = -30.50 loss
    expect(line(e, "disposal_loss")!.amount_twd).toBe("30.50");
    // NOT a disposal of the principal: no bank / no sales_revenue
    expect(line(e, "bank")).toBeUndefined();
    expect(line(e, "sales_revenue")).toBeUndefined();

    // only the 0.0001 gas left the lot; the 0.5 principal stays (basis preserved)
    expect(getLot(db, "b1")!.remaining_qty).toBe("0.99990000");
  });

  it("is a no-op when there is no gas fee (principal move is invisible at entity level)", () => {
    const db = openTestSubledgerDb();
    holdOneBtc(db);
    const r = ingest(db, {
      event_id: "it2",
      type: "INTERNAL_TRANSFER",
      timestamp: "2026-06-10T10:00:00Z",
      wallet_id: "cold",
      asset: "BTC",
      qty: "0.5",
      tx_hash: "feed",
    });
    expect(r.posted).toBe(false);
    expect(getJournalEntries(db).find((x) => x.event_id === "it2")).toBeUndefined();
    expect(getLot(db, "b1")!.remaining_qty).toBe("1.00000000");
  });

  it("still reconciles at the entity pool (chain = held minus the gas)", () => {
    const db = openTestSubledgerDb();
    holdOneBtc(db);
    insertPrice(db, { asset: "BTC", date: "2026-06-10", source: "t", market: "CB", price_usd: "50000", usd_twd_rate: "31.40" });
    ingest(db, {
      event_id: "it1",
      type: "INTERNAL_TRANSFER",
      timestamp: "2026-06-10T10:00:00Z",
      wallet_id: "cold",
      asset: "BTC",
      qty: "0.5",
      fee_gas: "0.0001",
      tx_hash: "deadbeef",
    });
    const res = runReconcile(db, "2026-06", { BTC: "0.9999" });
    expect(res.find((x) => x.asset === "BTC")?.status).toBe("tie");
  });
});
