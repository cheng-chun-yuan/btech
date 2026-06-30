import type { DB } from "./db";
import { recordAudit } from "./audit";
import { runDemo, runSettle, type SettlementInput } from "./btech";
import { addressUtxos, broadcastTx } from "./esplora";
import type { Chat } from "../../ui/wallet/types";

export const DEFAULT_FEE_SATS = 1000;

export type SettleResult = { txid: string; changeSats: number; inputs: number; vaultAddress: string };

/**
 * Settle a real on-chain transfer out of a vault: select its confirmed UTXOs,
 * have btech-vaultd build + threshold-sign a Taproot key-path spend, broadcast
 * the raw transaction, and record the txid in the audit log. Shared by the vault
 * settle route and the approval broadcast action so both behave identically.
 */
export async function settleVault(
  db: DB,
  params: {
    vaultId: string;
    recipient: string;
    amountSats: number;
    feeSats?: number;
    actorNpub: string;
    actorLabel: string;
  },
): Promise<SettleResult> {
  const amountSats = Math.round(params.amountSats);
  const feeSats = Math.max(0, Math.round(params.feeSats ?? DEFAULT_FEE_SATS));
  if (amountSats <= 0) throw new Error("amountSats must be positive");

  const row = db.prepare("SELECT data_json FROM chats WHERE id = ?").get(params.vaultId) as
    | { data_json: string }
    | undefined;
  if (!row) throw new Error("Unknown vault");
  // The treasury row stores no address (it is overlaid at runtime), so fall back
  // to the vault's own DKG address from vaultd when the row doesn't carry one.
  let vaultAddress = (JSON.parse(row.data_json) as Omit<Chat, "messages">).receiveAddress;
  if (!vaultAddress) {
    vaultAddress = (await runDemo(params.vaultId)).receive_address;
  }
  if (!vaultAddress) throw new Error("vault has no receive address");

  // Select confirmed UTXOs (largest-first) to cover amount + fee.
  const utxos = await addressUtxos(vaultAddress);
  const need = amountSats + feeSats;
  const inputs: SettlementInput[] = [];
  let total = 0;
  for (const u of utxos.filter((x) => x.status.confirmed).sort((a, b) => b.value - a.value)) {
    if (total >= need) break;
    inputs.push({ txid: u.txid, vout: u.vout, valueSats: u.value });
    total += u.value;
  }
  if (total < need) {
    throw new Error(`insufficient confirmed funds: have ${total} sats, need ${need}`);
  }

  const report = await runSettle({ recipient: params.recipient, amountSats, feeSats, inputs }, params.vaultId);
  const txid = await broadcastTx(report.raw_tx_hex);

  recordAudit(db, {
    chatId: params.vaultId,
    actorNpub: params.actorNpub,
    actorLabel: params.actorLabel,
    action: "sign",
    outcome: "success",
    detail: `Broadcast ${(amountSats / 1e8).toFixed(8)} BTC to ${params.recipient} on-chain — tx ${txid}`,
  });

  return { txid, changeSats: report.change_sats, inputs: inputs.length, vaultAddress };
}
