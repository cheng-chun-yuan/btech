// lots.ts — the subledger cost layer (§2, §9). Lots are mutable bookkeeping
// (remaining_qty shrinks as disposals consume them); the immutable trail is the
// sl_lot_consumption rows + the WORM journal. Disposal results are computed at
// LOT level per the configured cost flow (INV-9).

import {
  parseDecimal,
  formatDecimal,
  mulDivRound,
  QTY_SCALE,
  TWD_INTERNAL_SCALE,
  type Minor,
} from "./money";
import type { DB } from "./store";
import type { CostFlow, Lot } from "./types";

const ZERO = BigInt(0);

function qtyScaleOf(asset: string): number {
  const s = QTY_SCALE[asset];
  if (s === undefined) throw new Error(`subledger: no QTY_SCALE for ${asset}`);
  return s;
}

export interface CreateLotInput {
  event_id: string;
  wallet_id: string;
  asset: string;
  acquire_date: string;
  acquire_fx_rate: string;
  qty: string;
  /** Total original cost basis in TWD (decimal string, internal scale). */
  cost_twd: string;
}

let lotSeq = 0;
let consSeq = 0;

/** One acquisition -> one lot (lot_id = event_id). remaining_* start full. */
export function createLot(db: DB, input: CreateLotInput): void {
  const scale = qtyScaleOf(input.asset);
  const qty = formatDecimal(parseDecimal(input.qty, scale), scale);
  const cost = formatDecimal(parseDecimal(input.cost_twd, TWD_INTERNAL_SCALE), TWD_INTERNAL_SCALE);
  db.prepare(
    `INSERT INTO sl_lot
       (lot_id, wallet_id, asset, acquire_date, acquire_fx_rate,
        qty, remaining_qty, cost_twd, remaining_cost_twd, accum_impairment_twd, created_at)
     VALUES (@lot_id, @wallet_id, @asset, @acquire_date, @acquire_fx_rate,
             @qty, @remaining_qty, @cost_twd, @remaining_cost_twd, '0', @created_at)`,
  ).run({
    lot_id: input.event_id,
    wallet_id: input.wallet_id,
    asset: input.asset,
    acquire_date: input.acquire_date,
    acquire_fx_rate: input.acquire_fx_rate,
    qty,
    remaining_qty: qty,
    cost_twd: cost,
    remaining_cost_twd: cost,
    created_at: ++lotSeq,
  });
}

interface LotRow {
  lot_id: string;
  wallet_id: string;
  asset: string;
  acquire_date: string;
  acquire_fx_rate: string;
  qty: string;
  remaining_qty: string;
  cost_twd: string;
  remaining_cost_twd: string;
  accum_impairment_twd: string;
}

export function getLot(db: DB, lotId: string): Lot | undefined {
  const row = db.prepare("SELECT * FROM sl_lot WHERE lot_id=?").get(lotId) as LotRow | undefined;
  return row ? { ...row } : undefined;
}

/** Open lots (remaining_qty > 0) for a wallet+asset, oldest first. */
export function getOpenLots(db: DB, walletId: string, asset: string): Lot[] {
  const scale = qtyScaleOf(asset);
  const rows = db
    .prepare("SELECT * FROM sl_lot WHERE wallet_id=? AND asset=? ORDER BY created_at ASC")
    .all(walletId, asset) as LotRow[];
  return rows.filter((r) => parseDecimal(r.remaining_qty, scale) > ZERO).map((r) => ({ ...r }));
}

/** Set a lot's accumulated impairment (period-end measurement). */
export function updateAccumImpairment(db: DB, lotId: string, accumImpairmentTwd: string): void {
  db.prepare("UPDATE sl_lot SET accum_impairment_twd=? WHERE lot_id=?").run(accumImpairmentTwd, lotId);
}

export interface ConsumedLot {
  lot_id: string;
  qty: string;
  carrying_twd: string;
}

export interface ConsumeResult {
  consumed: ConsumedLot[];
  /** Total carrying (net of impairment) of the consumed quantity, internal scale. */
  carrying_twd: Minor;
}

export interface ConsumeInput {
  disposal_event_id: string;
  wallet_id: string;
  asset: string;
  qty: string;
  cost_flow: CostFlow;
}

/** Consume `qty` from open lots per cost flow; returns per-lot + total carrying. */
export function consumeLots(db: DB, input: ConsumeInput): ConsumeResult {
  if (input.cost_flow !== "FIFO") {
    throw new Error(`cost_flow ${input.cost_flow} not yet implemented`);
  }
  const scale = qtyScaleOf(input.asset);
  let need = parseDecimal(input.qty, scale);

  const rows = db
    .prepare("SELECT * FROM sl_lot WHERE wallet_id=? AND asset=? ORDER BY created_at ASC")
    .all(input.wallet_id, input.asset) as LotRow[];

  const consumed: ConsumedLot[] = [];
  let carrying = ZERO;
  const updateLot = db.prepare(
    "UPDATE sl_lot SET remaining_qty=?, remaining_cost_twd=?, accum_impairment_twd=? WHERE lot_id=?",
  );
  const insCons = db.prepare(
    `INSERT INTO sl_lot_consumption (disposal_event_id, lot_id, qty, carrying_twd, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (need <= ZERO) break;
      const remaining = parseDecimal(row.remaining_qty, scale);
      if (remaining <= ZERO) continue;

      const take = remaining < need ? remaining : need;
      const remainingCost = parseDecimal(row.remaining_cost_twd, TWD_INTERNAL_SCALE);
      const accumImp = parseDecimal(row.accum_impairment_twd, TWD_INTERNAL_SCALE);
      // Allocate the lot's remaining cost AND its accumulated impairment
      // proportionally. carrying = cost portion net of impairment portion. When
      // take == remaining (last slice), each returns the exact residual: no
      // drift, so subledger basis == GL credit (INV-4).
      const costPortion = mulDivRound(remainingCost, take, remaining);
      const impPortion = mulDivRound(accumImp, take, remaining);
      const carryNet = costPortion - impPortion;
      carrying += carryNet;

      const takeStr = formatDecimal(take, scale);
      const carryStr = formatDecimal(carryNet, TWD_INTERNAL_SCALE);
      updateLot.run(
        formatDecimal(remaining - take, scale),
        formatDecimal(remainingCost - costPortion, TWD_INTERNAL_SCALE),
        formatDecimal(accumImp - impPortion, TWD_INTERNAL_SCALE),
        row.lot_id,
      );
      insCons.run(input.disposal_event_id, row.lot_id, takeStr, carryStr, ++consSeq);
      consumed.push({ lot_id: row.lot_id, qty: takeStr, carrying_twd: carryStr });
      need -= take;
    }
    if (need > ZERO) {
      throw new Error(
        `insufficient lots for ${input.asset}: short by ${formatDecimal(need, scale)}`,
      );
    }
  });
  tx();

  return { consumed, carrying_twd: carrying };
}
