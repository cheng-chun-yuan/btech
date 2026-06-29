import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const PREBUILT_BINARY = path.join(process.cwd(), "target", "debug", "btech");

export type DemoReport = {
  vault_id: string;
  network: string;
  group_xonly_public_key: string;
  receive_path: string;
  receive_address: string;
  signers: number[];
  authorization_digest: string;
  aggregate_signature: string;
  verified: boolean;
  remaining_relay_events: number;
};

export type InviteStatus = "Invited" | "Joined";

export type InvitedParticipant = {
  participant_id: number;
  label: string;
  role: string;
  status: InviteStatus;
};

export type VaultPolicyGroup = {
  group_id: string;
  chat_name: string;
  rank: number;
  required: number;
  total: number;
  participant_ids: number[];
  joined_ids: number[];
};

export type SignatureProof = {
  scheme: string;
  threshold: string;
  group_xonly_public_key: string;
  signer_set: number[];
  digest: string;
  aggregate_signature: string;
  verified: boolean;
};

export type SessionProofReport = {
  session_id: string;
  invites: InvitedParticipant[];
  vault_policy_groups: VaultPolicyGroup[];
  all_invites_joined: boolean;
  tss_boundary: string;
  tss: SignatureProof;
  htss: SignatureProof;
  invalid_htss_signer_set_rejected: boolean;
  high_rank_cannot_substitute_low_group: boolean;
  receive_address: string;
};

async function prebuiltExists(): Promise<boolean> {
  try {
    await access(PREBUILT_BINARY, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the real DKGKit wallet service. Prefers the prebuilt debug binary for
 * latency; falls back to `cargo run` so the route still works on a clean tree.
 */
async function runBtech(args: string[]): Promise<unknown> {
  const usePrebuilt = await prebuiltExists();
  const command = usePrebuilt ? PREBUILT_BINARY : "cargo";
  const commandArgs = usePrebuilt ? args : ["run", "--quiet", "--", ...args];

  const { stdout } = await execFileAsync(command, commandArgs, {
    cwd: process.cwd(),
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CARGO_TERM_COLOR: "never" },
  });

  return JSON.parse(stdout);
}

export function runDemo(): Promise<DemoReport> {
  return runBtech(["--json"]) as Promise<DemoReport>;
}

export type SignApprovalParams = {
  recipient: string;
  amountSats: number;
  nonce: string;
  memo: string;
};

/** Long-lived vault service URL (e.g. http://127.0.0.1:8787). When set, signing
 * goes through `btech-vaultd` (DKG run once, fast) instead of spawning the CLI. */
const VAULTD_URL = process.env.BTECH_VAULTD_URL?.replace(/\/$/, "");

/**
 * Sign a real payment authorization: the aggregate signature is bound to the
 * approval's actual recipient + amount + id, not a fixed demo digest. Uses
 * btech-vaultd over HTTP when available, otherwise falls back to the CLI.
 */
export async function runSignApproval(p: SignApprovalParams): Promise<DemoReport> {
  const amountSats = Math.max(0, Math.round(p.amountSats));
  if (VAULTD_URL) {
    const res = await fetch(`${VAULTD_URL}/vault/sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: p.recipient, amountSats, nonce: p.nonce, memo: p.memo }),
    });
    if (!res.ok) {
      throw new Error(`vaultd sign failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    return (await res.json()) as DemoReport;
  }
  return runBtech([
    "--sign-approval-json",
    "--recipient",
    p.recipient,
    "--amount",
    String(amountSats),
    "--nonce",
    p.nonce,
    "--memo",
    p.memo,
  ]) as Promise<DemoReport>;
}

export function runSessionProof(sessionId: string): Promise<SessionProofReport> {
  const id = sessionId.trim().length > 0 ? sessionId.trim() : "btech-session-proof";
  return runBtech(["--session-proof-json", "--session-id", id]) as Promise<SessionProofReport>;
}
