import { NextResponse } from "next/server";

import { tipHeight, esploraBase } from "../../_lib/esplora";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ height: await tipHeight(), explorer: esploraBase() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "chain unreachable" },
      { status: 502 },
    );
  }
}
