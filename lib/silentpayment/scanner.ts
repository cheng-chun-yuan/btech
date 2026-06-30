/**
 * silentpayment/scanner.ts — detect inbound silent payments with a view key.
 *
 * The scanner is a pure detection ENGINE: given candidate virtual txs (each with
 * its input pubkeys + spent vtxoIds and its taproot output keys), it recomputes
 * the expected `P` for every registered view key and reports matches. It holds
 * only view keys — it can DETECT, never SPEND (a `ViewKey` carries no `b_spend`).
 *
 * Where the candidate vtxs come from is a pluggable seam (`VtxSource`). On Arkade
 * the indexer is script/outpoint-scoped — a recipient cannot enumerate every
 * output — so detection is operator-side or operator-delegated: the party that
 * sees the tx stream runs this engine with a delegated view key. The view key
 * and all detection state stay local to whoever runs it; nothing is stored by a
 * third party, and the full history is reproducible from the seed + the stream.
 */

import { type ViewKey, scanMatchesXOnly } from "./crypto";

/** A taproot output of a candidate vtx (the leaf userPK is x-only / 32-byte hex). */
export interface CandidateOutput {
    /** 32-byte x-only taproot output key, hex (e.g. parsed from a 5120<xonly> script). */
    xonly: string;
    amount: number;
    /** Output position inside the funding vtx — the BIP-352 counter `t`. */
    leafIndex: number;
}

/** One virtual tx surfaced for view-key scanning. */
export interface CandidateVtx {
    vtxId: string;
    batchId?: string;
    inputs: Array<{ userPK: string; vtxoId: string }>;
    outputs: CandidateOutput[];
}

export interface DetectedPayment {
    label: string;
    vtxId: string;
    batchId?: string;
    /** The detected taproot output key (x-only hex). */
    P: string;
    amount: number;
    leafIndex: number;
    /** What a recipient needs to derive the spend key. */
    derivation: { senderPubs: string[]; inputVtxoIds: string[]; t: number };
}

type IncomingHandler = (p: DetectedPayment) => void;

interface Registration {
    viewKey: ViewKey;
    onIncoming?: IncomingHandler;
}

/** A pluggable source of candidate vtxs (the operator/delegated stream seam). */
export interface VtxSource {
    /** Yield candidate vtxs. Implementations back this with the operator stream. */
    vtxs(): AsyncIterable<CandidateVtx>;
}

export class SilentPaymentScanner {
    private regs = new Map<string, Registration>();
    private history = new Map<string, DetectedPayment[]>();
    /** Detected P's per label — drives idempotent refresh/self-spend dedup. */
    private knownP = new Map<string, Set<string>>();

    /** Register a recipient's view key under a label. Detect-only. */
    registerViewKey(
        label: string,
        viewKey: ViewKey,
        onIncoming?: IncomingHandler
    ): void {
        this.regs.set(label, { viewKey, onIncoming });
        if (!this.history.has(label)) this.history.set(label, []);
        if (!this.knownP.has(label)) this.knownP.set(label, new Set());
    }

    /**
     * Scan one candidate vtx against every registered view key. Aggregates inputs
     * (BIP-352) and tests each output with `t = leafIndex`. A previously-seen P is
     * a renewal (update batchId, emit nothing new).
     */
    scanVtx(vtx: CandidateVtx): DetectedPayment[] {
        const detected: DetectedPayment[] = [];
        if (vtx.inputs.length === 0) return detected;

        const senderPubs = vtx.inputs.map((i) => i.userPK);
        const inputVtxoIds = vtx.inputs.map((i) => i.vtxoId);

        for (const [label, reg] of this.regs) {
            const known = this.knownP.get(label)!;
            for (const out of vtx.outputs) {
                if (known.has(out.xonly)) {
                    const prior = this.history
                        .get(label)!
                        .find((p) => p.P === out.xonly);
                    if (prior) prior.batchId = vtx.batchId;
                    continue;
                }
                const params = {
                    viewKey: reg.viewKey,
                    senderPubs,
                    inputVtxoIds,
                    t: out.leafIndex,
                };
                if (!scanMatchesXOnly(params, out.xonly)) continue;

                const payment: DetectedPayment = {
                    label,
                    vtxId: vtx.vtxId,
                    batchId: vtx.batchId,
                    P: out.xonly,
                    amount: out.amount,
                    leafIndex: out.leafIndex,
                    derivation: {
                        senderPubs,
                        inputVtxoIds,
                        t: out.leafIndex,
                    },
                };
                known.add(out.xonly);
                this.history.get(label)!.push(payment);
                reg.onIncoming?.(payment);
                detected.push(payment);
            }
        }
        return detected;
    }

    /** Drain a source, scanning every vtx it yields. Returns all new detections. */
    async scan(source: VtxSource): Promise<DetectedPayment[]> {
        const detected: DetectedPayment[] = [];
        for await (const vtx of source.vtxs()) {
            detected.push(...this.scanVtx(vtx));
        }
        return detected;
    }

    /** Inbound history for a label — backs a balance view / compliance dashboard. */
    getHistory(label: string): DetectedPayment[] {
        return [...(this.history.get(label) ?? [])];
    }
}
