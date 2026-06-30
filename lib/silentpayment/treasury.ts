/**
 * treasury.ts — the demo treasury's stealth receiver (server-side singleton).
 *
 * Holds one recipient (scan + spend), publishes its static meta-address, and runs
 * a detect-only SilentPaymentScanner over the view key. Inbound stealth payments
 * (modelled as the operator/sidecar would stream them) are detected with the view
 * key alone — the treasury never learns P in advance.
 */
import {
    generateRecipient,
    generateKeyPair,
    viewKeyOf,
    encodeMetaAddress,
    senderDerive,
    toXOnly,
    type RecipientKeys,
} from "./crypto";
import {
    SilentPaymentScanner,
    type DetectedPayment,
    type CandidateVtx,
} from "./scanner";

const LABEL = "treasury";

// One treasury for the demo. (In production this is the FROST group key as
// B_spend + a delegated scan key; here a generated recipient stands in.)
const treasury: RecipientKeys = generateRecipient();
const scanner = new SilentPaymentScanner();
scanner.registerViewKey(LABEL, viewKeyOf(treasury));

export function metaAddress(): string {
    return encodeMetaAddress(treasury.meta);
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
    const vtxoId = `vtxo:${sender.pub.slice(2, 14)}:0`;
    const amount = 1000 * (1 + Math.floor(Math.random() * 200));
    const { P } = senderDerive({
        meta: treasury.meta,
        spenderPrivs: [sender.priv],
        inputVtxoIds: [vtxoId],
        t: 0,
    });
    const candidate: CandidateVtx = {
        vtxId: `ark:${sender.pub.slice(2, 14)}`,
        inputs: [{ userPK: sender.pub, vtxoId }],
        outputs: [{ xonly: toXOnly(P), amount, leafIndex: 0 }],
    };
    return ingestCandidate(candidate)[0] ?? null;
}
