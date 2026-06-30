import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getDb } from "../../../_lib/db";
import { getSessionUser, SESSION_COOKIE } from "../../../_lib/auth";
import { getOutput } from "../../../_lib/subledger-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ kind: string }> }) {
  const db = getDb();
  const user = getSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { kind } = await context.params;
  const period = new URL(req.url).searchParams.get("period") ?? undefined;
  try {
    return NextResponse.json({ kind, data: getOutput(db, kind, period) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "bad output request" },
      { status: 400 },
    );
  }
}
