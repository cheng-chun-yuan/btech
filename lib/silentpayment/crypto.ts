/**
 * silentpayment/crypto.ts — BIP-352 silent payments, shared by Bitcoin L1 and
 * Arkade VTXOs.
 *
 * Byte-compatible with BIP-352 (tagged hashes, outpoint serialization, `sp1`
 * bech32m addresses) — validated against the official test vectors — so ONE
 * published address receives silent payments on either rail. The only thing that
 * differs by venue is where the input outpoint comes from:
 *   - L1:     the spent UTXO's outpoint   (uniqueness from the blockchain)
 *   - Arkade: the spent VTXO's outpoint   (uniqueness from the operator's single-spend)
 *
 *   input_hash = H_tag("BIP0352/Inputs",       outpoint_smallest ‖ A_sum)
 *   ecdh       = input_hash · a_sum · B_scan   (sender)
 *              = input_hash · b_scan · A_sum    (scanner / recipient)
 *   t_k        = H_tag("BIP0352/SharedSecret", ser_p(ecdh) ‖ ser32(k))
 *   P_k        = B_spend + t_k·G,  spent with  p = b_spend + t_k  (p·G == P_k)
 *
 * Taproot inputs contribute their even-Y key (BIP-352 §Inputs For Shared Secret
 * Derivation); set `taproot: false` for non-taproot inputs (e.g. P2PKH/P2WPKH).
 * Pure secp256k1 + sha256; no SDK/provider/network deps.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";
import { bech32m } from "@scure/base";

type ProjPoint = ReturnType<typeof secp256k1.Point.fromBytes>;

const Point = secp256k1.Point;
const G = Point.BASE;
/** secp256k1 group order n. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// ── scalar / point helpers ──────────────────────────────────────────────────

function modN(x: bigint): bigint {
    return ((x % N) + N) % N;
}
function toBig(b: Uint8Array): bigint {
    return BigInt("0x" + (bytesToHex(b) || "0"));
}
/** BIP-340 tagged hash: sha256(sha256(tag) ‖ sha256(tag) ‖ msg). */
function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
    const t = sha256(new TextEncoder().encode(tag));
    return sha256(concatBytes(t, t, msg));
}
/** 4-byte big-endian counter (the BIP-352 output index k). */
function ser32(k: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, k >>> 0, false);
    return b;
}

const compressed = (p: ProjPoint): Uint8Array => p.toBytes(true);
const pointFromHex = (h: string): ProjPoint => Point.fromBytes(hexToBytes(h));

function randScalar(): bigint {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    const s = modN(toBig(b));
    return s === 0n ? 1n : s;
}

/** Even-Y normalization for taproot inputs: scalar -> n−a if a·G is odd-Y. */
function evenYScalar(a: bigint): bigint {
    const s = modN(a);
    return G.multiply(s).toBytes(true)[0] === 3 ? modN(N - s) : s;
}
/** Even-Y normalization for taproot inputs: lift a pubkey to its even-Y point. */
function evenYPoint(pubHex: string): ProjPoint {
    const p = pointFromHex(pubHex);
    return p.toBytes(true)[0] === 3 ? p.negate() : p;
}

// ── outpoints (the per-venue replay nonce) ──────────────────────────────────

export interface Outpoint {
    txid: string; // display-order hex (as shown in explorers / SDK)
    vout: number;
}

/** Parse a "txid:vout" id (e.g. an Arkade vtxoId) into an Outpoint. */
export function parseOutpoint(id: string): Outpoint {
    const i = id.lastIndexOf(":");
    return { txid: id.slice(0, i), vout: Number(id.slice(i + 1)) };
}

/** Serialize an outpoint as in a Bitcoin tx: txid (internal byte order) ‖ vout (LE). */
function serOutpoint(o: Outpoint): Uint8Array {
    const txid = hexToBytes(o.txid).slice().reverse();
    const vout = new Uint8Array(4);
    new DataView(vout.buffer).setUint32(0, o.vout >>> 0, true);
    return concatBytes(txid, vout);
}

/** The lexicographically smallest serialized outpoint among the inputs. */
function smallestOutpoint(outpoints: Outpoint[]): Uint8Array {
    if (outpoints.length === 0)
        throw new Error("silent payment: at least one input required");
    return outpoints
        .map(serOutpoint)
        .sort((a, b) => (bytesToHex(a) < bytesToHex(b) ? -1 : 1))[0]!;
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
export interface RecipientKeys {
    scan: KeyPair;
    spend: KeyPair;
    meta: MetaAddress;
}
/** Detect-only view key: scan secret + spend *public* key. Never carries b_spend. */
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
export function recipientFromSeed(seed: Uint8Array): RecipientKeys {
    const enc = new TextEncoder();
    const scan = keyPairFrom(
        modN(toBig(sha256(concatBytes(seed, enc.encode("scan")))))
    );
    const spend = keyPairFrom(
        modN(toBig(sha256(concatBytes(seed, enc.encode("spend")))))
    );
    return { scan, spend, meta: { bScanPub: scan.pub, bSpendPub: spend.pub } };
}
export function viewKeyOf(r: RecipientKeys): ViewKey {
    return { bScan: r.scan.priv, bSpendPub: r.meta.bSpendPub };
}

/** Hex meta-address B_scan‖B_spend (internal). Prefer the `sp1` form for publishing. */
export function encodeMetaAddress(m: MetaAddress): string {
    return m.bScanPub + m.bSpendPub;
}
export function decodeMetaAddress(hex: string): MetaAddress {
    if (hex.length !== 132)
        throw new Error("meta-address must be 132 hex chars (66 bytes)");
    return { bScanPub: hex.slice(0, 66), bSpendPub: hex.slice(66) };
}

// ── BIP-352 `sp1` bech32m address (the published, cross-rail form) ───────────

function hrpFor(network: string): string {
    return network === "bitcoin" || network === "mainnet" ? "sp" : "tsp";
}
/** Encode a meta-address as a BIP-352 `sp1…`/`tsp1…` address. */
export function encodeSilentPaymentAddress(
    m: MetaAddress,
    network = "bitcoin"
): string {
    const payload = concatBytes(
        hexToBytes(m.bScanPub),
        hexToBytes(m.bSpendPub)
    );
    const words = [0, ...bech32m.toWords(payload)]; // version 0 ‖ B_scan‖B_spend
    return bech32m.encode(hrpFor(network) as "sp", words, 1023);
}
/** Decode a BIP-352 `sp1…`/`tsp1…` address into a meta-address. */
export function decodeSilentPaymentAddress(addr: string): MetaAddress {
    const { words } = bech32m.decode(addr as `sp1${string}`, 1023);
    const payload = bech32m.fromWords(words.slice(1)); // drop version word
    if (payload.length !== 66)
        throw new Error("sp address payload must be 66 bytes");
    return {
        bScanPub: bytesToHex(payload.slice(0, 33)),
        bSpendPub: bytesToHex(payload.slice(33, 66)),
    };
}

// ── BIP-341 P2TR (witness v1) address — the on-chain form of a derived output ──
// A BIP-352 derived output `P_k` is used DIRECTLY as the taproot output key (no
// extra BIP341 tweak), so `x(P_k)` IS the scriptPubKey key. These encode/decode
// that x-only key as the `bc1p…`/`tb1p…`/`bcrt1p…` address vaultd pays / spends.

/** Encode a 32-byte x-only taproot output key as a witness-v1 (P2TR) address.
 * `hrp`: "bc" mainnet · "tb" testnet/signet · "bcrt" regtest. */
export function encodeP2TR(xonlyHex: string, hrp = "bcrt"): string {
    const program = hexToBytes(xonlyHex);
    if (program.length !== 32)
        throw new Error("p2tr program must be 32 bytes (x-only)");
    return bech32m.encode(hrp as "bc", [1, ...bech32m.toWords(program)], 1023); // leading word 1 = witness v1
}
/** Decode a witness-v1 (P2TR) address into its 32-byte x-only output key (hex). */
export function decodeP2TR(addr: string): string {
    const { words } = bech32m.decode(addr as `bc1${string}`, 1023);
    if (words[0] !== 1) throw new Error("not a witness-v1 (P2TR) address");
    const program = bech32m.fromWords(words.slice(1));
    if (program.length !== 32) throw new Error("p2tr program must be 32 bytes");
    return bytesToHex(program);
}

// ── BIP-352 shared secret ───────────────────────────────────────────────────

function aSum(privs: bigint[], taproot: boolean): bigint {
    return modN(
        privs.reduce((s, a) => s + (taproot ? evenYScalar(a) : modN(a)), 0n)
    );
}
function aSumPoint(pubs: string[], taproot: boolean): ProjPoint {
    if (pubs.length === 0)
        throw new Error("silent payment: at least one input pubkey required");
    return pubs
        .map((p) => (taproot ? evenYPoint(p) : pointFromHex(p)))
        .reduce((acc, p) => acc.add(p));
}
function inputHash(outpoints: Outpoint[], aSumPub: Uint8Array): bigint {
    return modN(
        toBig(
            taggedHash(
                "BIP0352/Inputs",
                concatBytes(smallestOutpoint(outpoints), aSumPub)
            )
        )
    );
}
function outputTweak(ecdh: ProjPoint, k: number): bigint {
    return modN(
        toBig(
            taggedHash(
                "BIP0352/SharedSecret",
                concatBytes(compressed(ecdh), ser32(k))
            )
        )
    );
}

/** Sum input pubkeys → A_sum as compressed hex (even-Y per taproot input). */
export function sumPubkeys(pubs: string[], taproot = true): string {
    return bytesToHex(compressed(aSumPoint(pubs, taproot)));
}

// ── sender ──────────────────────────────────────────────────────────────────

export interface SenderDeriveParams {
    meta: MetaAddress;
    spenderPrivs: bigint[]; // aᵢ — the spent inputs' secrets
    outpoints: Outpoint[]; // the spent inputs' outpoints (UTXO or VTXO)
    t: number; // output counter k
    taproot?: boolean; // inputs are taproot (default true; Arkade VTXOs always are)
}
export interface DerivedOutput {
    P: string; // 33-byte compressed hex
    xonly: string; // 32-byte x-only hex (the taproot output key)
    t: number;
}

export function senderDerive(p: SenderDeriveParams): DerivedOutput {
    const taproot = p.taproot ?? true;
    const a = aSum(p.spenderPrivs, taproot);
    const aPub = compressed(G.multiply(a));
    const ih = inputHash(p.outpoints, aPub);
    const ecdh = pointFromHex(p.meta.bScanPub).multiply(modN(ih * a));
    const tk = outputTweak(ecdh, p.t);
    const P = pointFromHex(p.meta.bSpendPub).add(G.multiply(tk));
    const hex = bytesToHex(compressed(P));
    return { P: hex, xonly: hex.slice(2), t: p.t };
}

// ── scanner (view key only — detect, cannot spend) ──────────────────────────

export interface ScanParams {
    viewKey: ViewKey;
    senderPubs: string[]; // Aᵢ — the input pubkeys revealed in the tx
    outpoints: Outpoint[];
    t: number;
    taproot?: boolean;
}

export function expectedP(p: ScanParams): string {
    const taproot = p.taproot ?? true;
    const ASum = aSumPoint(p.senderPubs, taproot);
    const ih = inputHash(p.outpoints, compressed(ASum));
    const ecdh = ASum.multiply(modN(ih * modN(p.viewKey.bScan)));
    const tk = outputTweak(ecdh, p.t);
    const P = pointFromHex(p.viewKey.bSpendPub).add(G.multiply(tk));
    return bytesToHex(compressed(P));
}

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

/** Even-Y compressed form of a pubkey — the BIP-352 contribution of a taproot input. */
export function evenYCompressed(pubHex: string): string {
    return bytesToHex(compressed(evenYPoint(pubHex)));
}

/** Maximum per-transaction outputs we probe for one recipient (BIP-352 counter cap). */
const SCAN_K_MAX = 100;

/**
 * Scan one transaction for a view key using the proper BIP-352 counter loop:
 * compute `P_k` for k = 0,1,… and match against the tx's taproot output keys,
 * incrementing k only while a match is found. `contribPubsEvenY` are the already
 * eligibility-filtered, even-Y-normalized input pubkeys (so pass `taproot:false`
 * here — normalization is the caller's job); `outpoints` are ALL tx inputs'
 * outpoints (BIP-352 uses the smallest across the whole tx).
 */
export function scanTx(
    viewKey: ViewKey,
    contribPubsEvenY: string[],
    outpoints: Outpoint[],
    candidateXOnlys: string[]
): Array<{ xonly: string; k: number }> {
    if (contribPubsEvenY.length === 0 || candidateXOnlys.length === 0) return [];
    const remaining = new Set(candidateXOnlys.map((x) => x.toLowerCase()));
    const matches: Array<{ xonly: string; k: number }> = [];
    for (let k = 0; k < SCAN_K_MAX && remaining.size > 0; k++) {
        const x = toXOnly(
            expectedP({
                viewKey,
                senderPubs: contribPubsEvenY,
                outpoints,
                t: k,
                taproot: false,
            })
        );
        if (!remaining.has(x)) break; // stop at first miss (BIP-352 multi-output rule)
        remaining.delete(x);
        matches.push({ xonly: x, k });
    }
    return matches;
}

// ── recipient (full keys — derive the spend key) ────────────────────────────

export interface SpendKeyParams {
    scanPriv: bigint;
    spendPriv: bigint;
    senderPubs: string[];
    outpoints: Outpoint[];
    t: number;
    taproot?: boolean;
}

export function recipientSpendKey(p: SpendKeyParams): {
    priv: bigint;
    pub: string;
} {
    const taproot = p.taproot ?? true;
    const ASum = aSumPoint(p.senderPubs, taproot);
    const ih = inputHash(p.outpoints, compressed(ASum));
    const ecdh = ASum.multiply(modN(ih * modN(p.scanPriv)));
    const tk = outputTweak(ecdh, p.t);
    const priv = modN(modN(p.spendPriv) + tk);
    return { priv, pub: bytesToHex(compressed(G.multiply(priv))) };
}

export const _internal = {
    modN,
    G,
    N,
    taggedHash,
    serOutpoint,
    smallestOutpoint,
};
