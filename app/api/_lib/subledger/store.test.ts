import { describe, it, expect } from "vitest";

import {
  openTestSubledgerDb,
  seedConfig,
  getAssetConfig,
  getPolicy,
  insertJournalEntry,
  insertPrice,
  getPrice,
} from "./store";
import type { JournalEntry, PricePoint } from "./types";

const SL_TABLES = [
  "sl_config",
  "sl_policy",
  "sl_event",
  "sl_lot",
  "sl_lot_consumption",
  "sl_journal_entry",
  "sl_journal_line",
  "sl_monetary_item",
  "sl_price",
  "sl_reconciliation",
  "sl_exception",
];

const postedEntry = (): JournalEntry => ({
  je_id: "je-1",
  event_id: "ev-1",
  period: "2026-06",
  status: "posted",
  gaap: "TIFRS",
  lines: [
    { dr_cr: "DR", account: "digital_asset", amount_twd: "100.00", asset: "BTC", qty: "1", tx_hash: "abc" },
    { dr_cr: "CR", account: "bank", amount_twd: "100.00", tx_hash: "abc" },
  ],
});

describe("store schema", () => {
  it("creates every sl_* table", () => {
    const db = openTestSubledgerDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of SL_TABLES) expect(names).toContain(t);
  });
});

describe("store config seed", () => {
  it("seeds asset configs and policy params (idempotent)", () => {
    const db = openTestSubledgerDb();
    expect(getAssetConfig(db, "BTC")?.classification).toBe("INTANGIBLE_IAS38");
    expect(getAssetConfig(db, "USDC")?.measurement).toBe("COST_MODEL");
    expect(getPolicy(db, "functional_currency")?.value).toBe("TWD");

    const before = (db.prepare("SELECT COUNT(*) c FROM sl_config").get() as { c: number }).c;
    seedConfig(db); // re-seed must not duplicate
    const after = (db.prepare("SELECT COUNT(*) c FROM sl_config").get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

describe("store prices", () => {
  it("round-trips a PricePoint by asset+date", () => {
    const db = openTestSubledgerDb();
    const pp: PricePoint = {
      asset: "BTC",
      date: "2026-06-01",
      source: "test",
      market: "Coinbase",
      price_usd: "65000",
      usd_twd_rate: "31.25",
    };
    insertPrice(db, pp);
    expect(getPrice(db, "BTC", "2026-06-01")?.price_usd).toBe("65000");
    expect(getPrice(db, "BTC", "2026-06-02")).toBeUndefined();
  });
});

describe("store WORM (INV-3)", () => {
  it("blocks UPDATE and DELETE of a posted journal entry/line", () => {
    const db = openTestSubledgerDb();
    insertJournalEntry(db, postedEntry());

    expect(() =>
      db.prepare("UPDATE sl_journal_entry SET status='reversed' WHERE je_id=?").run("je-1"),
    ).toThrow(/WORM/);
    expect(() =>
      db.prepare("DELETE FROM sl_journal_entry WHERE je_id=?").run("je-1"),
    ).toThrow(/WORM/);
    expect(() =>
      db.prepare("UPDATE sl_journal_line SET amount_twd='0' WHERE je_id=?").run("je-1"),
    ).toThrow(/WORM/);
    expect(() =>
      db.prepare("DELETE FROM sl_journal_line WHERE je_id=?").run("je-1"),
    ).toThrow(/WORM/);
  });

  it("persists the entry and its lines", () => {
    const db = openTestSubledgerDb();
    insertJournalEntry(db, postedEntry());
    const lines = db.prepare("SELECT COUNT(*) c FROM sl_journal_line WHERE je_id=?").get("je-1") as { c: number };
    expect(lines.c).toBe(2);
  });
});
