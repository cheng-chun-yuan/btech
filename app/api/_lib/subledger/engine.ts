// engine.ts — the ingest pipeline: validate (§8) -> classify (§4) -> measure
// (§5) -> post (§6/§7). Posting is a data-driven event_type -> line-builder map,
// not nested conditionals. Every posted entry is asserted balanced (INV-1) and
// carries event_id + tx_hash (INV-2). Invalid events are quarantined (INV-10).

import {
  parseDecimal,
  formatDecimal,
  rescale,
  valueTwd,
  QTY_SCALE,
  PRICE_SCALE,
  FX_SCALE,
  TWD_INTERNAL_SCALE,
  TWD_POSTING_SCALE,
  type Minor,
} from "./money";
import {
  getPrice,
  insertEvent,
  insertException,
  insertJournalEntry,
  type DB,
} from "./store";
import { classify } from "./classify";
import { validate } from "./validate";
import { createLot, consumeLots, getOpenLots, updateAccumImpairment } from "./lots";
import type { AssetConfig, JournalEntry, JournalLine, SubledgerEvent } from "./types";

export interface IngestResult {
  posted: boolean;
  je_id?: string;
  reason?: string;
}

const ZERO = BigInt(0);

const dateOf = (ts: string) => ts.slice(0, 10);
const periodOf = (ts: string) => ts.slice(0, 7);
const post = (internal: Minor): string =>
  formatDecimal(rescale(internal, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE), TWD_POSTING_SCALE);

/** Assert debits == credits at posting scale (INV-1). */
function assertBalanced(entry: JournalEntry): void {
  let dr = ZERO;
  let cr = ZERO;
  for (const l of entry.lines) {
    const amt = parseDecimal(l.amount_twd, TWD_POSTING_SCALE);
    if (l.dr_cr === "DR") dr += amt;
    else cr += amt;
  }
  if (dr !== cr) {
    throw new Error(`INV-1 violation: entry ${entry.je_id} unbalanced (DR ${dr} != CR ${cr})`);
  }
}

/** ACQUIRE (§5): fair value at receipt becomes the lot cost basis. */
function acquire(db: DB, ev: SubledgerEvent): { lines: JournalLine[] } {
  const date = dateOf(ev.timestamp);
  const price = getPrice(db, ev.asset, date)!; // validated present
  const scale = QTY_SCALE[ev.asset];
  const qtyMinor = parseDecimal(ev.qty, scale);
  const fv = valueTwd(
    qtyMinor,
    scale,
    parseDecimal(price.price_usd, PRICE_SCALE),
    parseDecimal(price.usd_twd_rate, FX_SCALE),
  );

  createLot(db, {
    event_id: ev.event_id,
    wallet_id: ev.wallet_id,
    asset: ev.asset,
    acquire_date: date,
    acquire_fx_rate: price.usd_twd_rate,
    qty: ev.qty,
    cost_twd: formatDecimal(fv, TWD_INTERNAL_SCALE),
  });

  const amt = post(fv);
  // BUY / ONRAMP: consideration funded from bank.
  return {
    lines: [
      { dr_cr: "DR", account: "digital_asset", amount_twd: amt, asset: ev.asset, qty: ev.qty, tx_hash: ev.tx_hash ?? null },
      { dr_cr: "CR", account: "bank", amount_twd: amt, tx_hash: ev.tx_hash ?? null },
    ],
  };
}

/** DISPOSE (§5/§6): consume lots per cost flow; book proceeds vs carrying. */
function dispose(db: DB, ev: SubledgerEvent, cfg: AssetConfig): { lines: JournalLine[] } {
  const { carrying_twd } = consumeLots(db, {
    disposal_event_id: ev.event_id,
    wallet_id: ev.wallet_id,
    asset: ev.asset,
    qty: ev.qty,
    cost_flow: cfg.cost_flow,
  });

  const proceedsInternal = parseDecimal(ev.proceeds_twd ?? "0", TWD_INTERNAL_SCALE);
  const proceedsPosting = rescale(proceedsInternal, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE);
  const carryingPosting = rescale(carrying_twd, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE);
  // Compute the disposal delta at posting scale so the entry balances exactly.
  const deltaPosting = proceedsPosting - carryingPosting;
  const tx = ev.tx_hash ?? null;

  const lines: JournalLine[] = [
    { dr_cr: "DR", account: "bank", amount_twd: formatDecimal(proceedsPosting, TWD_POSTING_SCALE), tx_hash: tx },
    { dr_cr: "CR", account: "digital_asset", amount_twd: formatDecimal(carryingPosting, TWD_POSTING_SCALE), asset: ev.asset, qty: ev.qty, tx_hash: tx },
  ];
  if (deltaPosting > ZERO) {
    lines.push({ dr_cr: "CR", account: "disposal_gain", amount_twd: formatDecimal(deltaPosting, TWD_POSTING_SCALE), tx_hash: tx });
  } else if (deltaPosting < ZERO) {
    lines.push({ dr_cr: "DR", account: "disposal_loss", amount_twd: formatDecimal(-deltaPosting, TWD_POSTING_SCALE), tx_hash: tx });
  }
  return { lines };
}

/**
 * PERIOD_END (§5) for INTANGIBLE_IAS38 + COST_MODEL. Per lot: recoverable uses
 * the LOCKED acquisition fx rate (non-monetary, INV-7), never the period-end
 * rate. Impair on the way down; reverse only previously-impaired amounts, capped
 * at original cost — no upside above cost before disposal (INV-8).
 */
function periodEndRevalue(db: DB, ev: SubledgerEvent): { lines: JournalLine[] } {
  const date = dateOf(ev.timestamp);
  const price = getPrice(db, ev.asset, date)!; // validated present
  const priceUsd = parseDecimal(price.price_usd, PRICE_SCALE);
  const scale = QTY_SCALE[ev.asset];

  let totalImpairment = ZERO;
  let totalReversal = ZERO;
  for (const lot of getOpenLots(db, ev.wallet_id, ev.asset)) {
    const remainingQty = parseDecimal(lot.remaining_qty, scale);
    const recoverable = valueTwd(
      remainingQty,
      scale,
      priceUsd,
      parseDecimal(lot.acquire_fx_rate, FX_SCALE), // LOCKED at acquisition (INV-7)
    );
    const remainingCost = parseDecimal(lot.remaining_cost_twd, TWD_INTERNAL_SCALE);
    const accumImp = parseDecimal(lot.accum_impairment_twd, TWD_INTERNAL_SCALE);
    const carrying = remainingCost - accumImp;

    if (recoverable < carrying) {
      const imp = carrying - recoverable;
      totalImpairment += imp;
      updateAccumImpairment(db, lot.lot_id, formatDecimal(accumImp + imp, TWD_INTERNAL_SCALE));
    } else if (accumImp > ZERO && recoverable > carrying) {
      const cap = recoverable < remainingCost ? recoverable : remainingCost; // min(recoverable, cost)
      const reversal = cap - carrying; // <= accumImp by construction
      totalReversal += reversal;
      updateAccumImpairment(db, lot.lot_id, formatDecimal(accumImp - reversal, TWD_INTERNAL_SCALE));
    }
  }

  const lines: JournalLine[] = [];
  if (totalImpairment > ZERO) {
    const amt = post(totalImpairment);
    lines.push({ dr_cr: "DR", account: "impairment_loss", amount_twd: amt, asset: ev.asset });
    lines.push({ dr_cr: "CR", account: "accum_impairment", amount_twd: amt, asset: ev.asset });
  }
  if (totalReversal > ZERO) {
    const amt = post(totalReversal);
    lines.push({ dr_cr: "DR", account: "accum_impairment", amount_twd: amt, asset: ev.asset });
    lines.push({ dr_cr: "CR", account: "impairment_reversal_gain", amount_twd: amt, asset: ev.asset });
  }
  return { lines };
}

type Builder = (db: DB, ev: SubledgerEvent, cfg: AssetConfig) => { lines: JournalLine[] };

const BUILDERS: Partial<Record<SubledgerEvent["type"], Builder>> = {
  BUY: (db, ev) => acquire(db, ev),
  ONRAMP: (db, ev) => acquire(db, ev),
  SELL: dispose,
  OFFRAMP: dispose,
  PERIODEND_REVALUE: (db, ev) => periodEndRevalue(db, ev),
};

export function ingest(db: DB, ev: SubledgerEvent): IngestResult {
  const v = validate(db, ev);
  if (!v.ok) {
    insertEvent(db, ev, "quarantined", v.reason);
    insertException(db, "rejected_event", ev.event_id, v.reason);
    return { posted: false, reason: v.reason };
  }

  const cfg = classify(db, ev.asset);
  const builder = BUILDERS[ev.type];
  if (!builder) {
    const reason = `no posting rule for ${ev.type}`;
    insertEvent(db, ev, "quarantined", reason);
    insertException(db, "rejected_event", ev.event_id, reason);
    return { posted: false, reason };
  }

  const { lines } = builder(db, ev, cfg);
  // A processed event with nothing to book (e.g. a period-end with no impairment
  // or reversal) is a legitimate no-op, not a quarantine.
  if (lines.length === 0) {
    insertEvent(db, ev, "posted");
    return { posted: false, reason: "no measurable change" };
  }

  const entry: JournalEntry = {
    je_id: `je-${ev.event_id}`,
    event_id: ev.event_id,
    period: periodOf(ev.timestamp),
    status: "posted",
    gaap: "TIFRS",
    lines,
  };
  assertBalanced(entry);

  insertEvent(db, ev, "posted");
  insertJournalEntry(db, entry);
  return { posted: true, je_id: entry.je_id };
}
