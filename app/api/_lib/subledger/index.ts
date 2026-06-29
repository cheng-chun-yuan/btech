// index.ts — public surface of the crypto accounting subledger.
//
// Ingest events, then read the §9 outputs. The engine is pure and headless; it
// reaches the outside world only through the `SubledgerEvent` contract and the
// injected PricePoint / config data in the sl_* store.

export { ingest, type IngestResult } from "./engine";
export {
  migrateSubledger,
  seedConfig,
  insertPrice,
  getJournalEntries,
  openTestSubledgerDb,
  type DB,
} from "./store";
export { classify } from "./classify";
export { validate, type ValidationResult } from "./validate";
export {
  journalRows,
  positions,
  lotDisposals,
  toCsv,
  type JournalRow,
  type PositionRow,
  type DisposalRow,
} from "./outputs";
export * from "./types";
