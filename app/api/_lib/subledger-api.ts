// subledger-api.ts — request->engine glue. Holds NO accounting logic; it only
// maps payloads to the engine's public functions (index.ts). Pure and testable;
// the route handlers add auth and (de)serialization around these.

import {
  ingest,
  runReconcile,
  insertPrice,
  journalRows,
  positions,
  pnlDetail,
  lotDisposals,
  reconciliationRows,
  exceptions,
  disclosures,
  auditPack,
  type DB,
  type SubledgerEvent,
  type PricePoint,
  type IngestResult,
} from "./subledger";

export function seedPrices(db: DB, prices: PricePoint[]): number {
  for (const p of prices) insertPrice(db, p);
  return prices.length;
}

export function ingestEvents(db: DB, events: SubledgerEvent[]): IngestResult[] {
  return events.map((e) => ingest(db, e));
}

export function getOutput(db: DB, kind: string, period?: string): unknown {
  switch (kind) {
    case "journal":
      return journalRows(db);
    case "positions":
      return positions(db);
    case "pnl":
      return pnlDetail(db);
    case "lot_disposal":
      return lotDisposals(db);
    case "reconciliation":
      return reconciliationRows(db);
    case "exceptions":
      return exceptions(db);
    case "disclosures":
      return disclosures(db);
    case "audit_pack":
      if (!period) throw new Error("audit_pack requires a ?period=YYYY-MM query parameter");
      return auditPack(db, period);
    default:
      throw new Error(`unknown output kind: ${kind}`);
  }
}

export function runPeriodReconcile(
  db: DB,
  period: string,
  chainBalances: Record<string, string>,
): unknown {
  return runReconcile(db, period, chainBalances);
}
