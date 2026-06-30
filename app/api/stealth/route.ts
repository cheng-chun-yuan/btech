import { NextResponse } from "next/server";
import {
  metaAddress,
  getInbound,
  simulateInbound,
} from "../../../lib/silentpayment/treasury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Treasury stealth address + detected inbound (view-key detection).
export async function GET() {
  return NextResponse.json({ metaAddress: metaAddress(), inbound: getInbound() });
}

// Model one inbound stealth payment to the treasury and detect it.
export async function POST() {
  const detected = simulateInbound();
  return NextResponse.json({ detected, inbound: getInbound() });
}
