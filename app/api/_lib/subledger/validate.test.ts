import { describe, it, expect } from "vitest";

import { validate } from "./validate";
import { openTestSubledgerDb, insertPrice } from "./store";
import type { SubledgerEvent } from "./types";

function dbWithBtcPrice() {
  const db = openTestSubledgerDb();
  insertPrice(db, {
    asset: "BTC",
    date: "2026-06-01",
    source: "test",
    market: "Coinbase",
    price_usd: "65000",
    usd_twd_rate: "31.25",
  });
  return db;
}

const buy: SubledgerEvent = {
  event_id: "ev1",
  type: "BUY",
  timestamp: "2026-06-01T10:00:00Z",
  wallet_id: "w",
  asset: "BTC",
  qty: "1",
};

describe("validate (§8, INV-10)", () => {
  it("accepts a well-formed acquisition with an available price", () => {
    expect(validate(dbWithBtcPrice(), buy).ok).toBe(true);
  });

  it("rejects missing timestamp, asset, or non-positive qty", () => {
    const db = dbWithBtcPrice();
    expect(validate(db, { ...buy, timestamp: "" }).ok).toBe(false);
    expect(validate(db, { ...buy, asset: "" }).ok).toBe(false);
    expect(validate(db, { ...buy, qty: "0" }).ok).toBe(false);
    expect(validate(db, { ...buy, qty: "-1" }).ok).toBe(false);
  });

  it("rejects an on-chain move with no tx_hash", () => {
    const db = dbWithBtcPrice();
    const offramp: SubledgerEvent = {
      event_id: "ev2",
      type: "OFFRAMP",
      timestamp: "2026-06-01T10:00:00Z",
      wallet_id: "w",
      asset: "BTC",
      qty: "1",
      proceeds_twd: "2100000",
    };
    expect(validate(db, offramp).ok).toBe(false);
    expect(validate(db, { ...offramp, tx_hash: "deadbeef" }).ok).toBe(true);
  });

  it("rejects an AR/AP-linked event with no invoice_no", () => {
    const db = dbWithBtcPrice();
    const settle: SubledgerEvent = {
      event_id: "ev3",
      type: "RECEIVE_SETTLE_AR",
      timestamp: "2026-06-01T10:00:00Z",
      wallet_id: "w",
      asset: "BTC",
      qty: "1",
      tx_hash: "abc",
    };
    expect(validate(db, settle).ok).toBe(false);
    expect(validate(db, { ...settle, invoice_no: "INV-1" }).ok).toBe(true);
  });

  it("rejects when no PricePoint exists for a date the rule needs", () => {
    const db = openTestSubledgerDb(); // no price seeded
    const r = validate(db, buy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/price/i);
  });

  it("accepts PERIODEND_REVALUE with no qty move (operates on existing lots)", () => {
    const db = openTestSubledgerDb();
    insertPrice(db, {
      asset: "BTC",
      date: "2026-06-30",
      source: "test",
      market: "Coinbase",
      price_usd: "50000",
      usd_twd_rate: "31.25",
    });
    const pe: SubledgerEvent = {
      event_id: "pe1",
      type: "PERIODEND_REVALUE",
      timestamp: "2026-06-30T23:59:59Z",
      wallet_id: "w",
      asset: "BTC",
      qty: "0",
    };
    expect(validate(db, pe).ok).toBe(true);
  });
});
