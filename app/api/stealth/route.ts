import { NextResponse } from "next/server";
import {
  metaAddress,
  getInbox,
  scanChainOnce,
  simulateInbound,
  ingestCandidate,
} from "../../../lib/silentpayment/treasury";
import type { CandidateVtx } from "../../../lib/silentpayment/scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Treasury stealth address + inbox. GET runs a best-effort incremental on-chain
// block-walk (view-key detection) so real L1 silent payments show up here.
export async function GET() {
  await scanChainOnce().catch(() => []); // best-effort; never fail the read
  return NextResponse.json({ metaAddress: metaAddress(), inbound: getInbox() });
}

// POST with a CandidateVtx body → ingest a modeled (Phase-2 Arkade) candidate.
// POST with no body → simulate one modeled inbound locally (demo button).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as CandidateVtx | null;
  const detected =
    body && Array.isArray(body.inputs) && Array.isArray(body.outputs)
      ? (ingestCandidate(body)[0] ?? null)
      : simulateInbound();
  return NextResponse.json({ detected, inbound: getInbox() });
}
