// acceptance.test.ts — the §12 self-verification checklist, exercised
// end-to-end. Per-feature behavior is covered in the focused test files; this
// asserts the cross-cutting invariants over a mixed event stream plus the
// config-switchability (INV-5) and PENDING-as-config rules.

import { describe, it, expect } from "vitest";

import { ingest } from "./engine";
import { classify } from "./classify";
import { runReconcile } from "./reconcile";
import {
  openTestSubledgerDb,
  insertPrice,
  insertMonetaryItem,
  getPolicy,
  getJournalEntries,
  type DB,
} from "./store";
import { parseDecimal, TWD_POSTING_SCALE } from "./money";
import type { SubledgerEvent } from "./types";

const ON_CHAIN = new Set(["OFFRAMP", "GAS", "PAY_SUPPLIER", "RECEIVE_SETTLE_AR", "RECEIVE_NONCASH"]);

function runMixedStream(db: DB) {
  insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "t", market: "CB", price_usd: "60000", usd_twd_rate: "31.25" });
  insertPrice(db, { asset: "BTC", date: "2026-06-05", source: "t", market: "CB", price_usd: "62000", usd_twd_rate: "31.00" });
  insertPrice(db, { asset: "BTC", date: "2026-06-20", source: "t", market: "CB", price_usd: "55000", usd_twd_rate: "31.40" });
  insertPrice(db, { asset: "BTC", date: "2026-06-30", source: "t", market: "CB", price_usd: "50000", usd_twd_rate: "31.25" });
  insertPrice(db, { asset: "ETH", date: "2026-06-02", source: "t", market: "CB", price_usd: "3000", usd_twd_rate: "31.00" });
  insertPrice(db, { asset: "ETH", date: "2026-06-06", source: "t", market: "CB", price_usd: "3200", usd_twd_rate: "31.20" });
  insertMonetaryItem(db, { doc_no: "BILL-1", kind: "AP", ccy: "USD", orig_amount: "30000", carrying_twd: "930000", open: true });

  const events: SubledgerEvent[] = [
    { event_id: "b1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" },
    { event_id: "b2", type: "BUY", timestamp: "2026-06-05T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "1" },
    { event_id: "e1", type: "BUY", timestamp: "2026-06-02T10:00:00Z", wallet_id: "w", asset: "ETH", qty: "1" },
    { event_id: "s1", type: "SELL", timestamp: "2026-06-10T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "0.5", proceeds_twd: "1000000" },
    { event_id: "g1", type: "GAS", timestamp: "2026-06-06T10:00:00Z", wallet_id: "w", asset: "ETH", qty: "0.01", tx_hash: "gas01" },
    { event_id: "p1", type: "PAY_SUPPLIER", timestamp: "2026-06-20T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "0.5", invoice_no: "BILL-1", tx_hash: "pay01" },
    { event_id: "pe1", type: "PERIODEND_REVALUE", timestamp: "2026-06-30T23:59:59Z", wallet_id: "w", asset: "BTC", qty: "0" },
    { event_id: "bad1", type: "OFFRAMP", timestamp: "2026-06-11T10:00:00Z", wallet_id: "w", asset: "BTC", qty: "0.1", proceeds_twd: "200000" }, // no tx_hash -> quarantine
  ];
  for (const ev of events) ingest(db, ev);
}

describe("acceptance §12", () => {
  it("INV-1: every posted entry balances at posting scale", () => {
    const db = openTestSubledgerDb();
    runMixedStream(db);
    for (const e of getJournalEntries(db)) {
      let dr = BigInt(0);
      let cr = BigInt(0);
      for (const l of e.lines) {
        const amt = parseDecimal(l.amount_twd, TWD_POSTING_SCALE);
        if (l.dr_cr === "DR") dr += amt;
        else cr += amt;
      }
      expect(dr).toBe(cr);
    }
  });

  it("INV-2: every entry carries an event_id; on-chain lines carry tx_hash", () => {
    const db = openTestSubledgerDb();
    runMixedStream(db);
    const getType = db.prepare("SELECT type FROM sl_event WHERE event_id=?");
    for (const e of getJournalEntries(db)) {
      expect(e.event_id).toBeTruthy();
      const type = (getType.get(e.event_id) as { type: string }).type;
      if (ON_CHAIN.has(type)) {
        expect(e.lines.every((l) => !!l.tx_hash)).toBe(true);
      }
    }
  });

  it("INV-10: the invalid OFFRAMP was quarantined, never posted", () => {
    const db = openTestSubledgerDb();
    runMixedStream(db);
    expect(getJournalEntries(db).find((e) => e.event_id === "bad1")).toBeUndefined();
    const ev = db.prepare("SELECT status FROM sl_event WHERE event_id='bad1'").get() as { status: string };
    expect(ev.status).toBe("quarantined");
  });

  it("INV-4: the period reconciles three-way after the stream", () => {
    const db = openTestSubledgerDb();
    runMixedStream(db);
    // subledger remaining: BTC 1.0 (2 - 0.5 sold - 0.5 paid), ETH 0.99
    const res = runReconcile(db, "2026-06", { BTC: "1", ETH: "0.99" });
    for (const r of res) expect(r.status).toBe("tie");
  });

  it("INV-5: USDC classification switches IAS38<->FVTPL via config only", () => {
    const db = openTestSubledgerDb();
    expect(classify(db, "USDC").classification).toBe("INTANGIBLE_IAS38");
    db.prepare("UPDATE sl_config SET redeemable_unconditional=1 WHERE asset='USDC'").run();
    expect(classify(db, "USDC").classification).toBe("FINANCIAL_FVTPL");
    expect(classify(db, "USDC").measurement).toBe("FVTPL");
    db.prepare("UPDATE sl_config SET redeemable_unconditional=0 WHERE asset='USDC'").run();
    expect(classify(db, "USDC").classification).toBe("INTANGIBLE_IAS38");
  });

  it("PENDING_* values are config rows with their status, not hardcoded", () => {
    const db = openTestSubledgerDb();
    expect(getPolicy(db, "tax_treatment")?.status).toBe("PENDING_DELOITTE");
    expect(getPolicy(db, "cost_flow" as string)?.value).toBeUndefined(); // cost_flow lives per-asset in sl_config
    expect(getPolicy(db, "functional_currency")?.value).toBe("TWD");
  });
});
