import { NextResponse } from "next/server";
import {
  metaAddress,
  getInbound,
  simulateInbound,
  ingestCandidate,
} from "../../../lib/silentpayment/treasury";
import type { CandidateVtx } from "../../../lib/silentpayment/scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Treasury stealth address + detected inbound (view-key detection).
export async function GET() {
  return NextResponse.json({ metaAddress: metaAddress(), inbound: getInbound() });
}

// POST with a CandidateVtx body → detect a REAL inbound (e.g. an arkd ark tx the
// operator streamed). POST with no body → simulate one locally.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as CandidateVtx | null;
  const detected =
    body && Array.isArray(body.inputs) && Array.isArray(body.outputs)
      ? (ingestCandidate(body)[0] ?? null)
      : simulateInbound();
  return NextResponse.json({ detected, inbound: getInbound() });
}
