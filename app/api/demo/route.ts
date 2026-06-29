import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

export async function POST() {
  try {
    const { stdout } = await execFileAsync("cargo", ["run", "--quiet", "--", "--json"], {
      cwd: process.cwd(),
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        CARGO_TERM_COLOR: "never",
      },
    });

    return NextResponse.json(JSON.parse(stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown demo error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
