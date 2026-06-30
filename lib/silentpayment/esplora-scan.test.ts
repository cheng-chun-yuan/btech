/**
 * esplora-scan.test.ts — BIP-352 input eligibility extraction + an end-to-end
 * detection over a mocked chain (no live node).
 */
import { describe, it, expect } from "vitest";
import {
    generateRecipient,
    generateKeyPair,
    viewKeyOf,
    senderDerive,
    evenYCompressed,
} from "./crypto";
import {
    contribPubkey,
    txDetections,
    scanBlocks,
    type EsploraVin,
    type FullTx,
    type TxFetcher,
} from "./esplora-scan";

const NUMS_X = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

function p2trVin(senderPubHex: string, txid: string, vout: number, witness = ["aa".repeat(64)]): EsploraVin {
    const xonly = evenYCompressed(senderPubHex).slice(2);
    return { txid, vout, witness, prevout: { scriptpubkey: "5120" + xonly, scriptpubkey_type: "v1_p2tr" } };
}

describe("contribPubkey — BIP-352 input eligibility", () => {
    it("taproot key-path → even-Y output key", () => {
        const s = generateKeyPair();
        const vin = p2trVin(s.pub, "ab".repeat(32), 0);
        expect(contribPubkey(vin)).toBe(evenYCompressed(s.pub));
    });

    it("taproot NUMS script-path → excluded", () => {
        const s = generateKeyPair();
        const xonly = evenYCompressed(s.pub).slice(2);
        const controlBlock = "c1" + NUMS_X + "ee".repeat(32); // parity ‖ NUMS internal key ‖ merkle node
        const vin: EsploraVin = {
            txid: "ac".repeat(32),
            vout: 0,
            witness: ["aa".repeat(64), "20" + "bb".repeat(32) + "ac", controlBlock],
            prevout: { scriptpubkey: "5120" + xonly, scriptpubkey_type: "v1_p2tr" },
        };
        expect(contribPubkey(vin)).toBeNull();
    });

    it("p2wpkh → witness pubkey", () => {
        const s = generateKeyPair();
        const vin: EsploraVin = {
            txid: "ad".repeat(32),
            vout: 1,
            witness: ["aa".repeat(71), s.pub],
            prevout: { scriptpubkey: "0014" + "cd".repeat(20), scriptpubkey_type: "v0_p2wpkh" },
        };
        expect(contribPubkey(vin)).toBe(s.pub.toLowerCase());
    });

    it("p2pkh → last scriptSig push", () => {
        const s = generateKeyPair();
        const scriptsig = "01" + "00" + "21" + s.pub; // push(dummy sig) ‖ push(33-byte pubkey)
        const vin: EsploraVin = {
            txid: "ae".repeat(32),
            vout: 2,
            scriptsig,
            prevout: { scriptpubkey: "76a914" + "ef".repeat(20) + "88ac", scriptpubkey_type: "p2pkh" },
        };
        expect(contribPubkey(vin)).toBe(s.pub.toLowerCase());
    });

    it("coinbase / unsupported → null", () => {
        expect(contribPubkey({ txid: "00".repeat(32), vout: 0, is_coinbase: true })).toBeNull();
        expect(
            contribPubkey({
                txid: "af".repeat(32),
                vout: 0,
                prevout: { scriptpubkey: "6a04deadbeef", scriptpubkey_type: "op_return" },
            })
        ).toBeNull();
    });
});

describe("scanBlocks — end-to-end detection over a mocked chain", () => {
    it("detects an inbound silent payment in a block", async () => {
        const recip = generateRecipient();
        const sender = generateKeyPair();
        const senderTxid = "ba".repeat(32);
        const out = senderDerive({
            meta: recip.meta,
            spenderPrivs: [sender.priv],
            outpoints: [{ txid: senderTxid, vout: 3 }],
            t: 0,
            taproot: true,
        });

        const tx: FullTx = {
            txid: "fe".repeat(32),
            vin: [p2trVin(sender.pub, senderTxid, 3)],
            vout: [
                { scriptpubkey: "0014" + "11".repeat(20), scriptpubkey_type: "v0_p2wpkh", value: 500 }, // change, ignored
                { scriptpubkey: "5120" + out.xonly, scriptpubkey_type: "v1_p2tr", value: 12345 },
            ],
            status: { confirmed: true, block_height: 7 },
        };

        const fetcher: TxFetcher = {
            tip: async () => 7,
            blockHash: async (h) => (h === 7 ? "blockhash7" : null),
            blockTxids: async (hash) => (hash === "blockhash7" ? [tx.txid] : []),
            getTx: async (id) => (id === tx.txid ? tx : (null as unknown as FullTx)),
        };

        const found = await scanBlocks(viewKeyOf(recip), 7, 7, fetcher);
        expect(found).toEqual([
            { txid: tx.txid, vout: 1, xonly: out.xonly, amount: 12345, k: 0, blockHeight: 7 },
        ]);
    });

    it("txDetections returns nothing for an unrelated tx", () => {
        const recip = generateRecipient();
        const sender = generateKeyPair();
        const tx: FullTx = {
            txid: "dd".repeat(32),
            vin: [p2trVin(sender.pub, "cc".repeat(32), 0)],
            vout: [{ scriptpubkey: "5120" + "99".repeat(32), scriptpubkey_type: "v1_p2tr", value: 1000 }],
        };
        expect(txDetections(viewKeyOf(recip), tx, 9)).toEqual([]);
    });
});
