"use client";

import { useEffect, useState } from "react";
import { C, MONO } from "../lib/theme";

// ===========================================================================
// Vault balance — live on-chain balance for the receive address, shown in the
// chat header right under the address (no separate "Shared vault" card).
// ===========================================================================

export function VaultBalance({ address }: { address: string }) {
  const [chain, setChain] = useState<{ totalSats: number; confirmedSats: number; mempoolSats: number } | null>(null);
  const [chainErr, setChainErr] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setChain(null);
    setChainErr(false);
    fetch(`/api/chain/address/${address}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("chain"))))
      .then((d) => !cancelled && setChain(d))
      .catch(() => !cancelled && setChainErr(true));
    return () => {
      cancelled = true;
    };
  }, [address]);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10.5, color: C.faint2, letterSpacing: ".3px" }}>On-chain balance · regtest</div>
      <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 600, color: chain && chain.totalSats > 0 ? C.green : "#C5C9CE", marginTop: 2 }}>
        {chain
          ? `${(chain.totalSats / 1e8).toFixed(8)} BTC`
          : chainErr
            ? "—"
            : "checking…"}
        {chain && chain.mempoolSats > 0 && (
          <span style={{ color: C.sand, fontSize: 12, fontWeight: 400 }}> ({(chain.mempoolSats / 1e8).toFixed(8)} pending)</span>
        )}
      </div>
    </div>
  );
}
