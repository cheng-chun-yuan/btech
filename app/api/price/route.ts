import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function fromBinance(): Promise<number> {
  const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`binance ${r.status}`);
  return Number((await r.json()).price);
}

async function fromCoinGecko(): Promise<number> {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  return Number((await r.json()).bitcoin.usd);
}

export async function GET() {
  try {
    const usd = await fromBinance().catch(() => fromCoinGecko());
    if (!Number.isFinite(usd) || usd <= 0) throw new Error("bad price");
    return NextResponse.json({ usd, source: "live" });
  } catch {
    return NextResponse.json({ usd: 64210, source: "fallback" });
  }
}
