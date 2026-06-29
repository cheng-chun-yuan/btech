// reconcile.ts — INV-4 three-way tie, per asset, as-of a period.
//
//   chain_qty (injected provider) == subledger_qty (Σ remaining lot qty)
//   subledger_twd (Σ remaining cost - accum_impairment) == gl_twd (digital_asset
//     net debit - accum_impairment net credit)
//
// A mismatch in either dimension is a reconciliation break: recorded, surfaced
// as an exception, and NEVER auto-fixed.

import {
  parseDecimal,
  formatDecimal,
  QTY_SCALE,
  TWD_INTERNAL_SCALE,
  type Minor,
} from "./money";
import { insertException, type DB } from "./store";

const ZERO = BigInt(0);

export interface ReconResult {
  period: string;
  asset: string;
  chain_qty: string;
  subledger_qty: string;
  qty_diff: string;
  subledger_twd: string;
  gl_twd: string;
  value_diff: string;
  status: "tie" | "break";
}

interface LotRow {
  remaining_qty: string;
  remaining_cost_twd: string;
  accum_impairment_twd: string;
}
interface LineRow {
  account: string;
  dr_cr: "DR" | "CR";
  amount_twd: string;
}

/** GL carrying for an asset = digital_asset net debit - accum_impairment net credit. */
function glCarrying(db: DB, asset: string): Minor {
  const rows = db
    .prepare(
      "SELECT account, dr_cr, amount_twd FROM sl_journal_line WHERE asset=? AND account IN ('digital_asset','accum_impairment')",
    )
    .all(asset) as LineRow[];
  let digitalAsset = ZERO; // net debit
  let accumImpairment = ZERO; // net credit
  for (const r of rows) {
    const amt = parseDecimal(r.amount_twd, TWD_INTERNAL_SCALE); // posting<=internal, widening exact
    if (r.account === "digital_asset") digitalAsset += r.dr_cr === "DR" ? amt : -amt;
    else accumImpairment += r.dr_cr === "CR" ? amt : -amt;
  }
  return digitalAsset - accumImpairment;
}

export function runReconcile(
  db: DB,
  period: string,
  chainBalances: Record<string, string>,
): ReconResult[] {
  const lotAssets = (db.prepare("SELECT DISTINCT asset FROM sl_lot").all() as { asset: string }[]).map((r) => r.asset);
  const assets = Array.from(new Set([...lotAssets, ...Object.keys(chainBalances)]));

  const insRecon = db.prepare(
    `INSERT OR REPLACE INTO sl_reconciliation (period, asset, layer, balance, diff, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const results: ReconResult[] = [];
  for (const asset of assets) {
    const scale = QTY_SCALE[asset] ?? TWD_INTERNAL_SCALE;
    const lots = db.prepare("SELECT remaining_qty, remaining_cost_twd, accum_impairment_twd FROM sl_lot WHERE asset=?").all(asset) as LotRow[];

    let subQty = ZERO;
    let subTwd = ZERO;
    for (const l of lots) {
      subQty += parseDecimal(l.remaining_qty, scale);
      subTwd += parseDecimal(l.remaining_cost_twd, TWD_INTERNAL_SCALE) - parseDecimal(l.accum_impairment_twd, TWD_INTERNAL_SCALE);
    }
    const chainQty = parseDecimal(chainBalances[asset] ?? "0", scale);
    const glTwd = glCarrying(db, asset);

    const qtyDiff = subQty - chainQty;
    const valueDiff = subTwd - glTwd;
    const status: "tie" | "break" = qtyDiff === ZERO && valueDiff === ZERO ? "tie" : "break";

    const res: ReconResult = {
      period,
      asset,
      chain_qty: formatDecimal(chainQty, scale),
      subledger_qty: formatDecimal(subQty, scale),
      qty_diff: formatDecimal(qtyDiff, scale),
      subledger_twd: formatDecimal(subTwd, TWD_INTERNAL_SCALE),
      gl_twd: formatDecimal(glTwd, TWD_INTERNAL_SCALE),
      value_diff: formatDecimal(valueDiff, TWD_INTERNAL_SCALE),
      status,
    };
    results.push(res);

    insRecon.run(period, asset, "CHAIN", res.chain_qty, res.qty_diff, status);
    insRecon.run(period, asset, "SUBLEDGER", res.subledger_qty, res.value_diff, status);
    insRecon.run(period, asset, "GL", res.gl_twd, res.value_diff, status);
    if (status === "break") {
      insertException(
        db,
        "recon_break",
        asset,
        `${period} ${asset}: qty_diff=${res.qty_diff} value_diff=${res.value_diff} (chain ${res.chain_qty} vs subledger ${res.subledger_qty}; gl ${res.gl_twd} vs subledger ${res.subledger_twd})`,
      );
    }
  }
  return results;
}
