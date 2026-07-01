/**
 * treasury.ts — the demo treasury's stealth receiver (server-side singleton).
 *
 * Holds one recipient (scan + spend), publishes its static meta-address, and runs
 * a detect-only SilentPaymentScanner over the view key. Inbound stealth payments
 * (modelled as the operator/sidecar would stream them) are detected with the view
 * key alone — the treasury never learns P in advance.
 */
import {
    recipientFromSeed,
    generateKeyPair,
    viewKeyOf,
    encodeSilentPaymentAddress,
    decodeSilentPaymentAddress,
    senderDerive,
    expectedP,
    toXOnly,
    encodeP2TR,
    type RecipientKeys,
    type Outpoint,
} from "./crypto";
import {
    SilentPaymentScanner,
    type DetectedPayment,
    type CandidateVtx,
} from "./scanner";
import { scanBlocks, esploraFetcher, type TxFetcher } from "./esplora-scan";

const LABEL = "treasury";

// One treasury for the demo. (In production this is the FROST group key as
// B_spend + a delegated scan key; here a seeded recipient stands in.) Seeded —
// not random — so the published meta-address is STABLE across restarts and stays
// valid for anyone who copied it.
const treasury: RecipientKeys = recipientFromSeed(
    new TextEncoder().encode("btech-treasury-stealth-v1"),
);
const scanner = new SilentPaymentScanner();
scanner.registerViewKey(LABEL, viewKeyOf(treasury));

export function metaAddress(): string {
    // One BIP-352 address (tsp1 on regtest) — works on L1 and Arkade alike.
    return encodeSilentPaymentAddress(treasury.meta, "regtest");
}

/** Derivation result for an internal silent send: the on-chain output to pay. */
export interface InternalSendDerivation {
    /** 32-byte x-only taproot output key, hex (the BIP-352 `P_k`). */
    xonly: string;
    /** The witness-v1 (P2TR) address vaultd actually pays/broadcasts to. */
    derivedAddress: string;
    /** BIP-352 output counter `k` (0 for a single output to this recipient). */
    k: number;
}

/**
 * Derive the real on-chain output for an INTERNAL silent payment to `tsp1`.
 *
 * Only possible when WE hold the recipient's scan key — i.e. the address is the
 * treasury's own published meta-address. Uses RECEIVER-SIDE ECDH (the held scan
 * secret + the spent inputs' PUBLIC keys, `A_sum`), which yields the exact same
 * `P` the sender-side derivation would, without ever needing the vault's secret
 * spend key. Returns `null` for any address whose scan key we do not hold (an
 * external `tsp1` we cannot derive) — the caller must fail closed there.
 *
 * `vaultXOnly` is the spent inputs' taproot output key (every input is a UTXO of
 * the one vault address); `outpoints` are exactly the inputs vaultd will spend.
 */
export function deriveInternalSend(params: {
    tsp1: string;
    vaultXOnly: string;
    outpoints: Outpoint[];
    hrp?: string;
    t?: number;
}): InternalSendDerivation | null {
    const meta = decodeSilentPaymentAddress(params.tsp1);
    // We can only derive for an address whose scan key we hold (the treasury's).
    if (meta.bScanPub !== treasury.meta.bScanPub || meta.bSpendPub !== treasury.meta.bSpendPub) {
        return null;
    }
    const t = params.t ?? 0;
    // One even-Y taproot input key per spent input (A_sum = Σ these). Matches what
    // the on-chain tx reveals, so the recipient's scanner re-derives the same P.
    const senderPubs = params.outpoints.map(() => `02${params.vaultXOnly}`);
    const P = expectedP({ viewKey: viewKeyOf(treasury), senderPubs, outpoints: params.outpoints, t });
    const xonly = toXOnly(P);
    return { xonly, derivedAddress: encodeP2TR(xonly, params.hrp ?? "bcrt"), k: t };
}

export function getInbound(): DetectedPayment[] {
    return scanner.getHistory(LABEL).slice().reverse();
}

/** Feed a candidate vtx from the operator stream and return any detections. */
export function ingestCandidate(vtx: CandidateVtx): DetectedPayment[] {
    return scanner.scanVtx(vtx);
}

/**
 * Model one inbound stealth payment: a fresh random sender pays the treasury's
 * meta-address off-chain. Derives P, builds the candidate the operator would
 * stream, and the view-key scanner detects it.
 */
export function simulateInbound(): DetectedPayment | null {
    const sender = generateKeyPair();
    const txid = sender.pub.slice(2, 66); // 64-hex pseudo-txid for the spent input
    const vtxoId = `${txid}:0`;
    const amount = 1000 * (1 + Math.floor(Math.random() * 200));
    const { P } = senderDerive({
        meta: treasury.meta,
        spenderPrivs: [sender.priv],
        outpoints: [{ txid, vout: 0 }],
        t: 0,
    });
    const candidate: CandidateVtx = {
        vtxId: `ark:${txid.slice(0, 12)}`,
        inputs: [{ userPK: sender.pub, vtxoId }],
        outputs: [{ xonly: toXOnly(P), amount, leafIndex: 0 }],
    };
    return ingestCandidate(candidate)[0] ?? null;
}

// ── real on-chain (L1) detection via view-key block-walk ─────────────────────

export type InboxSource = "onchain" | "modeled";

export interface InboxItem {
    source: InboxSource;
    P: string; // x-only taproot output key (hex)
    amount: number;
    // on-chain only:
    txid?: string;
    vout?: number;
    blockHeight?: number;
    // modeled only:
    vtxId?: string;
    leafIndex?: number;
}

/** How many blocks back the first scan looks (the seeded address only ever
 *  receives after the demo starts, so a recent window is enough). */
const SCAN_DEPTH = Number(process.env.BTECH_STEALTH_SCAN_DEPTH ?? "500");

let lastScanned: number | null = null;
const onchain = new Map<string, InboxItem>(); // key = `${txid}:${vout}`

/** Test-only: reset the on-chain cursor + store. */
export function __resetOnchainForTest(): void {
    lastScanned = null;
    onchain.clear();
}

/**
 * Walk new blocks up to the chain tip and detect inbound silent payments to the
 * treasury with the VIEW KEY only. Deduped by `txid:vout`; advances an in-memory
 * cursor. Returns the newly-detected items.
 */
export async function scanChainOnce(fetcher: TxFetcher = esploraFetcher): Promise<InboxItem[]> {
    const tip = await fetcher.tip();
    const from = lastScanned === null ? Math.max(0, tip - SCAN_DEPTH) : lastScanned + 1;
    if (from > tip) {
        lastScanned = tip;
        return [];
    }
    const dets = await scanBlocks(viewKeyOf(treasury), from, tip, fetcher);
    const fresh: InboxItem[] = [];
    for (const d of dets) {
        const key = `${d.txid}:${d.vout}`;
        if (onchain.has(key)) continue;
        const item: InboxItem = {
            source: "onchain",
            P: d.xonly,
            amount: d.amount,
            txid: d.txid,
            vout: d.vout,
            blockHeight: d.blockHeight,
        };
        onchain.set(key, item);
        fresh.push(item);
    }
    lastScanned = tip;
    return fresh;
}

/**
 * Unified inbox: real on-chain detections (newest first) then modeled ones,
 * deduped by the detected output key `P` (on-chain wins over a modeled echo).
 */
export function getInbox(): InboxItem[] {
    const seen = new Set<string>();
    const items: InboxItem[] = [];
    for (const it of [...onchain.values()].reverse()) {
        seen.add(it.P);
        items.push(it);
    }
    for (const p of getInbound()) {
        if (seen.has(p.P)) continue;
        items.push({ source: "modeled", P: p.P, amount: p.amount, vtxId: p.vtxId, leafIndex: p.leafIndex });
    }
    return items;
}
