import { describe, it, expect } from "vitest";

import { ingest } from "./engine";
import { openTestSubledgerDb, insertPrice, getJournalEntries, type DB } from "./store";
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

describe("GAS (§6)", () => {
  it("expenses the fee at FV and disposes the crypto at lot carrying", () => {
    const db = openTestSubledgerDb();
    // hold 1 ETH at 3000 * 31.00 = 93,000 carrying
    insertPrice(db, { asset: "ETH", date: "2026-06-01", source: "t", market: "CB", price_usd: "3000", usd_twd_rate: "31.00" });
    ingest(db, { event_id: "e1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "ETH", qty: "1" });

    // spend 0.01 ETH on gas at 3200 * 31.20
    insertPrice(db, { asset: "ETH", date: "2026-06-05", source: "t", market: "CB", price_usd: "3200", usd_twd_rate: "31.20" });
    const gas: SubledgerEvent = {
      event_id: "g1", type: "GAS", timestamp: "2026-06-05T10:00:00Z", wallet_id: "w", asset: "ETH", qty: "0.01", tx_hash: "beef",
    };
    const r = ingest(db, gas);
    expect(r.posted).toBe(true);

    const e = getJournalEntries(db).find((x) => x.event_id === "g1")!;
    expect(isBalanced(e)).toBe(true);
    // FV gas = 0.01 * 3200 * 31.20 = 998.40 ; carrying consumed = 0.01 of 93,000 = 930.00
    expect(line(e, "fee_expense")!.dr_cr).toBe("DR");
    expect(line(e, "fee_expense")!.amount_twd).toBe("998.40");
    expect(line(e, "digital_asset")!.dr_cr).toBe("CR");
    expect(line(e, "digital_asset")!.amount_twd).toBe("930.00");
    // disposal gain = 998.40 - 930.00 = 68.40
    expect(line(e, "disposal_gain")!.amount_twd).toBe("68.40");
  });
});
