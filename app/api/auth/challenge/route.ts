import { NextResponse } from "next/server";

import { getDb } from "../../_lib/db";
import { createChallenge } from "../../_lib/challenge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ nonce: createChallenge(getDb()) });
}
