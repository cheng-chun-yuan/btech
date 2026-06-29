// outputs.ts — §9 reports. v1 (M1) implements ① journal, ② positions, and
// ④ lot_disposal as structured rows; CSV is a thin serialization on top.
// Later milestones add ③ pnl_detail, ⑤ reconciliation, ⑥ audit_pack, ⑧/⑨.

import {
  parseDecimal,
  formatDecimal,
  rescale,
  mulDivRound,
  QTY_SCALE,
  TWD_INTERNAL_SCALE,
  TWD_POSTING_SCALE,
  type Minor,
} from "./money";
import { getJournalEntries, type DB } from "./store";
import { classify } from "./classify";
import { DEFAULT_COA_CODES, type CoaKey } from "./types";

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

// ---- ③ pnl_detail ----------------------------------------------------------

export interface PnlRow {
  period: string;
  asset: string;
  type: "disposal" | "impairment" | "reversal" | "fx" | "settlement" | "reval";
  amount: string; // signed, internal scale (gain +, loss/impairment -)
  op_noop: "op" | "non-op";
  event_id: string;
}

// P&L accounts -> result type + operating classification. op/non-op is a policy
// default (configurable); gains are CR-positive, losses DR-negative.
const PNL_MAP: Partial<Record<CoaKey, { type: PnlRow["type"]; op: PnlRow["op_noop"] }>> = {
  disposal_gain: { type: "disposal", op: "non-op" },
  disposal_loss: { type: "disposal", op: "non-op" },
  impairment_loss: { type: "impairment", op: "op" },
  impairment_reversal_gain: { type: "reversal", op: "op" },
  fx_gain_loss: { type: "fx", op: "non-op" },
};

export function pnlDetail(db: DB): PnlRow[] {
  const getAsset = db.prepare("SELECT asset FROM sl_event WHERE event_id=?");
  const out: PnlRow[] = [];
  for (const e of getJournalEntries(db)) {
    const evAsset = (getAsset.get(e.event_id) as { asset: string } | undefined)?.asset ?? "";
    for (const l of e.lines) {
      const map = PNL_MAP[l.account];
      if (!map) continue;
      const magnitude = rescale(parseDecimal(l.amount_twd, TWD_POSTING_SCALE), TWD_POSTING_SCALE, TWD_INTERNAL_SCALE);
      const signed = l.dr_cr === "CR" ? magnitude : -magnitude; // CR gain +, DR loss -
      out.push({
        period: e.period,
        asset: l.asset ?? evAsset,
        type: map.type,
        amount: formatDecimal(signed, TWD_INTERNAL_SCALE),
        op_noop: map.op,
        event_id: e.event_id,
      });
    }
  }
  return out;
}

// ---- ⑤ reconciliation ------------------------------------------------------

export interface ReconciliationRowOut {
  period: string;
  asset: string;
  layer: string;
  balance: string;
  diff: string;
  status: string;
}

export function reconciliationRows(db: DB): ReconciliationRowOut[] {
  return db
    .prepare("SELECT period, asset, layer, balance, diff, status FROM sl_reconciliation ORDER BY period, asset, layer")
    .all() as ReconciliationRowOut[];
}

// ---- ⑨ exceptions ----------------------------------------------------------

export interface ExceptionRow {
  kind: string;
  ref: string | null;
  detail: string;
}

export function exceptions(db: DB): ExceptionRow[] {
  return db
    .prepare("SELECT kind, ref, detail FROM sl_exception ORDER BY id ASC")
    .all() as ExceptionRow[];
}

// ---- ⑧ disclosures ---------------------------------------------------------

export interface Disclosures {
  holdings: PositionRow[];
  policy: { key: string; value: string; status: string }[];
  fx_lock_note: string;
}

export function disclosures(db: DB): Disclosures {
  const policy = db.prepare("SELECT key, value, status FROM sl_policy ORDER BY key").all() as {
    key: string;
    value: string;
    status: string;
  }[];
  return {
    holdings: positions(db),
    policy,
    fx_lock_note:
      "Crypto under IAS 38 is non-monetary: carrying is locked at the acquisition-date " +
      "fx rate and is not retranslated at period end. Monetary USD AR/AP are retranslated " +
      "at the closing rate (INV-7).",
  };
}

// ---- ⑥ audit_pack ----------------------------------------------------------

export interface AuditPack {
  period: string;
  policy_version: string;
  journal: JournalRow[];
  reconciliation: ReconciliationRowOut[];
  lot_disposals: DisposalRow[];
  tx_hash_index: Record<string, string[]>;
  exceptions: ExceptionRow[];
  immutable_log: { je_id: string; event_id: string; period: string }[];
}

export function auditPack(db: DB, period: string): AuditPack {
  const policyVersion =
    (db.prepare("SELECT value FROM sl_policy WHERE key='policy_version'").get() as { value: string } | undefined)?.value ?? "";
  const journal = journalRows(db).filter((r) => r.date.startsWith(period));

  // tx_hash -> event_ids that touched it
  const txIndex: Record<string, string[]> = {};
  for (const row of journal) {
    if (!row.tx_hash) continue;
    (txIndex[row.tx_hash] ??= []).push(row.event_id);
  }
  for (const k of Object.keys(txIndex)) txIndex[k] = Array.from(new Set(txIndex[k]));

  const immutable = getJournalEntries(db)
    .filter((e) => e.period === period)
    .map((e) => ({ je_id: e.je_id, event_id: e.event_id, period: e.period }));

  return {
    period,
    policy_version: policyVersion,
    journal,
    reconciliation: reconciliationRows(db).filter((r) => r.period === period),
    lot_disposals: lotDisposals(db),
    tx_hash_index: txIndex,
    exceptions: exceptions(db),
    immutable_log: immutable,
  };
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
