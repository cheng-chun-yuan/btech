// outputs.ts — §9 reports. v1 (M1) implements ① journal, ② positions, and
// ④ lot_disposal as structured rows; CSV is a thin serialization on top.
// Later milestones add ③ pnl_detail, ⑤ reconciliation, ⑥ audit_pack, ⑧/⑨.

import {
  parseDecimal,
  formatDecimal,
  mulDivRound,
  QTY_SCALE,
  TWD_INTERNAL_SCALE,
  type Minor,
} from "./money";
import { getJournalEntries, type DB } from "./store";
import { classify } from "./classify";
import { DEFAULT_COA_CODES } from "./types";

const ZERO = BigInt(0);

// ---- ① journal_csv ---------------------------------------------------------

export interface JournalRow {
  date: string;
  je_no: string;
  dr_cr: string;
  coa_code: string;
  amount_twd: string;
  orig_ccy: string;
  orig_amount: string;
  qty: string;
  asset: string;
  wallet: string;
  counterparty: string;
  invoice_no: string;
  tx_hash: string;
  event_id: string;
  gaap: string;
  memo: string;
}

interface EventMetaRow {
  timestamp: string;
  wallet_id: string;
  counterparty: string | null;
  invoice_no: string | null;
}

export function journalRows(db: DB): JournalRow[] {
  const getEvent = db.prepare(
    "SELECT timestamp, wallet_id, counterparty, invoice_no FROM sl_event WHERE event_id=?",
  );
  const rows: JournalRow[] = [];
  for (const e of getJournalEntries(db)) {
    const meta = getEvent.get(e.event_id) as EventMetaRow | undefined;
    for (const l of e.lines) {
      rows.push({
        date: (meta?.timestamp ?? "").slice(0, 10),
        je_no: e.je_id,
        dr_cr: l.dr_cr,
        coa_code: DEFAULT_COA_CODES[l.account],
        amount_twd: l.amount_twd,
        orig_ccy: l.orig_ccy ?? "",
        orig_amount: l.orig_amount ?? "",
        qty: l.qty ?? "",
        asset: l.asset ?? "",
        wallet: meta?.wallet_id ?? "",
        counterparty: meta?.counterparty ?? "",
        invoice_no: meta?.invoice_no ?? "",
        tx_hash: l.tx_hash ?? "",
        event_id: e.event_id,
        gaap: e.gaap,
        memo: l.memo ?? "",
      });
    }
  }
  return rows;
}

// ---- ② positions -----------------------------------------------------------

export interface PositionRow {
  wallet: string;
  asset: string;
  lot_id: string;
  remaining_qty: string;
  unit_cost: string;
  carrying_twd: string;
  fv_twd: string;
  unrealized: string;
  realized_ptd: string;
}

interface LotRow {
  lot_id: string;
  wallet_id: string;
  asset: string;
  qty: string;
  remaining_qty: string;
  cost_twd: string;
  remaining_cost_twd: string;
}

export function positions(db: DB): PositionRow[] {
  const lots = db.prepare("SELECT * FROM sl_lot ORDER BY created_at ASC").all() as LotRow[];
  const out: PositionRow[] = [];
  for (const lot of lots) {
    const scale = QTY_SCALE[lot.asset];
    const remainingMinor = parseDecimal(lot.remaining_qty, scale);
    if (remainingMinor <= ZERO) continue; // open lots only

    const qtyMinor = parseDecimal(lot.qty, scale);
    const costMinor = parseDecimal(lot.cost_twd, TWD_INTERNAL_SCALE);
    const unitCost = mulDivRound(costMinor, BigInt(10) ** BigInt(scale), qtyMinor);
    out.push({
      wallet: lot.wallet_id,
      asset: lot.asset,
      lot_id: lot.lot_id,
      remaining_qty: lot.remaining_qty,
      unit_cost: formatDecimal(unitCost, TWD_INTERNAL_SCALE),
      carrying_twd: lot.remaining_cost_twd,
      fv_twd: "", // M2 (period-end FV)
      unrealized: "",
      realized_ptd: "",
    });
  }
  return out;
}

// ---- ④ lot_disposal --------------------------------------------------------

export interface DisposalRow {
  disposal_event: string;
  consumed_lots: string[];
  proceeds: string;
  carrying: string;
  gain_loss: string;
  cost_flow: string;
}

interface ConsRow {
  disposal_event_id: string;
  lot_id: string;
  carrying_twd: string;
}

export function lotDisposals(db: DB): DisposalRow[] {
  const cons = db
    .prepare("SELECT disposal_event_id, lot_id, carrying_twd FROM sl_lot_consumption ORDER BY id ASC")
    .all() as ConsRow[];
  const getEvent = db.prepare("SELECT asset, proceeds_twd FROM sl_event WHERE event_id=?");

  const byEvent = new Map<string, { lots: string[]; carrying: Minor }>();
  for (const c of cons) {
    const agg = byEvent.get(c.disposal_event_id) ?? { lots: [], carrying: ZERO };
    agg.lots.push(c.lot_id);
    agg.carrying += parseDecimal(c.carrying_twd, TWD_INTERNAL_SCALE);
    byEvent.set(c.disposal_event_id, agg);
  }

  const out: DisposalRow[] = [];
  for (const [eventId, agg] of byEvent) {
    const ev = getEvent.get(eventId) as { asset: string; proceeds_twd: string | null } | undefined;
    const proceeds = parseDecimal(ev?.proceeds_twd ?? "0", TWD_INTERNAL_SCALE);
    out.push({
      disposal_event: eventId,
      consumed_lots: agg.lots,
      proceeds: formatDecimal(proceeds, TWD_INTERNAL_SCALE),
      carrying: formatDecimal(agg.carrying, TWD_INTERNAL_SCALE),
      gain_loss: formatDecimal(proceeds - agg.carrying, TWD_INTERNAL_SCALE),
      cost_flow: ev ? classify(db, ev.asset).cost_flow : "FIFO",
    });
  }
  return out;
}

// ---- CSV serialization -----------------------------------------------------

/** Serialize rows of flat string records to RFC-4180-ish CSV. */
export function toCsv(rows: Record<string, string>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => esc(row[h] ?? "")).join(","));
  return lines.join("\n");
}
