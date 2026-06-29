import { NextResponse } from "next/server";

import { runDemo, runSessionProof } from "../../_lib/btech";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live snapshot of the real DKGKit vault that backs the BTech Wallet UI:
 *   - `demo`    : group key, derived Taproot receive address, signed + BIP340
 *                 verified aggregate signature for the canonical approval.
 *   - `session` : the grouped HTSS policy (1,2,3)-of-(2,3,5), real members with
 *                 joined/invited status, and the negative-control proofs.
 */
export async function GET() {
  try {
    const [demo, session] = await Promise.all([
      runDemo(),
      runSessionProof("btech-wallet-ui"),
    ]);
    return NextResponse.json({ demo, session });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown wallet state error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
