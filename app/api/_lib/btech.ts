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
  high_rank_can_substitute_low_group: boolean;
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

/** Vault info for `vaultId` (each vault has its own DKG/group key/address).
 * Prefers btech-vaultd so the receive address is STABLE (DKG runs once); the
 * CLI regenerates a fresh vault — and address — on every call. */
export async function runDemo(vaultId = "treasury"): Promise<DemoReport> {
  if (VAULTD_URL) {
    const res = await fetch(`${VAULTD_URL}/vault/state?id=${encodeURIComponent(vaultId)}`).catch(
      () => null,
    );
    if (res?.ok) {
      const s = (await res.json()) as Partial<DemoReport>;
      return {
        signers: [],
        authorization_digest: "",
        aggregate_signature: "",
        verified: true,
        remaining_relay_events: 0,
        ...s,
      } as DemoReport;
    }
  }
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
export async function runSignApproval(
  p: SignApprovalParams,
  vaultId = "treasury",
): Promise<DemoReport> {
  const amountSats = Math.max(0, Math.round(p.amountSats));
  if (VAULTD_URL) {
    const res = await fetch(`${VAULTD_URL}/vault/sign?id=${encodeURIComponent(vaultId)}`, {
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

/** True when btech-vaultd is configured (enables the collapsed two-round). */
export const VAULTD_CONFIGURED = !!VAULTD_URL;

/**
 * Read the current-policy ratifier quorum (Σ each grouped tier's `required`) for
 * `vaultId` AUTHORITATIVELY from btech-vaultd's `/vault/policy`. Returns `null`
 * when vaultd is unconfigured or the request fails — callers MUST fail-closed on
 * `null` rather than trust a client-supplied threshold. This is the only source
 * of truth for the live treasury vault, whose tiers aren't mirrored into the web DB.
 */
export async function runVaultQuorum(vaultId: string): Promise<number | null> {
  if (!VAULTD_URL) return null;
  const res = await fetch(`${VAULTD_URL}/vault/policy?id=${encodeURIComponent(vaultId)}`).catch(
    () => null,
  );
  if (!res?.ok) return null;
  const data = (await res.json().catch(() => null)) as { quorum?: number } | null;
  return typeof data?.quorum === "number" ? data.quorum : null;
}

export type PrecommitResult = { participant_id: number; nonce_package: unknown };

/** Round 1: pre-commit one signer's nonce for `session`. Returns the public
 * nonce package (store it for audit; the secret nonce stays in vaultd). */
export async function runPrecommit(
  p: { session: string; participantId: number },
  vaultId = "treasury",
): Promise<PrecommitResult> {
  if (!VAULTD_URL) throw new Error("BTECH_VAULTD_URL is required for pre-commit");
  const res = await fetch(`${VAULTD_URL}/vault/sign/precommit?id=${encodeURIComponent(vaultId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: p.session, participant_id: p.participantId }),
  });
  if (!res.ok) {
    throw new Error(`vaultd precommit failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as PrecommitResult;
}

/** Round 2: finalize `session` once every chosen signer has pre-committed. */
export async function runFinalize(
  p: { session: string; signerSet: number[]; recipient: string; amountSats: number; nonce: string; memo: string },
  vaultId = "treasury",
): Promise<DemoReport> {
  if (!VAULTD_URL) throw new Error("BTECH_VAULTD_URL is required for finalize");
  const res = await fetch(`${VAULTD_URL}/vault/sign/finalize?id=${encodeURIComponent(vaultId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: p.session,
      signer_set: p.signerSet,
      recipient: p.recipient,
      amountSats: Math.max(0, Math.round(p.amountSats)),
      nonce: p.nonce,
      memo: p.memo,
    }),
  });
  if (!res.ok) {
    throw new Error(`vaultd finalize failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as DemoReport;
}

export type SettlementInput = { txid: string; vout: number; valueSats: number };

export type SettlementReport = {
  txid: string;
  raw_tx_hex: string;
  vault_address: string;
  recipient: string;
  amount_sats: number;
  change_sats: number;
  fee_sats: number;
  signers: number[];
};

export type SettleParams = {
  recipient: string;
  amountSats: number;
  feeSats: number;
  inputs: SettlementInput[];
};

/** Build + threshold-sign a real Taproot key-path spend out of `vaultId`'s vault
 * via btech-vaultd. Returns the broadcastable raw transaction; the caller is
 * responsible for broadcasting it to the chain. Requires btech-vaultd. */
export async function runSettle(p: SettleParams, vaultId = "treasury"): Promise<SettlementReport> {
  if (!VAULTD_URL) {
    throw new Error("BTECH_VAULTD_URL is required for on-chain settlement");
  }
  const res = await fetch(`${VAULTD_URL}/vault/settle?id=${encodeURIComponent(vaultId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(p),
  });
  if (!res.ok) {
    throw new Error(`vaultd settle failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as SettlementReport;
}

export function runSessionProof(sessionId: string): Promise<SessionProofReport> {
  const id = sessionId.trim().length > 0 ? sessionId.trim() : "btech-session-proof";
  return runBtech(["--session-proof-json", "--session-id", id]) as Promise<SessionProofReport>;
}

/**
 * Wire form of the Rust `GroupedThresholdConfig` (dkgkit-core). The newtype
 * structs `ParticipantId(u16)`/`Rank(u16)` serde-serialize as bare numbers, so
 * `id`/`rank` are plain numbers — match this shape EXACTLY or vaultd rejects it.
 */
export type GroupedConfigWire = {
  participants: { id: number; rank: number; label: string | null }[];
  requirements: { rank: number; required: number; total: number }[];
};

/** Flatten a tiered policy into the grouped-threshold wire config: every tier's
 * signers become participants at that tier's rank, and each tier yields one
 * requirement `{ rank, required, total: signers.length }`. */
export function policyConfigToWire(
  p: import("../../ui/wallet/types").PolicyConfig,
): GroupedConfigWire {
  const participants = p.tiers.flatMap((t) =>
    t.signers.map((s) => ({ id: s.participantId, rank: t.rank, label: s.label as string | null })),
  );
  const requirements = p.tiers.map((t) => ({
    rank: t.rank,
    required: t.required,
    total: t.signers.length,
  }));
  return { participants, requirements };
}

export type ReshareParams = {
  session: string;
  signerSet: number[];
  newConfig: GroupedConfigWire;
  policyFingerprint: string;
};

/** Authorize + apply a vault policy reshare via btech-vaultd. Requires vaultd —
 *  the reshare is stateful and cannot run through the one-shot CLI. */
export async function runReshare(p: ReshareParams, vaultId = "treasury"): Promise<DemoReport> {
  if (!VAULTD_URL) {
    throw new Error("BTECH_VAULTD_URL is required to apply a policy reshare");
  }
  const res = await fetch(`${VAULTD_URL}/vault/reshare?id=${encodeURIComponent(vaultId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: p.session,
      signer_set: p.signerSet,
      new_config: p.newConfig,
      policy_fingerprint: p.policyFingerprint,
    }),
  });
  if (!res.ok) {
    throw new Error(`vaultd reshare failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as DemoReport;
}
