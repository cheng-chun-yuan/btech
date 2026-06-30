import { NextResponse } from "next/server";

import { addressTxs, esploraBase, type EsploraTx } from "../../_lib/esplora";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ActivityEntry = {
  txid: string;
  address: string;
  direction: "in" | "out";
  /** Net effect on the address, signed (positive = received). */
  deltaSats: number;
  confirmed: boolean;
  blockHeight: number | null;
  blockTime: number | null;
  /** Block explorer page for this tx. */
  txUrl: string;
};

/** Net received/sent for `address` across one tx, from its inputs and outputs. */
function entryForTx(address: string, tx: EsploraTx): ActivityEntry {
  let received = 0;
  let sent = 0;
  for (const o of tx.vout) if (o.scriptpubkey_address === address) received += o.value;
  for (const i of tx.vin) if (i.prevout?.scriptpubkey_address === address) sent += i.prevout.value ?? 0;
  const delta = received - sent;
  return {
    txid: tx.txid,
    address,
    direction: delta >= 0 ? "in" : "out",
    deltaSats: delta,
    confirmed: tx.status.confirmed,
    blockHeight: tx.status.block_height ?? null,
    blockTime: tx.status.block_time ?? null,
    txUrl: `${esploraBase()}/tx/${tx.txid}`,
  };
}

/**
 * Recent on-chain activity for the supplied vault addresses, newest first.
 * GET /api/chain/activity?addrs=addr1,addr2&limit=8
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const addrs = (url.searchParams.get("addrs") ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 8)));
  if (addrs.length === 0) return NextResponse.json({ activity: [] });

  const settled = await Promise.allSettled(addrs.map((a) => addressTxs(a)));
  const all: ActivityEntry[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") all.push(...r.value.map((tx) => entryForTx(addrs[i], tx)));
  });

  // Mempool (no block time) first, then confirmed by descending block time.
  all.sort((a, b) => {
    if (a.blockTime == null && b.blockTime == null) return 0;
    if (a.blockTime == null) return -1;
    if (b.blockTime == null) return 1;
    return b.blockTime - a.blockTime;
  });

  return NextResponse.json({ activity: all.slice(0, limit) });
}
