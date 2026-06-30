/**
 * scan.test.ts — round-trip: a sender derives a silent-payment output, and the
 * view-key counter-loop scanner (scanTx) detects it at the right counter k.
 */
import { describe, it, expect } from "vitest";
import {
    generateRecipient,
    generateKeyPair,
    viewKeyOf,
    senderDerive,
    evenYCompressed,
    scanTx,
    type Outpoint,
} from "./crypto";

describe("scanTx round-trip (sender → view-key scanner)", () => {
    it("detects a single taproot output at k=0", () => {
        const recip = generateRecipient();
        const sender = generateKeyPair();
        const outpoints: Outpoint[] = [{ txid: "aa".repeat(32), vout: 1 }];

        const out = senderDerive({
            meta: recip.meta,
            spenderPrivs: [sender.priv],
            outpoints,
            t: 0,
            taproot: true,
        });

        const decoys = [generateKeyPair().pub.slice(2), generateKeyPair().pub.slice(2)];
        const candidates = [decoys[0], out.xonly, decoys[1]];

        const matches = scanTx(
            viewKeyOf(recip),
            [evenYCompressed(sender.pub)],
            outpoints,
            candidates
        );
        expect(matches).toEqual([{ xonly: out.xonly, k: 0 }]);
    });

    it("detects multiple outputs to the same recipient at k=0,1 and stops", () => {
        const recip = generateRecipient();
        const sender = generateKeyPair();
        const outpoints: Outpoint[] = [
            { txid: "bb".repeat(32), vout: 0 },
            { txid: "cc".repeat(32), vout: 7 },
        ];
        const o0 = senderDerive({ meta: recip.meta, spenderPrivs: [sender.priv], outpoints, t: 0, taproot: true });
        const o1 = senderDerive({ meta: recip.meta, spenderPrivs: [sender.priv], outpoints, t: 1, taproot: true });

        const matches = scanTx(
            viewKeyOf(recip),
            [evenYCompressed(sender.pub)],
            outpoints,
            [o1.xonly, generateKeyPair().pub.slice(2), o0.xonly] // order shouldn't matter
        );
        expect(new Set(matches.map((m) => m.xonly))).toEqual(new Set([o0.xonly, o1.xonly]));
        expect(matches.map((m) => m.k).sort()).toEqual([0, 1]);
    });

    it("returns nothing for an unrelated recipient", () => {
        const recip = generateRecipient();
        const other = generateRecipient();
        const sender = generateKeyPair();
        const outpoints: Outpoint[] = [{ txid: "dd".repeat(32), vout: 2 }];
        const out = senderDerive({ meta: recip.meta, spenderPrivs: [sender.priv], outpoints, t: 0, taproot: true });

        const matches = scanTx(viewKeyOf(other), [evenYCompressed(sender.pub)], outpoints, [out.xonly]);
        expect(matches).toEqual([]);
    });

    it("returns nothing with no eligible inputs", () => {
        const recip = generateRecipient();
        expect(scanTx(viewKeyOf(recip), [], [{ txid: "ee".repeat(32), vout: 0 }], ["00".repeat(32)])).toEqual([]);
    });
});
