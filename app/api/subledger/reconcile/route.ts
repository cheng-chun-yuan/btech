import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../_lib/auth";
import { runPeriodReconcile } from "../../_lib/subledger-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { period?: string; chainBalances?: Record<string, string> };
  if (!body.period) return NextResponse.json({ error: "period is required" }, { status: 400 });
  const data = runPeriodReconcile(db, body.period, body.chainBalances ?? {});
  return NextResponse.json({ data });
}
