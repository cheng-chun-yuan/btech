// types.ts — domain model (§2), chart-of-accounts keys (§3), and CONFIG defaults
// (§4/§10) for the crypto accounting subledger.
//
// Wire shapes (the inbound `SubledgerEvent`) carry decimals as STRINGS so no
// precision is lost before the engine parses them to bigint minor units.

// ---- Events (§2, §6) -------------------------------------------------------

export type EventType =
  | "RECEIVE_NONCASH"
  | "RECEIVE_SETTLE_AR"
  | "PAY_SUPPLIER"
  | "OFFRAMP"
  | "ONRAMP"
  | "BUY"
  | "SELL"
  | "GAS"
  | "INTERNAL_TRANSFER"
  | "PERIODEND_REVALUE";

/** Inbound event (decimals as strings). One per settlement/chain/custody fact. */
export interface SubledgerEvent {
  event_id: string;
  type: EventType;
  /** ISO-8601 UTC, second precision. */
  timestamp: string;
  wallet_id: string;
  asset: string;
  /** Decimal string, > 0 for asset moves. */
  qty: string;
  counterparty?: string | null;
  /** Required when the type links to AR/AP (§8). */
  invoice_no?: string | null;
  /** Required for on-chain moves (§8). */
  tx_hash?: string | null;
  fee_gas?: string | null;
  /** Economic inputs supplied by the source system for some event types. */
  proceeds_twd?: string | null; // SELL / OFFRAMP bank proceeds
  settle_amount_usd?: string | null; // RECEIVE_SETTLE_AR / PAY_SUPPLIER value settled
  cogs_twd?: string | null; // RECEIVE_NONCASH cost of goods sold
  /** Destination address of a send; if it is an own address -> internal (B). */
  dest_address?: string | null;
}

// ---- Classification & measurement config (§4, §10) -------------------------

export type Classification =
  | "INTANGIBLE_IAS38"
  | "FINANCIAL_FVTPL"
  | "CASH_EQUIV_IAS7";

export type Measurement = "COST_MODEL" | "REVALUATION" | "FVTPL";
export type CostFlow = "FIFO" | "WEIGHTED_AVG";

export interface AssetConfig {
  asset: string;
  classification: Classification;
  measurement: Measurement;
  monetary: boolean;
  /** Has an issuer (e.g. USDC/USDT) vs native crypto (BTC/ETH) — drives §4. */
  is_stablecoin: boolean;
  /** Issuer has NO redemption discretion -> drives classify() (§4). */
  redeemable_unconditional: boolean;
  cost_flow: CostFlow;
}

/** Provenance of a config/policy value — surfaced, never silently hardcoded. */
export type PolicyStatus =
  | "DECIDED"
  | "DEFAULT_PENDING_INTERNAL"
  | "PENDING_DELOITTE";

export interface PolicyParam {
  key: string;
  value: string;
  status: PolicyStatus;
}

// ---- Cost layers, journals, monetary items, prices (§2) --------------------

export interface Lot {
  lot_id: string;
  wallet_id: string;
  asset: string;
  acquire_date: string; // YYYY-MM-DD
  /** USD/TWD rate at acquisition, LOCKED (INV-7). Decimal string at FX_SCALE. */
  acquire_fx_rate: string;
  /** Quantities are decimal strings at the asset's native scale. */
  qty: string;
  remaining_qty: string;
  /**
   * Total original cost basis in TWD (TWD_INTERNAL_SCALE) and the unconsumed
   * remainder. Storing the total (not a unit cost) lets disposals allocate the
   * basis proportionally with no rounding drift, so subledger basis == GL credit
   * exactly (INV-4). unit_cost for display = cost_twd / qty.
   */
  cost_twd: string;
  remaining_cost_twd: string;
  /** Accumulated impairment in TWD (>= 0), TWD_INTERNAL_SCALE. */
  accum_impairment_twd: string;
}

export type DrCr = "DR" | "CR";
export type Gaap = "TIFRS" | "US_GAAP";
export type JournalStatus = "posted" | "reversed";

export interface JournalLine {
  dr_cr: DrCr;
  account: CoaKey;
  /** TWD at TWD_POSTING_SCALE. */
  amount_twd: string;
  asset?: string;
  qty?: string;
  orig_ccy?: string;
  orig_amount?: string;
  tx_hash?: string | null;
  memo?: string;
}

export interface JournalEntry {
  je_id: string;
  event_id: string;
  period: string; // YYYY-MM
  status: JournalStatus;
  gaap: Gaap;
  lines: JournalLine[];
  /** je_id this entry reverses (corrections, INV-3). */
  reverses?: string | null;
}

export type MonetaryKind = "AR" | "AP";

export interface MonetaryItem {
  doc_no: string;
  kind: MonetaryKind;
  ccy: string; // "USD"
  orig_amount: string;
  carrying_twd: string;
  open: boolean;
}

export interface PricePoint {
  asset: string;
  date: string; // YYYY-MM-DD
  source: string;
  market: string;
  /** USD price per unit, decimal string at PRICE_SCALE. */
  price_usd: string;
  /** USD/TWD rate, decimal string at FX_SCALE. */
  usd_twd_rate: string;
}

export type ReconLayer = "CHAIN" | "SUBLEDGER" | "GL";
export type ReconStatus = "tie" | "break";

export interface ReconciliationRow {
  period: string;
  asset: string;
  layer: ReconLayer;
  balance: string;
  diff: string;
  status: ReconStatus;
}

// ---- Chart of accounts — symbolic keys (§3) --------------------------------

export type CoaKey =
  | "digital_asset"
  | "accum_impairment"
  | "impairment_loss"
  | "impairment_reversal_gain"
  | "disposal_gain"
  | "disposal_loss"
  | "sales_revenue"
  | "cogs"
  | "inventory"
  | "accounts_receivable"
  | "accounts_payable"
  | "fx_gain_loss"
  | "fee_expense"
  | "bank"
  | "oci_revaluation_surplus"
  | "fvpl_asset"
  | "fvpl_pl";

/** Deploy-time map: symbolic key -> target company COA code (CONFIG). */
export const DEFAULT_COA_CODES: Record<CoaKey, string> = {
  digital_asset: "1810",
  accum_impairment: "1819",
  impairment_loss: "6450",
  impairment_reversal_gain: "7180",
  disposal_gain: "7170",
  disposal_loss: "6170",
  sales_revenue: "4000",
  cogs: "5000",
  inventory: "1300",
  accounts_receivable: "1170",
  accounts_payable: "2170",
  fx_gain_loss: "7230",
  fee_expense: "6230",
  bank: "1110",
  oci_revaluation_surplus: "3400",
  fvpl_asset: "1820",
  fvpl_pl: "7160",
};

// ---- CONFIG defaults (§4, §10) ---------------------------------------------
// Current facts: USDC/USDT issuers retain redemption discretion -> not an
// unconditional right to cash -> IAS 38 (PENDING_DELOITTE confirm). BTC/ETH have
// no issuer -> IAS 38 (DECIDED). Measurement default COST_MODEL; cost_flow FIFO.

export const DEFAULT_ASSET_CONFIGS: AssetConfig[] = [
  {
    asset: "BTC",
    classification: "INTANGIBLE_IAS38",
    measurement: "COST_MODEL",
    monetary: false,
    is_stablecoin: false,
    redeemable_unconditional: false,
    cost_flow: "FIFO",
  },
  {
    asset: "ETH",
    classification: "INTANGIBLE_IAS38",
    measurement: "COST_MODEL",
    monetary: false,
    is_stablecoin: false,
    redeemable_unconditional: false,
    cost_flow: "FIFO",
  },
  {
    asset: "USDC",
    classification: "INTANGIBLE_IAS38",
    measurement: "COST_MODEL",
    monetary: false,
    is_stablecoin: true,
    redeemable_unconditional: false,
    cost_flow: "FIFO",
  },
  {
    asset: "USDT",
    classification: "INTANGIBLE_IAS38",
    measurement: "COST_MODEL",
    monetary: false,
    is_stablecoin: true,
    redeemable_unconditional: false,
    cost_flow: "FIFO",
  },
];

export const DEFAULT_POLICY: PolicyParam[] = [
  { key: "policy_version", value: "2026-06-29", status: "DECIDED" },
  { key: "functional_currency", value: "TWD", status: "DECIDED" },
  { key: "gas_policy", value: "TRANSFER_TO_EXPENSE", status: "DEFAULT_PENDING_INTERNAL" },
  { key: "price.market", value: "Coinbase close 23:59:59 UTC", status: "DEFAULT_PENDING_INTERNAL" },
  { key: "dual_gaap_enabled", value: "false", status: "DEFAULT_PENDING_INTERNAL" },
  { key: "tax_treatment", value: "UNDEFINED", status: "PENDING_DELOITTE" },
  { key: "impairment_test_frequency", value: "annual+on_indicator", status: "PENDING_DELOITTE" },
];
