import { describe, it, expect } from "vitest";

import { classify } from "./classify";
import { openTestSubledgerDb } from "./store";

describe("classify (§4)", () => {
  it("treats no-issuer crypto as IAS38, cost model, non-monetary", () => {
    const db = openTestSubledgerDb();
    const c = classify(db, "BTC");
    expect(c.classification).toBe("INTANGIBLE_IAS38");
    expect(c.measurement).toBe("COST_MODEL");
    expect(c.monetary).toBe(false);
  });

  it("treats current stablecoins (redeemable_unconditional=false) as IAS38", () => {
    const db = openTestSubledgerDb();
    const c = classify(db, "USDC");
    expect(c.classification).toBe("INTANGIBLE_IAS38");
    expect(c.monetary).toBe(false);
  });

  it("switches a stablecoin to FVTPL when redeemable_unconditional flips — config only (INV-5)", () => {
    const db = openTestSubledgerDb();
    db.prepare("UPDATE sl_config SET redeemable_unconditional=1 WHERE asset=?").run("USDC");
    const c = classify(db, "USDC");
    expect(c.classification).toBe("FINANCIAL_FVTPL");
    expect(c.measurement).toBe("FVTPL");
    expect(c.monetary).toBe(true);
  });

  it("throws for an unconfigured asset (no silent default)", () => {
    const db = openTestSubledgerDb();
    expect(() => classify(db, "DOGE")).toThrow();
  });
});
