/**
 * silentpayment/crypto.ts — BIP-352-style silent payments for Arkade VTXOs.
 *
 * Off-chain adaptation of BIP-352: the replay nonce is the spent VTXO's canonical
 * `vtxoId` (uniqueness enforced by the operator's single-spend rule) instead of an
 * on-chain outpoint, and the per-output counter `t` is the leaf index inside the
 * funding vtx. Inputs are aggregated (BIP-352 multi-input): single-input is n=1.
 *
 *   A_sum      = Σ Aᵢ
 *   input_hash = H( min(vtxoId) ‖ A_sum )
 *   ecdh       = input_hash · a_sum · B_scan   (sender)
 *              = input_hash · b_scan · A_sum    (scanner / recipient)
 *   P          = B_spend + H( ecdh ‖ t ) · G
 *   p          = b_spend + H( ecdh ‖ t )   (mod n),  with  p·G == P
 *
 * Ported from the proven `arkade-try/stealth.ts`. Pure secp256k1 + sha256; no
 * SDK/provider/network deps. Pubkeys are 33-byte compressed hex; the x-only form
 * (taproot output key) is taken at the scanner boundary, not here.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";

type ProjPoint = ReturnType<typeof secp256k1.Point.fromBytes>;

const Point = secp256k1.Point;
const G = Point.BASE;
/** secp256k1 group order n. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// ── scalar / point helpers ──────────────────────────────────────────────────

/** Reduce into the scalar field [0, n). */
function modN(x: bigint): bigint {
    return ((x % N) + N) % N;
}

/** Big-endian bytes -> bigint. */
function bytesToBigInt(b: Uint8Array): bigint {
    return BigInt("0x" + (bytesToHex(b) || "0"));
}

/** Hash bytes -> nonzero scalar in [1, n). */
function hashToScalar(...parts: Uint8Array[]): bigint {
    const s = modN(bytesToBigInt(sha256(concatBytes(...parts))));
    return s === 0n ? 1n : s;
}

/** 4-byte big-endian encoding of an output index / label. */
function serT(t: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, t >>> 0, false);
    return b;
}

const compressed = (p: ProjPoint): Uint8Array => p.toBytes(true);
const pointFromHex = (h: string): ProjPoint => Point.fromBytes(hexToBytes(h));

/**
 * BIP-352 taproot-input handling: inputs are x-only (even-Y) taproot keys, so
 * each input contributes its even-Y form. Normalize a scalar so its pubkey has
 * even Y (negate to n−a if odd); lift a pubkey to its even-Y point (negate if
 * odd). Both sides agree because `evenYScalar(a)·G == evenYPoint(a·G)`.
 */
function evenYScalar(a: bigint): bigint {
    const s = modN(a);
    return G.multiply(s).toBytes(true)[0] === 3 ? modN(N - s) : s;
}
function evenYPoint(pubHex: string): ProjPoint {
    const p = pointFromHex(pubHex);
    return p.toBytes(true)[0] === 3 ? p.negate() : p;
}

/** 32 secure-random bytes as a nonzero scalar. */
function randScalar(): bigint {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    const s = modN(bytesToBigInt(b));
    return s === 0n ? 1n : s;
}

// ── keys & meta-address ─────────────────────────────────────────────────────

export interface KeyPair {
    priv: bigint;
    pub: string; // 33-byte compressed hex
}

export interface MetaAddress {
    bScanPub: string; // B_scan  (33-byte compressed hex)
    bSpendPub: string; // B_spend (33-byte compressed hex)
}

/** Full recipient key material (kept private; never published). */
export interface RecipientKeys {
    scan: KeyPair; // (b_scan, B_scan) — also the view key secret
    spend: KeyPair; // (b_spend, B_spend)
    meta: MetaAddress;
}

/** The view key: scan secret + spend *public* key. Detect-only — never carries b_spend. */
export interface ViewKey {
    bScan: bigint;
    bSpendPub: string;
}

function keyPairFrom(priv: bigint): KeyPair {
    const p = modN(priv) === 0n ? 1n : modN(priv);
    return { priv: p, pub: bytesToHex(compressed(G.multiply(p))) };
}

export function generateKeyPair(): KeyPair {
    return keyPairFrom(randScalar());
}

export function generateRecipient(): RecipientKeys {
    const scan = generateKeyPair();
    const spend = generateKeyPair();
    return { scan, spend, meta: { bScanPub: scan.pub, bSpendPub: spend.pub } };
}

/** Derive a recipient deterministically from a 32-byte seed (for seed recovery). */
export function recipientFromSeed(seed: Uint8Array): RecipientKeys {
    const scan = keyPairFrom(
        hashToScalar(seed, new TextEncoder().encode("scan"))
    );
    const spend = keyPairFrom(
        hashToScalar(seed, new TextEncoder().encode("spend"))
    );
    return { scan, spend, meta: { bScanPub: scan.pub, bSpendPub: spend.pub } };
}

/** Extract the detect-only view key from full recipient material. */
export function viewKeyOf(r: RecipientKeys): ViewKey {
    return { bScan: r.scan.priv, bSpendPub: r.meta.bSpendPub };
}

/** Hex-encode a meta-address as B_scan‖B_spend (66 bytes -> 132 hex chars). */
export function encodeMetaAddress(m: MetaAddress): string {
    return m.bScanPub + m.bSpendPub;
}

/** Decode a hex meta-address. */
export function decodeMetaAddress(hex: string): MetaAddress {
    if (hex.length !== 132)
        throw new Error("meta-address must be 132 hex chars (66 bytes)");
    return { bScanPub: hex.slice(0, 66), bSpendPub: hex.slice(66) };
}

// ── multi-input shared secret ───────────────────────────────────────────────

/** Lexicographically smallest vtxoId — the canonical replay nonce for a tx. */
function minNonce(vtxoIds: string[]): string {
    if (vtxoIds.length === 0)
        throw new Error("multi-input: at least one input required");
    return vtxoIds.slice().sort()[0]!;
}

/** Sum compressed-hex pubkeys into A_sum (a point). */
function sumPoints(pubs: string[]): ProjPoint {
    if (pubs.length === 0)
        throw new Error("multi-input: at least one input pubkey required");
    return pubs.map(evenYPoint).reduce((acc, p) => acc.add(p));
}

/** Sum input pubkeys → A_sum as compressed hex. */
export function sumPubkeys(pubs: string[]): string {
    return bytesToHex(compressed(sumPoints(pubs)));
}

/** input_hash for an aggregated tx: H( min(vtxoId) ‖ A_sum ). */
function aggInputHash(nonce: string, aSumPub: Uint8Array): bigint {
    return hashToScalar(new TextEncoder().encode(nonce), aSumPub);
}

/** The per-output tweak scalar k = H( ecdh ‖ t ). */
function outputTweak(ecdh: ProjPoint, t: number): bigint {
    return hashToScalar(compressed(ecdh), serT(t));
}

// ── sender ──────────────────────────────────────────────────────────────────

export interface SenderDeriveParams {
    meta: MetaAddress;
    spenderPrivs: bigint[]; // aᵢ — all input secrets the sender controls
    inputVtxoIds: string[]; // vtxoId per input
    t: number; // output leafIndex inside the funding vtx
}

export interface DerivedOutput {
    P: string; // 33-byte compressed hex — the stealth pubkey to fund as userPK
    t: number;
}

/** Sender: derive the one-time stealth pubkey P to fund VTXO(P). */
export function senderDerive(p: SenderDeriveParams): DerivedOutput {
    const aSum = modN(p.spenderPrivs.reduce((s, x) => s + evenYScalar(x), 0n));
    const aSumPub = compressed(G.multiply(aSum));
    const ih = aggInputHash(minNonce(p.inputVtxoIds), aSumPub);
    const ecdh = pointFromHex(p.meta.bScanPub).multiply(modN(ih * aSum));
    const k = outputTweak(ecdh, p.t);
    const P = pointFromHex(p.meta.bSpendPub).add(G.multiply(k));
    return { P: bytesToHex(compressed(P)), t: p.t };
}

// ── scanner (view key only — detect, cannot spend) ──────────────────────────

export interface ScanParams {
    viewKey: ViewKey;
    senderPubs: string[]; // Aᵢ — every input pubkey revealed in the vtx
    inputVtxoIds: string[];
    t: number;
}

/** Recompute the expected P for a candidate output using only the view key. */
export function expectedP(p: ScanParams): string {
    const ASum = sumPoints(p.senderPubs);
    const ih = aggInputHash(minNonce(p.inputVtxoIds), compressed(ASum));
    const ecdh = ASum.multiply(modN(ih * modN(p.viewKey.bScan)));
    const k = outputTweak(ecdh, p.t);
    const P = pointFromHex(p.viewKey.bSpendPub).add(G.multiply(k));
    return bytesToHex(compressed(P));
}

/** True iff the candidate compressed-hex output pubkey belongs to this view key. */
export function scanMatches(p: ScanParams, candidateP: string): boolean {
    return expectedP(p) === candidateP.toLowerCase();
}

/** x-only (32-byte hex) form of a 33-byte compressed pubkey — the taproot output key. */
export function toXOnly(compressedHex: string): string {
    if (compressedHex.length !== 66)
        throw new Error("expected 33-byte compressed hex");
    return compressedHex.slice(2);
}

/** True iff the candidate x-only (taproot) output key belongs to this view key. */
export function scanMatchesXOnly(
    p: ScanParams,
    candidateXOnly: string
): boolean {
    return toXOnly(expectedP(p)) === candidateXOnly.toLowerCase();
}

// ── recipient (full keys — derive the spend key) ────────────────────────────

export interface SpendKeyParams {
    scanPriv: bigint; // b_scan
    spendPriv: bigint; // b_spend
    senderPubs: string[]; // Aᵢ
    inputVtxoIds: string[];
    t: number;
}

/** Recipient: derive the one-time spend secret p with p·G == P. */
export function recipientSpendKey(p: SpendKeyParams): {
    priv: bigint;
    pub: string;
} {
    const ASum = sumPoints(p.senderPubs);
    const ih = aggInputHash(minNonce(p.inputVtxoIds), compressed(ASum));
    const ecdh = ASum.multiply(modN(ih * modN(p.scanPriv)));
    const k = outputTweak(ecdh, p.t);
    const priv = modN(modN(p.spendPriv) + k);
    return { priv, pub: bytesToHex(compressed(G.multiply(priv))) };
}

export const _internal = { modN, hashToScalar, G, N, minNonce, sumPoints };
