import { NextResponse } from "next/server";

import { runDemo } from "../../_lib/btech";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Execute a real grouped HTSS signing round against the live DKGKit vault and
 * return the resulting aggregate Schnorr signature with its BIP340 verification
 * result. This is what the wallet's "Approve & sign" action calls for the live
 * vault — the signature and `verified` flag come straight from the Rust crate.
 */
export async function POST() {
  try {
    const report = await runDemo();
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown signing error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
