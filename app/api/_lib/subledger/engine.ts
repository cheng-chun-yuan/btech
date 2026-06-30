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
  USD_SCALE,
  TWD_INTERNAL_SCALE,
  TWD_POSTING_SCALE,
  type Minor,
} from "./money";
import {
  getPrice,
  getAssetConfig,
  getMonetaryItem,
  getOpenMonetaryItems,
  updateMonetaryItem,
  insertEvent,
  insertException,
  insertJournalEntry,
  getJournalEntries,
  type DB,
} from "./store";
import { classify } from "./classify";
import { validate } from "./validate";
import { createLot, consumeLots, getOpenLots, updateAccumImpairment } from "./lots";
import type { JournalEntry, JournalLine, SubledgerEvent } from "./types";

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

/**
 * Disposal posting shared by SELL/OFFRAMP/GAS/settlement. Credits digital_asset
 * at GROSS cost and debits accum_impairment to clear the contra (so both GL
 * accounts zero out for a fully-disposed lot — INV-4). The delta vs proceeds is
 * a disposal gain/loss, computed at posting scale so the entry balances exactly.
 */
function disposalLines(
  ev: SubledgerEvent,
  proceedsP: Minor,
  grossP: Minor,
  impairmentP: Minor,
  debit: { account: JournalLine["account"]; memo?: string },
): JournalLine[] {
  const netP = grossP - impairmentP;
  const deltaP = proceedsP - netP;
  const tx = ev.tx_hash ?? null;
  const lines: JournalLine[] = [
    { dr_cr: "DR", account: debit.account, amount_twd: fmtP(proceedsP), tx_hash: tx, memo: debit.memo },
    { dr_cr: "CR", account: "digital_asset", amount_twd: fmtP(grossP), asset: ev.asset, qty: ev.qty, tx_hash: tx },
  ];
  if (impairmentP > ZERO) {
    lines.push({ dr_cr: "DR", account: "accum_impairment", amount_twd: fmtP(impairmentP), asset: ev.asset, tx_hash: tx });
  }
  if (deltaP > ZERO) lines.push({ dr_cr: "CR", account: "disposal_gain", amount_twd: fmtP(deltaP), tx_hash: tx, memo: "disposal_leg" });
  else if (deltaP < ZERO) lines.push({ dr_cr: "DR", account: "disposal_loss", amount_twd: fmtP(-deltaP), tx_hash: tx, memo: "disposal_leg" });
  return lines;
}

/** DISPOSE (§5/§6): consume lots per cost flow; book proceeds vs carrying. */
function dispose(db: DB, ev: SubledgerEvent): { lines: JournalLine[] } {
  const cfg = classify(db, ev.asset);
  const { gross_twd, impairment_twd } = consumeLots(db, {
    disposal_event_id: ev.event_id,
    wallet_id: ev.wallet_id,
    asset: ev.asset,
    qty: ev.qty,
    cost_flow: cfg.cost_flow,
  });
  const toP = (v: Minor) => rescale(v, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE);
  const proceedsP = toP(parseDecimal(ev.proceeds_twd ?? "0", TWD_INTERNAL_SCALE));
  return { lines: disposalLines(ev, proceedsP, toP(gross_twd), toP(impairment_twd), { account: "bank" }) };
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

/**
 * PERIOD_END monetary FX (§6, INV-7): USD AR/AP ARE retranslated at the closing
 * rate (unlike non-monetary crypto). Each item: new carrying = orig_usd *
 * closing_rate; the delta hits fx_gain_loss. An AR (asset) up is a gain; an AP
 * (liability) up is a loss.
 */
function monetaryRetranslate(db: DB, ev: SubledgerEvent): { lines: JournalLine[] } {
  const date = dateOf(ev.timestamp);
  const closing = parseDecimal(getPrice(db, ev.asset, date)!.usd_twd_rate, FX_SCALE);
  const lines: JournalLine[] = [];

  for (const item of getOpenMonetaryItems(db, ev.asset)) {
    const newCarrying = rescale(
      parseDecimal(item.orig_amount, USD_SCALE) * closing,
      USD_SCALE + FX_SCALE,
      TWD_INTERNAL_SCALE,
    );
    const oldCarrying = parseDecimal(item.carrying_twd, TWD_INTERNAL_SCALE);
    const delta = newCarrying - oldCarrying;
    if (delta === ZERO) continue;
    updateMonetaryItem(db, item.doc_no, formatDecimal(newCarrying, TWD_INTERNAL_SCALE), item.open);

    const amt = formatDecimal(rescale(delta < ZERO ? -delta : delta, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE), TWD_POSTING_SCALE);
    const account = item.kind === "AR" ? "accounts_receivable" : "accounts_payable";
    if (item.kind === "AR") {
      // AR up -> Dr AR / Cr fx gain ; AR down -> Cr AR / Dr fx loss
      const arUp = delta > ZERO;
      lines.push({ dr_cr: arUp ? "DR" : "CR", account, amount_twd: amt, orig_ccy: item.ccy, memo: item.doc_no });
      lines.push({ dr_cr: arUp ? "CR" : "DR", account: "fx_gain_loss", amount_twd: amt, memo: item.doc_no });
    } else {
      // AP up -> Cr AP / Dr fx loss ; AP down -> Dr AP / Cr fx gain
      const apUp = delta > ZERO;
      lines.push({ dr_cr: apUp ? "CR" : "DR", account, amount_twd: amt, orig_ccy: item.ccy, memo: item.doc_no });
      lines.push({ dr_cr: apUp ? "DR" : "CR", account: "fx_gain_loss", amount_twd: amt, memo: item.doc_no });
    }
  }
  return { lines };
}

const fmtP = (posting: Minor) => formatDecimal(posting, TWD_POSTING_SCALE);

/**
 * PAY_SUPPLIER (§6/§7): settle a USD AP with crypto. The two causes are split,
 * never collapsed: the fx_leg revalues the (monetary) AP to the settlement rate
 * -> fx_gain_loss; the disposal_leg compares the value settled to the (non-
 * monetary, fx-locked) crypto lot carrying -> disposal_gain_loss. Computing both
 * legs at posting scale off a single settled value makes the entry balance
 * exactly (apCarrying + fxLeg == lotCarrying + disposalLeg).
 */
function paySupplier(db: DB, ev: SubledgerEvent): { lines: JournalLine[] } {
  const date = dateOf(ev.timestamp);
  const rate = parseDecimal(getPrice(db, ev.asset, date)!.usd_twd_rate, FX_SCALE);
  const ap = getMonetaryItem(db, ev.invoice_no!);
  if (!ap || ap.kind !== "AP" || !ap.open) {
    throw new Error(`PAY_SUPPLIER: no open AP for invoice ${ev.invoice_no}`);
  }

  const apCarrying = parseDecimal(ap.carrying_twd, TWD_INTERNAL_SCALE);
  const apSettled = rescale(
    parseDecimal(ap.orig_amount, USD_SCALE) * rate,
    USD_SCALE + FX_SCALE,
    TWD_INTERNAL_SCALE,
  );
  const { gross_twd, impairment_twd } = consumeLots(db, {
    disposal_event_id: ev.event_id,
    wallet_id: ev.wallet_id,
    asset: ev.asset,
    qty: ev.qty,
    cost_flow: classify(db, ev.asset).cost_flow,
  });
  updateMonetaryItem(db, ap.doc_no, formatDecimal(apSettled, TWD_INTERNAL_SCALE), false);

  const toP = (v: Minor) => rescale(v, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE);
  const apCarryingP = toP(apCarrying);
  const grossP = toP(gross_twd);
  const impairmentP = toP(impairment_twd);
  const apSettledP = toP(apSettled);
  const fxLegP = apSettledP - apCarryingP; // AP up = loss
  const disposalLegP = apSettledP - (grossP - impairmentP); // value settled - net carrying
  const tx = ev.tx_hash ?? null;

  const lines: JournalLine[] = [
    { dr_cr: "DR", account: "accounts_payable", amount_twd: fmtP(apCarryingP), orig_ccy: ap.ccy, orig_amount: ap.orig_amount, tx_hash: tx, memo: ap.doc_no },
    { dr_cr: "CR", account: "digital_asset", amount_twd: fmtP(grossP), asset: ev.asset, qty: ev.qty, tx_hash: tx },
  ];
  if (impairmentP > ZERO) lines.push({ dr_cr: "DR", account: "accum_impairment", amount_twd: fmtP(impairmentP), asset: ev.asset, tx_hash: tx });
  if (fxLegP > ZERO) lines.push({ dr_cr: "DR", account: "fx_gain_loss", amount_twd: fmtP(fxLegP), tx_hash: tx, memo: "fx_leg" });
  else if (fxLegP < ZERO) lines.push({ dr_cr: "CR", account: "fx_gain_loss", amount_twd: fmtP(-fxLegP), tx_hash: tx, memo: "fx_leg" });
  if (disposalLegP > ZERO) lines.push({ dr_cr: "CR", account: "disposal_gain", amount_twd: fmtP(disposalLegP), tx_hash: tx, memo: "disposal_leg" });
  else if (disposalLegP < ZERO) lines.push({ dr_cr: "DR", account: "disposal_loss", amount_twd: fmtP(-disposalLegP), tx_hash: tx, memo: "disposal_leg" });
  return { lines };
}

/** RECEIVE_NONCASH (§6): sell goods, paid in crypto. The crypto received is
 *  revenue at fair value (and opens a lot); COGS reduces inventory. */
function receiveNoncash(db: DB, ev: SubledgerEvent): { lines: JournalLine[] } {
  const date = dateOf(ev.timestamp);
  const price = getPrice(db, ev.asset, date)!;
  const scale = QTY_SCALE[ev.asset];
  const fv = valueTwd(
    parseDecimal(ev.qty, scale),
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

  const tx = ev.tx_hash ?? null;
  const fvP = fmtP(rescale(fv, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE));
  const lines: JournalLine[] = [
    { dr_cr: "DR", account: "digital_asset", amount_twd: fvP, asset: ev.asset, qty: ev.qty, tx_hash: tx },
    { dr_cr: "CR", account: "sales_revenue", amount_twd: fvP, tx_hash: tx },
  ];
  // COGS leg: reduce inventory by the cost of goods sold, if provided.
  if (ev.cogs_twd) {
    const cogsP = fmtP(rescale(parseDecimal(ev.cogs_twd, TWD_INTERNAL_SCALE), TWD_INTERNAL_SCALE, TWD_POSTING_SCALE));
    lines.push({ dr_cr: "DR", account: "cogs", amount_twd: cogsP, tx_hash: tx });
    lines.push({ dr_cr: "CR", account: "inventory", amount_twd: cogsP, tx_hash: tx });
  }
  return { lines };
}

/** GAS (§6): a pure transfer fee paid in crypto. Expense at FV; dispose the
 *  crypto at lot carrying; the difference is a disposal gain/loss. */
function gas(db: DB, ev: SubledgerEvent): { lines: JournalLine[] } {
  const date = dateOf(ev.timestamp);
  const price = getPrice(db, ev.asset, date)!;
  const scale = QTY_SCALE[ev.asset];
  const fv = valueTwd(
    parseDecimal(ev.qty, scale),
    scale,
    parseDecimal(price.price_usd, PRICE_SCALE),
    parseDecimal(price.usd_twd_rate, FX_SCALE),
  );
  const { gross_twd, impairment_twd } = consumeLots(db, {
    disposal_event_id: ev.event_id,
    wallet_id: ev.wallet_id,
    asset: ev.asset,
    qty: ev.qty,
    cost_flow: classify(db, ev.asset).cost_flow,
  });
  const toP = (v: Minor) => rescale(v, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE);
  return { lines: disposalLines(ev, toP(fv), toP(gross_twd), toP(impairment_twd), { account: "fee_expense", memo: "gas" }) };
}

/**
 * INTERNAL_TRANSFER: a move between the company's own wallets (same beneficial
 * owner). Under IAS 38 you keep control, so it is NOT a disposal — the principal
 * is not derecognized and its lot basis + acquisition date are preserved. The
 * only real economic effect is the on-chain miner fee, which IS a disposal of
 * that fee quantity at fair value (booked exactly like GAS). With no fee it is a
 * no-op (invisible at the entity-pool level). Internal vs external is declared by
 * the event type here (approach A); a destination-address registry can infer it
 * automatically later (approach B).
 */
function internalTransfer(db: DB, ev: SubledgerEvent): { lines: JournalLine[] } {
  const fee = ev.fee_gas;
  if (!fee || Number(fee) <= 0) return { lines: [] }; // principal move only -> no entry
  const date = dateOf(ev.timestamp);
  const price = getPrice(db, ev.asset, date);
  if (!price) {
    throw new Error(`INTERNAL_TRANSFER: no PricePoint to value gas (${ev.asset} ${date})`);
  }
  const scale = QTY_SCALE[ev.asset];
  const fvFee = valueTwd(
    parseDecimal(fee, scale),
    scale,
    parseDecimal(price.price_usd, PRICE_SCALE),
    parseDecimal(price.usd_twd_rate, FX_SCALE),
  );
  // consume ONLY the fee quantity from lots; the principal (ev.qty) is untouched
  const { gross_twd, impairment_twd } = consumeLots(db, {
    disposal_event_id: ev.event_id,
    wallet_id: ev.wallet_id,
    asset: ev.asset,
    qty: fee,
    cost_flow: classify(db, ev.asset).cost_flow,
  });

  const toP = (v: Minor) => rescale(v, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE);
  const fvP = toP(fvFee);
  const grossP = toP(gross_twd);
  const impairmentP = toP(impairment_twd);
  const deltaP = fvP - (grossP - impairmentP);
  const tx = ev.tx_hash ?? null;

  const lines: JournalLine[] = [
    { dr_cr: "DR", account: "fee_expense", amount_twd: fmtP(fvP), tx_hash: tx, memo: "internal_transfer_gas" },
    { dr_cr: "CR", account: "digital_asset", amount_twd: fmtP(grossP), asset: ev.asset, qty: fee, tx_hash: tx },
  ];
  if (impairmentP > ZERO) lines.push({ dr_cr: "DR", account: "accum_impairment", amount_twd: fmtP(impairmentP), asset: ev.asset, tx_hash: tx });
  if (deltaP > ZERO) lines.push({ dr_cr: "CR", account: "disposal_gain", amount_twd: fmtP(deltaP), tx_hash: tx, memo: "disposal_leg" });
  else if (deltaP < ZERO) lines.push({ dr_cr: "DR", account: "disposal_loss", amount_twd: fmtP(-deltaP), tx_hash: tx, memo: "disposal_leg" });
  return { lines };
}

/**
 * RECEIVE_SETTLE_AR (§6/§7): a USD AR is settled by crypto received. Symmetric to
 * PAY_SUPPLIER. fx_leg revalues the (monetary) AR to the settlement rate; the
 * crypto received opens a new lot at fair value; the residual between that FV and
 * the settled value is a settlement gain/loss. Kept separate from the fx_leg.
 */
function receiveSettleAr(db: DB, ev: SubledgerEvent): { lines: JournalLine[] } {
  const date = dateOf(ev.timestamp);
  const price = getPrice(db, ev.asset, date)!;
  const rate = parseDecimal(price.usd_twd_rate, FX_SCALE);
  const ar = getMonetaryItem(db, ev.invoice_no!);
  if (!ar || ar.kind !== "AR" || !ar.open) {
    throw new Error(`RECEIVE_SETTLE_AR: no open AR for invoice ${ev.invoice_no}`);
  }

  const scale = QTY_SCALE[ev.asset];
  const cryptoFv = valueTwd(parseDecimal(ev.qty, scale), scale, parseDecimal(price.price_usd, PRICE_SCALE), rate);
  const arCarrying = parseDecimal(ar.carrying_twd, TWD_INTERNAL_SCALE);
  const arSettled = rescale(parseDecimal(ar.orig_amount, USD_SCALE) * rate, USD_SCALE + FX_SCALE, TWD_INTERNAL_SCALE);

  createLot(db, {
    event_id: ev.event_id,
    wallet_id: ev.wallet_id,
    asset: ev.asset,
    acquire_date: date,
    acquire_fx_rate: price.usd_twd_rate,
    qty: ev.qty,
    cost_twd: formatDecimal(cryptoFv, TWD_INTERNAL_SCALE),
  });
  updateMonetaryItem(db, ar.doc_no, formatDecimal(arSettled, TWD_INTERNAL_SCALE), false);

  const cryptoFvP = rescale(cryptoFv, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE);
  const arCarryingP = rescale(arCarrying, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE);
  const arSettledP = rescale(arSettled, TWD_INTERNAL_SCALE, TWD_POSTING_SCALE);
  const fxLegP = arSettledP - arCarryingP; // AR up = gain
  const settlementLegP = cryptoFvP - arSettledP;
  const tx = ev.tx_hash ?? null;

  const lines: JournalLine[] = [
    { dr_cr: "DR", account: "digital_asset", amount_twd: fmtP(cryptoFvP), asset: ev.asset, qty: ev.qty, tx_hash: tx },
    { dr_cr: "CR", account: "accounts_receivable", amount_twd: fmtP(arCarryingP), orig_ccy: ar.ccy, orig_amount: ar.orig_amount, tx_hash: tx, memo: ar.doc_no },
  ];
  if (fxLegP > ZERO) lines.push({ dr_cr: "CR", account: "fx_gain_loss", amount_twd: fmtP(fxLegP), tx_hash: tx, memo: "fx_leg" });
  else if (fxLegP < ZERO) lines.push({ dr_cr: "DR", account: "fx_gain_loss", amount_twd: fmtP(-fxLegP), tx_hash: tx, memo: "fx_leg" });
  if (settlementLegP > ZERO) lines.push({ dr_cr: "CR", account: "disposal_gain", amount_twd: fmtP(settlementLegP), tx_hash: tx, memo: "settlement_leg" });
  else if (settlementLegP < ZERO) lines.push({ dr_cr: "DR", account: "disposal_loss", amount_twd: fmtP(-settlementLegP), tx_hash: tx, memo: "settlement_leg" });
  return { lines };
}

/** PERIODEND_REVALUE dispatches by asset: crypto -> impairment; fiat -> monetary FX. */
function periodEnd(db: DB, ev: SubledgerEvent): { lines: JournalLine[] } {
  return getAssetConfig(db, ev.asset)
    ? periodEndRevalue(db, ev)
    : monetaryRetranslate(db, ev);
}

type Builder = (db: DB, ev: SubledgerEvent) => { lines: JournalLine[] };

const BUILDERS: Partial<Record<SubledgerEvent["type"], Builder>> = {
  BUY: acquire,
  ONRAMP: acquire,
  SELL: dispose,
  OFFRAMP: dispose,
  GAS: gas,
  INTERNAL_TRANSFER: internalTransfer,
  RECEIVE_NONCASH: receiveNoncash,
  PAY_SUPPLIER: paySupplier,
  RECEIVE_SETTLE_AR: receiveSettleAr,
  PERIODEND_REVALUE: periodEnd,
};

/**
 * INV-3 correction: a posted entry is never edited or deleted. To correct it,
 * post a reversing entry (DR/CR swapped) that references the original; both are
 * retained. The caller then ingests the new, correct event separately.
 */
export function reverseEntry(db: DB, jeId: string, period?: string): JournalEntry {
  const orig = getJournalEntries(db).find((e) => e.je_id === jeId);
  if (!orig) throw new Error(`subledger: no entry ${jeId} to reverse`);
  const rev: JournalEntry = {
    je_id: `${jeId}-rev`,
    event_id: orig.event_id,
    period: period ?? orig.period,
    status: "posted",
    gaap: orig.gaap,
    reverses: jeId,
    lines: orig.lines.map((l) => ({
      ...l,
      dr_cr: l.dr_cr === "DR" ? "CR" : "DR",
      memo: `reversal of ${jeId}`,
    })),
  };
  insertJournalEntry(db, rev);
  return rev;
}

export function ingest(db: DB, ev: SubledgerEvent): IngestResult {
  const v = validate(db, ev);
  if (!v.ok) {
    insertEvent(db, ev, "quarantined", v.reason);
    insertException(db, "rejected_event", ev.event_id, v.reason);
    return { posted: false, reason: v.reason };
  }

  const builder = BUILDERS[ev.type];
  if (!builder) {
    const reason = `no posting rule for ${ev.type}`;
    insertEvent(db, ev, "quarantined", reason);
    insertException(db, "rejected_event", ev.event_id, reason);
    return { posted: false, reason };
  }

  // The measure+post step runs in a single transaction: any failure (e.g.
  // insufficient lots, missing AP) rolls back every mutation so we never post
  // partially. The quarantine record is written afterwards, outside the rollback.
  const runPost = db.transaction((): IngestResult => {
    const { lines } = builder(db, ev);
    // A processed event with nothing to book (e.g. a period-end with no change)
    // is a legitimate no-op, not a quarantine.
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
  });

  try {
    return runPost();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    insertEvent(db, ev, "quarantined", reason);
    insertException(db, "rejected_event", ev.event_id, reason);
    return { posted: false, reason };
  }
}
