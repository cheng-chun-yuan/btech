import { describe, it, expect } from "vitest";

import { ingest } from "./engine";
import { openTestSubledgerDb, insertPrice, getJournalEntries } from "./store";
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

describe("RECEIVE_NONCASH (§6)", () => {
  it("books revenue at crypto FV and COGS, and opens a lot", () => {
    const db = openTestSubledgerDb();
    insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });

    const sale: SubledgerEvent = {
      event_id: "rn1",
      type: "RECEIVE_NONCASH",
      timestamp: "2026-06-01T10:00:00Z",
      wallet_id: "w",
      asset: "BTC",
      qty: "1",
      cogs_twd: "1500000",
      tx_hash: "abc",
    };
    const r = ingest(db, sale);
    expect(r.posted).toBe(true);

    const e = getJournalEntries(db).find((x) => x.event_id === "rn1")!;
    expect(isBalanced(e)).toBe(true);
    // crypto received at FV 1,875,000 = sales revenue
    expect(line(e, "digital_asset")!.dr_cr).toBe("DR");
    expect(line(e, "digital_asset")!.amount_twd).toBe("1875000.00");
    expect(line(e, "sales_revenue")!.dr_cr).toBe("CR");
    expect(line(e, "sales_revenue")!.amount_twd).toBe("1875000.00");
    // COGS leg
    expect(line(e, "cogs")!.dr_cr).toBe("DR");
    expect(line(e, "cogs")!.amount_twd).toBe("1500000.00");
    expect(line(e, "inventory")!.dr_cr).toBe("CR");
    expect(line(e, "inventory")!.amount_twd).toBe("1500000.00");

    expect(getLot(db, "rn1")!.cost_twd).toBe("1875000.0000");
  });
});
