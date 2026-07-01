import { describe, it, expect, beforeEach } from "vitest";
import {
  metaAddress,
  scanChainOnce,
  getInbox,
  __resetOnchainForTest,
} from "./treasury";
import {
  decodeSilentPaymentAddress,
  generateKeyPair,
  senderDerive,
  evenYCompressed,
} from "./crypto";
import type { FullTx, TxFetcher } from "./esplora-scan";

/** A regtest tx paying the treasury tsp1 at output index 1 (index 0 = change). */
function payTreasuryTx(): { tx: FullTx; amount: number; xonly: string } {
  const meta = decodeSilentPaymentAddress(metaAddress());
  const sender = generateKeyPair();
  const senderTxid = "ba".repeat(32);
  const out = senderDerive({ meta, spenderPrivs: [sender.priv], outpoints: [{ txid: senderTxid, vout: 3 }], t: 0, taproot: true });
  const amount = 99_000;
  const tx: FullTx = {
    txid: "fe".repeat(32),
    vin: [{ txid: senderTxid, vout: 3, witness: ["aa".repeat(64)], prevout: { scriptpubkey: "5120" + evenYCompressed(sender.pub).slice(2), scriptpubkey_type: "v1_p2tr" } }],
    vout: [
      { scriptpubkey: "0014" + "11".repeat(20), scriptpubkey_type: "v0_p2wpkh", value: 500 },
      { scriptpubkey: "5120" + out.xonly, scriptpubkey_type: "v1_p2tr", value: amount },
    ],
    status: { confirmed: true, block_height: 7 },
  };
  return { tx, amount, xonly: out.xonly };
}

function fetcherFor(tx: FullTx, tip: number): TxFetcher {
  return {
    tip: async () => tip,
    blockHash: async (h) => (h === (tx.status?.block_height ?? -1) ? `hash${h}` : null),
    blockTxids: async (hash) => (hash === `hash${tx.status?.block_height}` ? [tx.txid] : []),
    getTx: async (id) => (id === tx.txid ? tx : (null as unknown as FullTx)),
  };
}

describe("treasury on-chain scan", () => {
  beforeEach(() => __resetOnchainForTest());

  it("detects a real on-chain payment and surfaces it as an onchain inbox item", async () => {
    const { tx, amount, xonly } = payTreasuryTx();
    const fresh = await scanChainOnce(fetcherFor(tx, 7));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ source: "onchain", P: xonly, amount, txid: tx.txid, vout: 1, blockHeight: 7 });
    const inbox = getInbox();
    expect(inbox.some((i) => i.source === "onchain" && i.txid === tx.txid && i.P === xonly)).toBe(true);
  });

  it("is idempotent — a second scan of the same tip adds nothing", async () => {
    const { tx } = payTreasuryTx();
    await scanChainOnce(fetcherFor(tx, 7));
    const again = await scanChainOnce(fetcherFor(tx, 7));
    expect(again).toEqual([]);
  });
});
