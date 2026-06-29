// validate.ts — §8 ingest validation. Events that fail are quarantined and never
// posted (INV-10). The engine calls this first and short-circuits on rejection.

import { getPrice, type DB } from "./store";
import type { EventType, SubledgerEvent } from "./types";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Crypto that moves on a public chain — a tx_hash is mandatory. */
const ON_CHAIN_TYPES = new Set<EventType>([
  "RECEIVE_NONCASH",
  "RECEIVE_SETTLE_AR",
  "PAY_SUPPLIER",
  "OFFRAMP",
  "ONRAMP",
  "GAS",
]);

/** Events that settle a monetary AR/AP — an invoice_no is mandatory. */
const AR_AP_TYPES = new Set<EventType>(["RECEIVE_SETTLE_AR", "PAY_SUPPLIER"]);

// Need a PricePoint at the date: acquisitions/revaluations measure fair value
// from it; settlements read the USD/TWD rate from it.
const PRICE_REQUIRED_TYPES = new Set<EventType>([
  "BUY",
  "ONRAMP",
  "RECEIVE_NONCASH",
  "RECEIVE_SETTLE_AR",
  "PAY_SUPPLIER",
  "GAS",
  "PERIODEND_REVALUE",
]);

/** YYYY-MM-DD from an ISO timestamp. */
function dateOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export function validate(db: DB, ev: SubledgerEvent): ValidationResult {
  if (!ev.timestamp) return { ok: false, reason: "missing timestamp" };
  if (!ev.asset) return { ok: false, reason: "missing asset" };

  // PERIODEND_REVALUE has no qty move — it remeasures existing lots.
  if (ev.type !== "PERIODEND_REVALUE") {
    const qty = Number(ev.qty);
    if (!(qty > 0)) return { ok: false, reason: "qty must be > 0" };
  }

  if (ON_CHAIN_TYPES.has(ev.type) && !ev.tx_hash) {
    return { ok: false, reason: "on-chain move requires tx_hash" };
  }
  if (AR_AP_TYPES.has(ev.type) && !ev.invoice_no) {
    return { ok: false, reason: "AR/AP settlement requires invoice_no" };
  }
  if (PRICE_REQUIRED_TYPES.has(ev.type) && !getPrice(db, ev.asset, dateOf(ev.timestamp))) {
    return { ok: false, reason: `no PricePoint for ${ev.asset} on ${dateOf(ev.timestamp)}` };
  }
  return { ok: true };
}
