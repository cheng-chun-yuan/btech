import { NextResponse } from "next/server";

import { getDb } from "../../_lib/db";
import { listSigners, syncSigners } from "../../_lib/identity";
import { runSessionProof } from "../../_lib/btech";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  let personas = listSigners(db);
  if (personas.length === 0) {
    // First boot: derive signer identities from the live vault invites.
    try {
      const session = await runSessionProof("btech-wallet-ui");
      syncSigners(db, session.invites);
      personas = listSigners(db);
    } catch {
      // Backend offline — return empty; UI can still use nsec/NIP-07 login.
    }
  }
  return NextResponse.json({ personas });
}
