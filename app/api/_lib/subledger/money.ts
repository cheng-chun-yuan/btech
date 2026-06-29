// money.ts — exact fixed-point arithmetic for the subledger.
//
// Every amount is an integer `bigint` of minor units at a known *scale* (number
// of decimal places). No JavaScript `number` ever represents an amount — float
// rounding would break INV-1 (balanced entries) and INV-6 (faithful TWD + qty).
//
// NOTE: tsconfig targets ES2017, so BigInt *literals* (`1n`) are unavailable.
// Use the `BigInt()` constructor throughout.

/** A fixed-point amount: integer minor units. Always paired with a scale. */
export type Minor = bigint;

/** TWD carrying/measurement precision. Posting rounds to TWD_POSTING_SCALE. */
export const TWD_INTERNAL_SCALE = 4;
export const TWD_POSTING_SCALE = 2;
/** USD price-per-unit precision in a PricePoint. */
export const PRICE_SCALE = 8;
/** USD/TWD rate precision in a PricePoint. */
export const FX_SCALE = 6;
/** Native quantity precision per asset (decimal places). */
export const QTY_SCALE: Record<string, number> = {
  BTC: 8,
  ETH: 18,
  USDC: 6,
  USDT: 6,
};

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

/** 10 ** n as a bigint (n >= 0). */
function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

/**
 * round(a * b / c) with half-away-from-zero rounding. Used to allocate a lot's
 * total cost basis proportionally across consumptions with no unit-cost drift
 * (so the subledger basis and GL credits reconcile exactly — INV-4).
 */
export function mulDivRound(a: Minor, b: bigint, c: bigint): Minor {
  const product = a * b;
  const neg = product < ZERO;
  const abs = neg ? -product : product;
  const q = abs / c;
  const r = abs % c;
  const rounded = r * TWO >= c ? q + ONE : q;
  return neg ? -rounded : rounded;
}

/** Integer divide with half-away-from-zero rounding (commercial rounding). */
function roundDiv(value: bigint, divisor: bigint): bigint {
  const neg = value < ZERO;
  const abs = neg ? -value : value;
  const q = abs / divisor;
  const r = abs % divisor;
  const rounded = r * TWO >= divisor ? q + ONE : q;
  return neg ? -rounded : rounded;
}

/** Parse a decimal string (e.g. "12.5") into minor units at `scale`. */
export function parseDecimal(input: string, scale: number): Minor {
  const neg = input.startsWith("-");
  const body = neg ? input.slice(1) : input;
  const [intPart, fracPart = ""] = body.split(".");
  const frac = (fracPart + "0".repeat(scale)).slice(0, scale);
  const value = BigInt((intPart || "0") + frac);
  return neg ? -value : value;
}

/** Render minor units at `scale` back to a fixed-precision decimal string. */
export function formatDecimal(value: Minor, scale: number): string {
  const neg = value < ZERO;
  const abs = neg ? -value : value;
  const digits = abs.toString().padStart(scale + 1, "0");
  const cut = digits.length - scale;
  const out =
    scale > 0 ? `${digits.slice(0, cut)}.${digits.slice(cut)}` : digits;
  return neg ? `-${out}` : out;
}

/**
 * Convert minor units from `fromScale` to `toScale`. Widening is exact;
 * narrowing rounds half away from zero. This is the ONLY place amounts round.
 */
export function rescale(value: Minor, fromScale: number, toScale: number): Minor {
  if (toScale === fromScale) return value;
  if (toScale > fromScale) return value * pow10(toScale - fromScale);
  return roundDiv(value, pow10(fromScale - toScale));
}

/**
 * §5 measurement primitive: `qty * price_usd * usd_twd_rate` as a TWD amount at
 * TWD_INTERNAL_SCALE. The multiply is exact (bigint); rounding happens once via
 * `rescale` from the combined scale down to the internal TWD scale.
 */
export function valueTwd(
  qty: Minor,
  qtyScale: number,
  priceUsd: Minor,
  fxRate: Minor,
): Minor {
  const product = qty * priceUsd * fxRate;
  const combinedScale = qtyScale + PRICE_SCALE + FX_SCALE;
  return rescale(product, combinedScale, TWD_INTERNAL_SCALE);
}
