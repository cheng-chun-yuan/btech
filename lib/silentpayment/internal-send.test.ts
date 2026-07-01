import { describe, it, expect } from "vitest";

import {
    encodeP2TR,
    decodeP2TR,
    generateRecipient,
    encodeSilentPaymentAddress,
} from "./crypto";
import { metaAddress, deriveInternalSend, ingestCandidate } from "./treasury";

// The treasury's live regtest receive address (a real BIP86 key-path P2TR).
const VAULT_ADDR =
    "bcrt1p3xkwaygwesu27n8sh3mvdkghv3yv4k0nx5lw6450uje884s8x8cqw036m4";

describe("P2TR (witness v1) address codec", () => {
    it("round-trips a real bcrt1p address through decode → x-only → encode", () => {
        const xonly = decodeP2TR(VAULT_ADDR);
        expect(xonly).toHaveLength(64); // 32-byte x-only key
        expect(encodeP2TR(xonly, "bcrt")).toBe(VAULT_ADDR);
    });

    it("rejects a non-witness-v1 (segwit v0) address", () => {
        // bcrt1q… is witness v0 — decodeP2TR must refuse it.
        expect(() => decodeP2TR("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080")).toThrow();
    });
});

describe("internal silent send — derive → scanner detects (receiver-side ECDH)", () => {
    const vaultXOnly = decodeP2TR(VAULT_ADDR);
    const outpoints = [
        { txid: "ab".repeat(32), vout: 0 },
        { txid: "cd".repeat(32), vout: 3 },
    ];

    it("derives a P2TR output for the treasury's own published tsp1 address", () => {
        const d = deriveInternalSend({ tsp1: metaAddress(), vaultXOnly, outpoints });
        expect(d).not.toBeNull();
        expect(d!.xonly).toHaveLength(64);
        expect(d!.derivedAddress.startsWith("bcrt1p")).toBe(true);
        expect(d!.k).toBe(0);
        // The derived output is a fresh stealth output, NOT the vault's own key.
        expect(d!.xonly).not.toBe(vaultXOnly);
    });

    it("produces an output the treasury's view-key scanner detects as inbound", () => {
        const d = deriveInternalSend({ tsp1: metaAddress(), vaultXOnly, outpoints })!;
        // Model the broadcast tx exactly as it lands on-chain: same input pubkeys
        // (one even-Y vault key per spent input) and the derived output.
        const detected = ingestCandidate({
            vtxId: "sp-send-test",
            inputs: outpoints.map((o) => ({ userPK: `02${vaultXOnly}`, vtxoId: `${o.txid}:${o.vout}` })),
            outputs: [{ xonly: d.xonly, amount: 1000, leafIndex: 0 }],
        });
        expect(detected).toHaveLength(1);
        expect(detected[0].P).toBe(d.xonly); // the recipient re-derived the same P
        expect(detected[0].leafIndex).toBe(0);
    });

    it("returns null for an external tsp1 whose scan key we do not hold", () => {
        const stranger = generateRecipient();
        const externalTsp1 = encodeSilentPaymentAddress(stranger.meta, "regtest");
        expect(deriveInternalSend({ tsp1: externalTsp1, vaultXOnly, outpoints })).toBeNull();
    });
});
