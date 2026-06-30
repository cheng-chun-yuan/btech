import { describe, it, expect } from "vitest";

import {
  parseDecimal,
  formatDecimal,
  rescale,
  valueTwd,
  TWD_INTERNAL_SCALE,
  PRICE_SCALE,
  FX_SCALE,
} from "./money";

const big = (n: number) => BigInt(n);

describe("money.parseDecimal", () => {
  it("converts a decimal string to integer minor units at the given scale", () => {
    expect(parseDecimal("12.5", 4)).toBe(big(125000));
  });

  it("handles negatives and integers", () => {
    expect(parseDecimal("-3", 2)).toBe(big(-300));
    expect(parseDecimal("0", 4)).toBe(big(0));
  });
});

describe("money.formatDecimal", () => {
  it("round-trips parseDecimal", () => {
    expect(formatDecimal(parseDecimal("12.5", 4), 4)).toBe("12.5000");
    expect(formatDecimal(parseDecimal("-3", 2), 2)).toBe("-3.00");
    expect(formatDecimal(big(0), 4)).toBe("0.0000");
  });
});

describe("money.rescale", () => {
  it("is exact when the value has no excess precision", () => {
    expect(rescale(parseDecimal("12.50", 4), 4, 2)).toBe(big(1250)); // 12.50
    expect(rescale(big(1250), 2, 4)).toBe(big(125000)); // widen: exact
  });

  it("rounds half away from zero when narrowing scale", () => {
    expect(rescale(parseDecimal("1.005", 4), 4, 2)).toBe(big(101)); // 1.0050 -> 1.01
    expect(rescale(parseDecimal("1.004", 4), 4, 2)).toBe(big(100)); // 1.0040 -> 1.00
    expect(rescale(parseDecimal("-1.005", 4), 4, 2)).toBe(big(-101)); // symmetric
  });
});

describe("money.valueTwd", () => {
  it("computes qty * price_usd * usd_twd_rate at internal TWD scale", () => {
    // 1 BTC @ $65,000 with USD/TWD = 31.25  ->  2,031,250.0000 TWD
    const qty = parseDecimal("1", 8); // BTC scale 8
    const priceUsd = parseDecimal("65000", PRICE_SCALE);
    const fxRate = parseDecimal("31.25", FX_SCALE);
    const fv = valueTwd(qty, 8, priceUsd, fxRate);
    expect(formatDecimal(fv, TWD_INTERNAL_SCALE)).toBe("2031250.0000");
  });

  it("rounds the multiply-chain once, half away from zero", () => {
    // 0.333333330 ETH-ish qty against an awkward price still yields exact minor units
    const qty = parseDecimal("0.33333333", 8);
    const priceUsd = parseDecimal("3.00000001", PRICE_SCALE);
    const fxRate = parseDecimal("1", FX_SCALE);
    const fv = valueTwd(qty, 8, priceUsd, fxRate);
    // 0.33333333 * 3.00000001 = 1.0000000033333333 -> 4dp -> 1.0000
    expect(formatDecimal(fv, TWD_INTERNAL_SCALE)).toBe("1.0000");
  });
});
