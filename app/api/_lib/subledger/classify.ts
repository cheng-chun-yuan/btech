// classify.ts — §4 classification rule. Derives classification / measurement /
// monetary from the config INPUTS (is_stablecoin, redeemable_unconditional) so a
// future reclassification (e.g. USDC -> FVTPL once a stablecoin becomes
// unconditionally redeemable) is a one-flag config change, not a code change
// (INV-5). cost_flow and the intangible measurement default pass through.

import { getAssetConfig, type DB } from "./store";
import type { AssetConfig } from "./types";

export function classify(db: DB, asset: string): AssetConfig {
  const cfg = getAssetConfig(db, asset);
  if (!cfg) throw new Error(`subledger: no AssetConfig for ${asset} (§4/§10)`);

  // No issuer (BTC/ETH/native) — cannot be a financial asset or cash: IAS 38.
  if (!cfg.is_stablecoin) {
    return {
      ...cfg,
      classification: "INTANGIBLE_IAS38",
      measurement: cfg.measurement === "FVTPL" ? "COST_MODEL" : cfg.measurement,
      monetary: false,
    };
  }

  // Stablecoin (has issuer). Unconditional redemption right (legislated, issuer
  // has no discretion) -> financial asset at FVTPL; otherwise IAS 38 (current).
  if (cfg.redeemable_unconditional) {
    return { ...cfg, classification: "FINANCIAL_FVTPL", measurement: "FVTPL", monetary: true };
  }
  return {
    ...cfg,
    classification: "INTANGIBLE_IAS38",
    measurement: cfg.measurement === "FVTPL" ? "COST_MODEL" : cfg.measurement,
    monetary: false,
  };
}
