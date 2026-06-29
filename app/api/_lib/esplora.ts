/**
 * Minimal Esplora (mempool/blockstream-style) client for the regtest chain.
 * Base URL from BTECH_ESPLORA_URL, defaulting to the hosted regtest explorer.
 */
const ESPLORA_URL = (process.env.BTECH_ESPLORA_URL ?? "https://btc.utxopia.com/regtest").replace(
  /\/$/,
  "",
);

export function esploraBase(): string {
  return ESPLORA_URL;
}

type AddressStats = {
  funded_txo_sum: number;
  spent_txo_sum: number;
  tx_count: number;
};

type AddressInfo = {
  chain_stats: AddressStats;
  mempool_stats: AddressStats;
};

export type Utxo = {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
};

export type AddressBalance = {
  address: string;
  confirmedSats: number;
  mempoolSats: number;
  totalSats: number;
  txCount: number;
};

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ESPLORA_URL}${path}`, { ...init, signal: AbortSignal.timeout(12_000) });
}

/** Current chain tip height. */
export async function tipHeight(): Promise<number> {
  const res = await api("/api/blocks/tip/height");
  if (!res.ok) throw new Error(`tip height ${res.status}`);
  return Number((await res.text()).trim());
}

/** Confirmed + mempool balance for an address. Throws on an invalid address. */
export async function addressBalance(address: string): Promise<AddressBalance> {
  const res = await api(`/api/address/${address}`);
  if (!res.ok) throw new Error(`address ${res.status}: ${(await res.text()).slice(0, 80)}`);
  const info = (await res.json()) as AddressInfo;
  const confirmedSats = info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum;
  const mempoolSats = info.mempool_stats.funded_txo_sum - info.mempool_stats.spent_txo_sum;
  return {
    address,
    confirmedSats,
    mempoolSats,
    totalSats: confirmedSats + mempoolSats,
    txCount: info.chain_stats.tx_count + info.mempool_stats.tx_count,
  };
}

/** Unspent outputs for an address. */
export async function addressUtxos(address: string): Promise<Utxo[]> {
  const res = await api(`/api/address/${address}/utxo`);
  if (!res.ok) throw new Error(`utxo ${res.status}`);
  return (await res.json()) as Utxo[];
}

/** Broadcast a raw transaction hex; returns the txid. */
export async function broadcastTx(rawHex: string): Promise<string> {
  const res = await api("/api/tx", { method: "POST", body: rawHex });
  if (!res.ok) throw new Error(`broadcast ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.text()).trim();
}
