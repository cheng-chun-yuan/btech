import { describe, it, expect } from "vitest";

import { ingest, reverseEntry } from "./engine";
import { openTestSubledgerDb, insertPrice, getJournalEntries } from "./store";
import { parseDecimal, TWD_POSTING_SCALE } from "./money";
import type { JournalEntry } from "./types";

function netByAccount(entries: JournalEntry[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const e of entries) {
    for (const l of e.lines) {
      const amt = parseDecimal(l.amount_twd, TWD_POSTING_SCALE);
      net.set(l.account, (net.get(l.account) ?? BigInt(0)) + (l.dr_cr === "DR" ? amt : -amt));
    }
  }
  return net;
}

describe("corrections are reversing entries (INV-3)", () => {
  it("reverses a posted entry with swapped DR/CR; both retained, net zero", () => {
    const db = openTestSubledgerDb();
    insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
    ingest(db, { event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" });

    const rev = reverseEntry(db, "je-b1");
    expect(rev.reverses).toBe("je-b1");

    const entries = getJournalEntries(db);
    // both the original and the reversal are retained
    expect(entries.find((e) => e.je_id === "je-b1")).toBeDefined();
    expect(entries.find((e) => e.je_id === rev.je_id)).toBeDefined();

    // every account nets to zero after the reversal
    for (const [, v] of netByAccount(entries)) expect(v).toBe(BigInt(0));
  });

  it("cannot hard-delete or mutate the original (WORM)", () => {
    const db = openTestSubledgerDb();
    insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
    ingest(db, { event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" });
    expect(() => db.prepare("DELETE FROM sl_journal_entry WHERE je_id=?").run("je-b1")).toThrow(/WORM/);
    expect(() => db.prepare("UPDATE sl_journal_line SET amount_twd='0' WHERE je_id=?").run("je-b1")).toThrow(/WORM/);
  });
});
