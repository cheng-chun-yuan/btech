import { NextResponse } from "next/server";

import { addressBalance, addressUtxos } from "../../../_lib/esplora";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ addr: string }> }) {
  const { addr } = await context.params;
  try {
    const [balance, utxos] = await Promise.all([addressBalance(addr), addressUtxos(addr)]);
    return NextResponse.json({ ...balance, utxoCount: utxos.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "address lookup failed" },
      { status: 502 },
    );
  }
}
