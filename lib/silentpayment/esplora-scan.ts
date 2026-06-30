/**
 * esplora-scan.ts — real BIP-352 receiving on an Esplora-indexed chain (regtest).
 *
 * Walks blocks, extracts each tx's *eligible* input pubkeys (BIP-352 §Inputs For
 * Shared Secret Derivation), and runs the view-key counter loop (crypto.scanTx)
 * over the tx's taproot outputs. Detection needs only the scan (view) key — never
 * b_spend. Block/tx I/O is injectable (`TxFetcher`) so the detection logic is
 * unit-testable without a live node.
 *
 * Eligibility:
 *   - P2TR (key path):   even-Y output key  (NUMS-internal-key script paths excluded)
 *   - P2WPKH / P2SH-P2WPKH: the 33-byte compressed pubkey from the witness
 *   - P2PKH:             the compressed pubkey pushed in the scriptSig
 *   - anything else / uncompressed keys: excluded
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { evenYCompressed, scanTx, type Outpoint, type ViewKey } from "./crypto";

const ESPLORA = (process.env.BTECH_ESPLORA_URL ?? "https://btc.utxopia.com/regtest").replace(/\/$/, "");

/** BIP-341 NUMS point x-coordinate — a taproot script path with this internal key is not eligible. */
const NUMS_X = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

export interface EsploraVin {
    txid: string;
    vout: number;
    is_coinbase?: boolean;
    scriptsig?: string;
    witness?: string[];
    prevout?: { scriptpubkey?: string; scriptpubkey_type?: string; value?: number } | null;
}
export interface EsploraVout {
    scriptpubkey: string;
    scriptpubkey_type?: string;
    value: number;
}
export interface FullTx {
    txid: string;
    vin: EsploraVin[];
    vout: EsploraVout[];
    status?: { confirmed?: boolean; block_height?: number };
}

export interface L1Detection {
    txid: string;
    vout: number;
    xonly: string;
    amount: number;
    k: number;
    blockHeight: number;
}

function isCompressed(pk: string | undefined): pk is string {
    return !!pk && pk.length === 66 && (pk.startsWith("02") || pk.startsWith("03"));
}

/** Bitcoin script data pushes, in order (ignores non-push opcodes). */
function scriptPushes(hex: string): string[] {
    const b = hexToBytes(hex);
    const out: string[] = [];
    let i = 0;
    while (i < b.length) {
        const op = b[i++];
        let len = 0;
        if (op >= 0x01 && op <= 0x4b) len = op;
        else if (op === 0x4c) len = b[i++] ?? 0;
        else if (op === 0x4d) {
            len = (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
            i += 2;
        } else if (op === 0x4e) {
            len = (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24);
            i += 4;
        } else continue; // OP_0 / OP_1..OP_16 / other non-push — skip
        out.push(bytesToHex(b.slice(i, i + len)));
        i += len;
    }
    return out;
}

/** The x-only key of a taproot scriptPubKey (`5120<32>`), or null. */
export function taprootXOnly(spk: string): string | null {
    const s = spk.toLowerCase();
    return s.length === 68 && s.startsWith("5120") ? s.slice(4) : null;
}

/** The BIP-352 contribution pubkey of an input (even-Y compressed hex), or null if ineligible. */
export function contribPubkey(vin: EsploraVin): string | null {
    if (vin.is_coinbase || !vin.prevout?.scriptpubkey) return null;
    const spk = vin.prevout.scriptpubkey.toLowerCase();
    const witness = vin.witness ?? [];

    // P2TR key path → even-Y output key; exclude NUMS-internal-key script paths.
    const xonly = taprootXOnly(spk);
    if (xonly) {
        let stack = witness;
        if (stack.length >= 2 && stack[stack.length - 1]?.startsWith("50")) stack = stack.slice(0, -1); // drop annex
        if (stack.length > 1) {
            const controlBlock = stack[stack.length - 1] ?? "";
            const internalKey = controlBlock.slice(2, 66).toLowerCase();
            if (internalKey === NUMS_X) return null;
        }
        return evenYCompressed("02" + xonly);
    }
    // P2WPKH → witness pubkey.
    if (spk.length === 44 && spk.startsWith("0014")) {
        const pk = witness[witness.length - 1];
        return isCompressed(pk) ? pk.toLowerCase() : null;
    }
    // P2SH (assume P2SH-P2WPKH) → witness pubkey.
    if (spk.length === 46 && spk.startsWith("a914") && spk.endsWith("87")) {
        const pk = witness[witness.length - 1];
        return isCompressed(pk) ? pk.toLowerCase() : null;
    }
    // P2PKH → last scriptSig push.
    if (spk.length === 50 && spk.startsWith("76a914") && spk.endsWith("88ac")) {
        const pushes = scriptPushes(vin.scriptsig ?? "");
        const pk = pushes[pushes.length - 1];
        return isCompressed(pk) ? pk.toLowerCase() : null;
    }
    return null;
}

/** Detect a view key's inbound silent payments in one transaction (pure). */
export function txDetections(viewKey: ViewKey, tx: FullTx, blockHeight: number): L1Detection[] {
    const contribs = tx.vin.map(contribPubkey).filter((x): x is string => x !== null);
    if (contribs.length === 0) return [];
    const taprootOuts = tx.vout
        .map((o, i) => ({ i, xonly: taprootXOnly(o.scriptpubkey), value: o.value }))
        .filter((o): o is { i: number; xonly: string; value: number } => o.xonly !== null);
    if (taprootOuts.length === 0) return [];

    const outpoints: Outpoint[] = tx.vin.map((v) => ({ txid: v.txid, vout: v.vout }));
    const matches = scanTx(viewKey, contribs, outpoints, taprootOuts.map((o) => o.xonly));
    return matches.map((m) => {
        const o = taprootOuts.find((t) => t.xonly === m.xonly)!;
        return { txid: tx.txid, vout: o.i, xonly: m.xonly, amount: o.value, k: m.k, blockHeight };
    });
}

// ── chain I/O (injectable) ───────────────────────────────────────────────────

export interface TxFetcher {
    tip(): Promise<number>;
    blockHash(height: number): Promise<string | null>;
    blockTxids(hash: string): Promise<string[]>;
    getTx(txid: string): Promise<FullTx>;
}

async function txt(path: string): Promise<string> {
    const r = await fetch(`${ESPLORA}${path}`, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return (await r.text()).trim();
}
async function json<T>(path: string): Promise<T> {
    const r = await fetch(`${ESPLORA}${path}`, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return (await r.json()) as T;
}

export const esploraFetcher: TxFetcher = {
    tip: () => txt("/api/blocks/tip/height").then(Number),
    blockHash: (h) => txt(`/api/block-height/${h}`).catch(() => null as unknown as string),
    blockTxids: (hash) => json<string[]>(`/api/block/${hash}/txids`),
    getTx: (txid) => json<FullTx>(`/api/tx/${txid}`),
};

/** Scan an inclusive block-height range for a view key's inbound silent payments. */
export async function scanBlocks(
    viewKey: ViewKey,
    fromHeight: number,
    toHeight: number,
    fetcher: TxFetcher = esploraFetcher
): Promise<L1Detection[]> {
    const found: L1Detection[] = [];
    for (let h = fromHeight; h <= toHeight; h++) {
        const hash = await fetcher.blockHash(h);
        if (!hash) continue;
        const txids = await fetcher.blockTxids(hash);
        for (const txid of txids) {
            const tx = await fetcher.getTx(txid);
            found.push(...txDetections(viewKey, tx, h));
        }
    }
    return found;
}
