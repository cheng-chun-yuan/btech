import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../_lib/auth";
import { seedPrices } from "../../_lib/subledger-api";
import type { PricePoint } from "../../_lib/subledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { prices?: PricePoint[] };
  const count = seedPrices(db, body.prices ?? []);
  return NextResponse.json({ count });
}
