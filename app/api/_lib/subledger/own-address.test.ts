import { describe, it, expect } from "vitest";

import { ingest } from "./engine";
import {
  openTestSubledgerDb,
  insertPrice,
  getJournalEntries,
  registerOwnWallet,
  isOwnAddress,
  type DB,
} from "./store";
import { getLot } from "./lots";
import type { JournalEntry, SubledgerEvent } from "./types";

const line = (e: JournalEntry, account: string) => e.lines.find((l) => l.account === account);

function holdOneBtc(db: DB) {
  insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
  ingest(db, { event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "cold", asset: "BTC", qty: "1" });
}

describe("own-address registry inference (B)", () => {
  it("registers and looks up the company's own addresses", () => {
    const db = openTestSubledgerDb();
    registerOwnWallet(db, "bc1p-petty", "petty");
    expect(isOwnAddress(db, "bc1p-petty")).toBe(true);
    expect(isOwnAddress(db, "bc1q-external")).toBe(false);
  });

  it("a SEND to a registered own address is reclassified to an internal move (gas-only)", () => {
    const db = openTestSubledgerDb();
    holdOneBtc(db);
    registerOwnWallet(db, "bc1p-petty", "petty");
    insertPrice(db, { asset: "BTC", date: "2026-06-10", source: "t", market: "CB", price_usd: "50000", usd_twd_rate: "31.40" });

    // labeled OFFRAMP, but the destination is our own petty vault -> internal
    const ev: SubledgerEvent = {
      event_id: "x1",
      type: "OFFRAMP",
      timestamp: "2026-06-10T10:00:00Z",
      wallet_id: "cold",
      asset: "BTC",
      qty: "0.5",
      fee_gas: "0.0001",
      proceeds_twd: "1000000",
      dest_address: "bc1p-petty",
      tx_hash: "h",
    };
    ingest(db, ev);
    const e = getJournalEntries(db).find((x) => x.event_id === "x1")!;
    // gas-only: fee_expense booked, NO bank line (it is not a real off-ramp)
    expect(line(e, "fee_expense")).toBeDefined();
    expect(line(e, "bank")).toBeUndefined();
    // principal NOT disposed: only the 0.0001 gas left the lot
    expect(getLot(db, "b1")!.remaining_qty).toBe("0.99990000");
  });

  it("a SEND to an unregistered (external) address books a normal disposal", () => {
    const db = openTestSubledgerDb();
    holdOneBtc(db);
    insertPrice(db, { asset: "BTC", date: "2026-06-10", source: "t", market: "CB", price_usd: "50000", usd_twd_rate: "31.40" });
    const ev: SubledgerEvent = {
      event_id: "x2",
      type: "OFFRAMP",
      timestamp: "2026-06-10T10:00:00Z",
      wallet_id: "cold",
      asset: "BTC",
      qty: "0.5",
      proceeds_twd: "1000000",
      dest_address: "bc1q-external",
      tx_hash: "h",
    };
    ingest(db, ev);
    const e = getJournalEntries(db).find((x) => x.event_id === "x2")!;
    expect(line(e, "bank")).toBeDefined(); // a real disposal
    expect(getLot(db, "b1")!.remaining_qty).toBe("0.50000000"); // 0.5 principal disposed
  });

  it("a RECEIVE/BUY to an own address is NOT reclassified (acquisitions are exempt)", () => {
    const db = openTestSubledgerDb();
    insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
    registerOwnWallet(db, "bc1p-cold", "cold");
    const r = ingest(db, {
      event_id: "buyX",
      type: "BUY",
      timestamp: "2026-06-01T10:00:00Z",
      wallet_id: "cold",
      asset: "BTC",
      qty: "1",
      dest_address: "bc1p-cold", // your own receive address — irrelevant for a BUY
    });
    expect(r.posted).toBe(true);
    expect(getLot(db, "buyX")).toBeDefined(); // still an acquisition (a lot opened)
  });
});
