// scripts/subledger-demo.ts — headless driver for the crypto accounting
// subledger. Runs a fixture event stream end-to-end and writes every §9 output
// to data/subledger-demo/. Run with: bun run scripts/subledger-demo.ts
//
// Demonstrates the whole pipeline (classify -> cost -> measure -> post ->
// reconcile -> outputs) over a realistic month: treasury BTC/ETH buys, a FIFO
// disposal, gas, a cross-border AP settlement (fx_leg + disposal_leg), a
// period-end impairment, plus a quarantined event.

import fs from "node:fs";
import path from "node:path";

import {
  openTestSubledgerDb,
  insertPrice,
  insertMonetaryItem,
  ingest,
  runReconcile,
  journalRows,
  positions,
  pnlDetail,
  lotDisposals,
  reconciliationRows,
  exceptions,
  auditPack,
  disclosures,
  toCsv,
  type SubledgerEvent,
} from "../app/api/_lib/subledger";

const OUT_DIR = path.join(process.cwd(), "data", "subledger-demo");

function main() {
  const db = openTestSubledgerDb();

  // --- deterministic price + fx inputs ---
  insertPrice(db, { asset: "BTC", date: "2026-06-01", source: "demo", market: "Coinbase", price_usd: "60000", usd_twd_rate: "31.25" });
  insertPrice(db, { asset: "BTC", date: "2026-06-05", source: "demo", market: "Coinbase", price_usd: "62000", usd_twd_rate: "31.00" });
  insertPrice(db, { asset: "BTC", date: "2026-06-20", source: "demo", market: "Coinbase", price_usd: "55000", usd_twd_rate: "31.40" });
  insertPrice(db, { asset: "BTC", date: "2026-06-30", source: "demo", market: "Coinbase", price_usd: "50000", usd_twd_rate: "31.25" });
  insertPrice(db, { asset: "ETH", date: "2026-06-02", source: "demo", market: "Coinbase", price_usd: "3000", usd_twd_rate: "31.00" });
  insertPrice(db, { asset: "ETH", date: "2026-06-06", source: "demo", market: "Coinbase", price_usd: "3200", usd_twd_rate: "31.20" });

  // a pre-existing USD payable, booked at 31.00
  insertMonetaryItem(db, { doc_no: "BILL-1", kind: "AP", ccy: "USD", orig_amount: "30000", carrying_twd: "930000", open: true });

  const stream: SubledgerEvent[] = [
    { event_id: "buy-btc-1", type: "BUY", timestamp: "2026-06-01T10:00:00Z", wallet_id: "treasury", asset: "BTC", qty: "1" },
    { event_id: "buy-btc-2", type: "BUY", timestamp: "2026-06-05T10:00:00Z", wallet_id: "treasury", asset: "BTC", qty: "1" },
    { event_id: "buy-eth-1", type: "BUY", timestamp: "2026-06-02T10:00:00Z", wallet_id: "treasury", asset: "ETH", qty: "1" },
    { event_id: "sell-btc-1", type: "SELL", timestamp: "2026-06-10T10:00:00Z", wallet_id: "treasury", asset: "BTC", qty: "0.5", proceeds_twd: "1000000" },
    { event_id: "gas-eth-1", type: "GAS", timestamp: "2026-06-06T10:00:00Z", wallet_id: "treasury", asset: "ETH", qty: "0.01", tx_hash: "0xgas01" },
    { event_id: "pay-bill-1", type: "PAY_SUPPLIER", timestamp: "2026-06-20T10:00:00Z", wallet_id: "treasury", asset: "BTC", qty: "0.5", invoice_no: "BILL-1", tx_hash: "0xpay01" },
    { event_id: "period-end-btc", type: "PERIODEND_REVALUE", timestamp: "2026-06-30T23:59:59Z", wallet_id: "treasury", asset: "BTC", qty: "0" },
    // invalid: on-chain move with no tx_hash -> quarantined, never posted
    { event_id: "bad-offramp", type: "OFFRAMP", timestamp: "2026-06-11T10:00:00Z", wallet_id: "treasury", asset: "BTC", qty: "0.1", proceeds_twd: "200000" },
  ];

  let posted = 0;
  let quarantined = 0;
  for (const ev of stream) {
    const r = ingest(db, ev);
    if (r.posted) posted++;
    else if (r.reason !== "no measurable change") quarantined++;
  }

  // three-way reconciliation, as-of period end (chain provider = fixtures)
  const recon = runReconcile(db, "2026-06", { BTC: "1", ETH: "0.99" });

  // --- emit every §9 output ---
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const toRecord = (r: object): Record<string, string> =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.join("|") : v == null ? "" : String(v)]),
    );
  const writeCsv = (name: string, rows: object[]) =>
    fs.writeFileSync(path.join(OUT_DIR, name), toCsv(rows.map(toRecord)));
  const writeJson = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(value, null, 2));

  writeCsv("01_journal.csv", journalRows(db));
  writeCsv("02_positions.csv", positions(db));
  writeCsv("03_pnl_detail.csv", pnlDetail(db));
  writeCsv("04_lot_disposal.csv", lotDisposals(db));
  writeCsv("05_reconciliation.csv", reconciliationRows(db));
  writeJson("06_audit_pack.json", auditPack(db, "2026-06"));
  writeJson("08_disclosures.json", disclosures(db));
  writeCsv("09_exceptions.csv", exceptions(db));

  const tie = recon.every((r) => r.status === "tie");
  process.stdout.write(
    [
      "btech crypto accounting subledger — demo run",
      `  events: ${stream.length}  posted: ${posted}  quarantined: ${quarantined}`,
      `  three-way tie: ${tie ? "OK" : "BREAK"}  (${recon.map((r) => `${r.asset}:${r.status}`).join(", ")})`,
      `  outputs written to ${OUT_DIR}`,
      "",
    ].join("\n"),
  );
}

main();
