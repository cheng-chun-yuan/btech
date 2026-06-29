// store.ts — sl_* persistence for the subledger. Owns its own schema/migration
// block (never touches treasury tables) and enforces WORM (INV-3) at the SQLite
// layer via triggers. Reuses the shared better-sqlite3 handle in production.

import Database from "better-sqlite3";

import {
  DEFAULT_ASSET_CONFIGS,
  DEFAULT_POLICY,
  type AssetConfig,
  type JournalEntry,
  type PolicyParam,
} from "./types";

export type DB = Database.Database;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sl_config (
    asset TEXT PRIMARY KEY,
    classification TEXT NOT NULL,
    measurement TEXT NOT NULL,
    monetary INTEGER NOT NULL,
    redeemable_unconditional INTEGER NOT NULL,
    cost_flow TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sl_policy (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sl_event (
    event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    qty TEXT NOT NULL,
    counterparty TEXT,
    invoice_no TEXT,
    tx_hash TEXT,
    fee_gas TEXT,
    proceeds_twd TEXT,
    settle_amount_usd TEXT,
    status TEXT NOT NULL,
    reject_reason TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sl_lot (
    lot_id TEXT PRIMARY KEY,
    wallet_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    acquire_date TEXT NOT NULL,
    acquire_fx_rate TEXT NOT NULL,
    qty TEXT NOT NULL,
    remaining_qty TEXT NOT NULL,
    unit_cost_twd TEXT NOT NULL,
    accum_impairment_twd TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sl_lot_consumption (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    disposal_event_id TEXT NOT NULL,
    lot_id TEXT NOT NULL,
    qty TEXT NOT NULL,
    carrying_twd TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sl_journal_entry (
    je_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    period TEXT NOT NULL,
    status TEXT NOT NULL,
    gaap TEXT NOT NULL,
    reverses TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sl_journal_line (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    je_id TEXT NOT NULL,
    dr_cr TEXT NOT NULL,
    account TEXT NOT NULL,
    amount_twd TEXT NOT NULL,
    asset TEXT,
    qty TEXT,
    orig_ccy TEXT,
    orig_amount TEXT,
    tx_hash TEXT,
    memo TEXT
  );

  CREATE TABLE IF NOT EXISTS sl_monetary_item (
    doc_no TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ccy TEXT NOT NULL,
    orig_amount TEXT NOT NULL,
    carrying_twd TEXT NOT NULL,
    open INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sl_price (
    asset TEXT NOT NULL,
    date TEXT NOT NULL,
    source TEXT NOT NULL,
    market TEXT NOT NULL,
    price_usd TEXT NOT NULL,
    usd_twd_rate TEXT NOT NULL,
    PRIMARY KEY (asset, date)
  );

  CREATE TABLE IF NOT EXISTS sl_reconciliation (
    period TEXT NOT NULL,
    asset TEXT NOT NULL,
    layer TEXT NOT NULL,
    balance TEXT NOT NULL,
    diff TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (period, asset, layer)
  );

  CREATE TABLE IF NOT EXISTS sl_exception (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    ref TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
`;

// WORM (INV-3): journals are append-only. Corrections are a reversing entry plus
// a new correct entry — both retained — never an in-place edit or delete.
const WORM_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS sl_je_no_update BEFORE UPDATE ON sl_journal_entry
    BEGIN SELECT RAISE(ABORT, 'WORM: sl_journal_entry is append-only (INV-3)'); END;
  CREATE TRIGGER IF NOT EXISTS sl_je_no_delete BEFORE DELETE ON sl_journal_entry
    BEGIN SELECT RAISE(ABORT, 'WORM: sl_journal_entry is append-only (INV-3)'); END;
  CREATE TRIGGER IF NOT EXISTS sl_jl_no_update BEFORE UPDATE ON sl_journal_line
    BEGIN SELECT RAISE(ABORT, 'WORM: sl_journal_line is append-only (INV-3)'); END;
  CREATE TRIGGER IF NOT EXISTS sl_jl_no_delete BEFORE DELETE ON sl_journal_line
    BEGIN SELECT RAISE(ABORT, 'WORM: sl_journal_line is append-only (INV-3)'); END;
`;

export function migrateSubledger(db: DB): void {
  db.exec(SCHEMA);
  db.exec(WORM_TRIGGERS);
}

export function seedConfig(db: DB): void {
  const insConfig = db.prepare(
    `INSERT OR IGNORE INTO sl_config
       (asset, classification, measurement, monetary, redeemable_unconditional, cost_flow)
     VALUES (@asset, @classification, @measurement, @monetary, @redeemable, @cost_flow)`,
  );
  const insPolicy = db.prepare(
    "INSERT OR IGNORE INTO sl_policy (key, value, status) VALUES (@key, @value, @status)",
  );
  const tx = db.transaction(() => {
    for (const c of DEFAULT_ASSET_CONFIGS) {
      insConfig.run({
        asset: c.asset,
        classification: c.classification,
        measurement: c.measurement,
        monetary: c.monetary ? 1 : 0,
        redeemable: c.redeemable_unconditional ? 1 : 0,
        cost_flow: c.cost_flow,
      });
    }
    for (const p of DEFAULT_POLICY) insPolicy.run(p);
  });
  tx();
}

export function getAssetConfig(db: DB, asset: string): AssetConfig | undefined {
  const row = db.prepare("SELECT * FROM sl_config WHERE asset=?").get(asset) as
    | {
        asset: string;
        classification: AssetConfig["classification"];
        measurement: AssetConfig["measurement"];
        monetary: number;
        redeemable_unconditional: number;
        cost_flow: AssetConfig["cost_flow"];
      }
    | undefined;
  if (!row) return undefined;
  return {
    asset: row.asset,
    classification: row.classification,
    measurement: row.measurement,
    monetary: row.monetary === 1,
    redeemable_unconditional: row.redeemable_unconditional === 1,
    cost_flow: row.cost_flow,
  };
}

export function getPolicy(db: DB, key: string): PolicyParam | undefined {
  return db.prepare("SELECT key, value, status FROM sl_policy WHERE key=?").get(key) as
    | PolicyParam
    | undefined;
}

let jeSeq = 0;

export function insertJournalEntry(db: DB, entry: JournalEntry): void {
  const insJe = db.prepare(
    `INSERT INTO sl_journal_entry (je_id, event_id, period, status, gaap, reverses, created_at)
     VALUES (@je_id, @event_id, @period, @status, @gaap, @reverses, @created_at)`,
  );
  const insLine = db.prepare(
    `INSERT INTO sl_journal_line
       (je_id, dr_cr, account, amount_twd, asset, qty, orig_ccy, orig_amount, tx_hash, memo)
     VALUES (@je_id, @dr_cr, @account, @amount_twd, @asset, @qty, @orig_ccy, @orig_amount, @tx_hash, @memo)`,
  );
  const tx = db.transaction(() => {
    insJe.run({
      je_id: entry.je_id,
      event_id: entry.event_id,
      period: entry.period,
      status: entry.status,
      gaap: entry.gaap,
      reverses: entry.reverses ?? null,
      created_at: ++jeSeq,
    });
    for (const l of entry.lines) {
      insLine.run({
        je_id: entry.je_id,
        dr_cr: l.dr_cr,
        account: l.account,
        amount_twd: l.amount_twd,
        asset: l.asset ?? null,
        qty: l.qty ?? null,
        orig_ccy: l.orig_ccy ?? null,
        orig_amount: l.orig_amount ?? null,
        tx_hash: l.tx_hash ?? null,
        memo: l.memo ?? null,
      });
    }
  });
  tx();
}

/** In-memory subledger DB for tests: migrated + config-seeded. */
export function openTestSubledgerDb(): DB {
  const db = new Database(":memory:");
  migrateSubledger(db);
  seedConfig(db);
  return db;
}
