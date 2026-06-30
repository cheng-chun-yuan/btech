# Crypto Accounting Subledger — Design

> Status: **approved**, 2026-06-29. Derived from the AGENT SPEC (Crypto Accounting
> Subledger). Functional currency = **TWD**. Standard = **IFRS / TIFRS**.
> This doc is the source of truth and doubles as the implementation plan (see §9 Milestones).

## 1. Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| Placement | How it relates to the BTech treasury app | **New self-contained module in this repo.** `Event` is the only inbound seam. No dependency on BTech internals in v1. |
| Money | Numeric representation (INV-1 / INV-6) | **TypeScript + integer minor units (`bigint`)**, explicit per-asset scale, no float ever touches an amount. |
| v1 surface | What "done" means | **Headless engine + §9 outputs + acceptance tests.** No new UI, no live adapter, no API routes in v1. |
| Measurement | Shadow ledgers (§11) | **Configured path only now** (IAS38 + COST_MODEL + FIFO default). Lot history stored richly enough that FAIR_VALUE / REVALUATION shadow ledgers are additive later, not a rebuild. |

## 2. Invariants (must always hold)

Implementations must satisfy every invariant from the spec:

- **INV-1** every posted JournalEntry balances: `Σdebit == Σcredit`.
- **INV-2** every line traces to an `event_id` and `tx_hash`.
- **INV-3** append-only / WORM. Never hard-delete or mutate a posted entry. Corrections = reversing entry + new correct entry, both retained.
- **INV-4** three-way tie per asset per period: `on_chain == subledger(Σlots) == gl_control`. Mismatch → reconciliation break, never auto-fix.
- **INV-5** classification & measurement are CONFIG-driven and switchable without code change.
- **INV-6** amounts stored in TWD **and** original currency + qty.
- **INV-7** crypto (IAS 38) is non-monetary: no period-end FX retranslation; carrying locked at acquisition-date fx rate. Monetary USD AR/AP **are** retranslated at period-end closing rate.
- **INV-8** recognize impairment on the way down; reversal capped at original cost; no upward gain before disposal.
- **INV-9** disposal / period results computed at **lot** level (FIFO or weighted-avg per config).
- **INV-10** events failing validation are quarantined, never posted.

## 3. Architecture & boundary

A pure, headless accounting engine. One inbound contract — `Event` — pure outputs
(journal entries + §9 reports). Reuses the repo's `better-sqlite3` handle but owns a
**separate `sl_*` table namespace** and its own migration block; never touches treasury
tables. Determinism: prices, fx rates, config, and the chain balance used for
reconciliation are all **data the engine reads** (injectable provider for chain balance),
never live calls. No API routes in v1 — a demo script drives fixtures through the engine
and writes outputs to files.

```
fixture Events ──▶ ingest() ──▶ [validate → classify → measure → post] ──▶ sl_* tables (WORM)
                                                                              │
                                                          runReconcile(period)┤
                                                                              ▼
                                                                       outputs ①–⑨
```

## 4. Module layout (7 engine files)

```
app/api/_lib/subledger/
  money.ts      bigint minor units, per-asset scale, explicit rounding   (keystone)
  types.ts      all §2 domain types + CONFIG defaults w/ status enums
  store.ts      sl_* schema + WORM triggers + append-only read/write
  engine.ts     pipeline: validate(§8) → classify(§4) → measure(§5) → post(§6/§7)
  reconcile.ts  three-way tie (INV-4) → breaks
  outputs.ts    ①–⑨ emitters (CSV/JSON)
  index.ts      public API: ingest(event), runReconcile(period), emit(kind)
scripts/subledger-demo.ts   fixtures → outputs (headless)
*.test.ts                   one group per INVARIANT (§12)
```

CONFIG lives in `types.ts` as seed defaults and is written into `sl_config` rows at setup,
so classification/measurement/policy are runtime-switchable (INV-5) without code change.
`PENDING_*` values are config rows, surfaced — never hardcoded in logic.

## 5. Money type (exact arithmetic)

```ts
type Minor = bigint;                 // integer in the smallest unit
const TWD_SCALE = 4;                 // 4dp internally; round to 2dp only when posting
const QTY_SCALE = { BTC: 8, ETH: 18, USDC: 6, USDT: 6 };
```

- **TWD amounts**: `bigint` at 4dp internally (headroom for `qty × price × fx` chains),
  rounded **half-up to 2dp at the posting boundary** — the only place rounding happens.
  Balancing (INV-1) asserted at posting scale.
- **Quantities**: `bigint` at the asset's native scale.
- **Prices / fx rates**: not money — fixed-point with declared precision and one defined
  rounding mode per measurement step (§5 of spec). `money.ts` owns every rounding decision.
- Keystone property test: random event streams → every posted JE balances at posting
  scale; no rounding leaks across entries.

## 6. Data model → `sl_*` tables (append-only)

| table | holds | notes |
|---|---|---|
| `sl_event` | every ingested Event + `status` (posted/quarantined) + reject_reason | raw record, traceable (INV-2) |
| `sl_lot` | qty, remaining_qty, unit_cost_twd, **acquire_fx_rate (locked)**, accum_impairment | INV-7 fx-lock, INV-8 |
| `sl_lot_consumption` | which lots a disposal consumed | feeds output ④ |
| `sl_journal_entry` / `sl_journal_line` | the JEs per §6 | WORM; line carries event_id + tx_hash |
| `sl_monetary_item` | USD AR/AP: orig_amount, carrying_twd, open | retranslated at period-end (INV-7) |
| `sl_price` | PricePoint: asset, date, price_usd, usd_twd_rate, source | deterministic input |
| `sl_reconciliation` | period × asset × layer balances + diff + status | INV-4 breaks |
| `sl_exception` | recon breaks, rejected events, anomalies | output ⑨ |
| `sl_config` | AssetConfig + policy params + status enums + policy_version | runtime-switchable (INV-5) |

**WORM (INV-3):** SQLite triggers `RAISE(ABORT, …)` on any `UPDATE`/`DELETE` of a posted
`sl_journal_entry`/`sl_journal_line`. Corrections = reversing entry + new entry, both kept.
GL control balances are **derived** from `sl_journal_line` (no balance table to drift).

## 7. Engine pipeline

`ingest(event)` — ordered, short-circuits to quarantine, never partial-posts:

1. **validate** (§8): missing timestamp/asset/qty>0; on-chain move w/o tx_hash; AR/AP
   event w/o invoice_no; no PricePoint for required dates → quarantine + exception, stop (INV-10).
2. **classify** (§4): read `sl_config` → AssetConfig. No issuer → IAS38; stablecoin → IAS38
   unless `redeemable_unconditional` → FVTPL. Switchable without code (INV-5).
3. **measure** (§5): `ACQUIRE`→create lot; `DISPOSE`→`consume_lots` per `cost_flow` → carrying
   + disposal Δ (INV-9); `PERIOD_END`→impairment / capped reversal (INV-8); monetary AR/AP→fx
   retranslation at closing rate (INV-7). Intangible carrying uses **acquire fx rate**, never
   period-end (INV-7).
4. **post** (§6): build DR/CR lines, apply settlement split (§7: `fx_leg` vs `disposal_leg`
   kept separate), **assert balanced** (INV-1), write WORM JE with event_id+tx_hash per line (INV-2).

`runReconcile(period)` — separate/periodic: per asset compare `chain_bal` (injected provider)
== `subledger_bal` (Σlots) == `gl_bal` (Σjournal lines); equal → tie, else → `sl_reconciliation`
+ `sl_exception` break. **Never auto-fix** (INV-4).

The §6 posting table and §7 split are a data-driven `event_type → line builders` map, not nested
conditionals — readable against the spec, testable row-by-row.

## 8. Outputs (§9)

`outputs.ts` emits the exact column schemas: ① journal_csv (balanced, ERP-importable; coa_code
from the symbolic→code map), ② positions, ③ pnl_detail, ④ lot_disposal, ⑤ reconciliation,
⑥ audit_pack (bundle: period JEs + ⑤ + ④ + tx_hash index + policy_version + immutable_log),
⑦ tax_calc (OUT v2 — PENDING_DELOITTE), ⑧ disclosures, ⑨ exceptions.

## 9. Milestones (build order — thin vertical slice first)

- **M0 Foundation** — `money.ts` (+ property tests), `types.ts`, `store.ts` schema + WORM
  triggers, `sl_config` seed.
- **M1 Vertical slice (BTC, COST_MODEL/FIFO)** — BUY→lot; SELL/OFFRAMP→consume+disposal;
  validate/quarantine; balanced JE; outputs ①②④. Proves the whole pipe + INV-1/2/3/9/10.
- **M2 Period-end** — impairment, capped reversal, fx-lock (INV-7/8), PERIODEND_REVALUE; output ③.
- **M3 Stablecoin + monetary** — USDC/USDT classify, RECEIVE_SETTLE_AR / PAY_SUPPLIER, AR/AP fx
  retranslation, settlement split (§7), GAS / ONRAMP / RECEIVE_NONCASH. ETH folds into the
  M1/M2 intangible path.
- **M4 Reconcile + outputs** — three-way tie (INV-4) w/ fixture chain provider; outputs ⑤⑥⑧⑨;
  INV-5 config-switch test.
- **M5 Acceptance + demo** — full §12 checklist green; `subledger-demo.ts` emits all outputs headless.

## 10. Explicitly OUT (v2+)

Dual-GAAP parallel · tax ⑦ · §11 shadow ledgers · live BTech→Event adapter · UI · staking /
DeFi / lending yield · NFTs · Travel Rule · multi-entity consolidation.

## 11. Acceptance (§12 — engine self-verifies)

One test group per invariant + worked-example fixtures lifted from spec §5/§6/§7 with
hand-checked expected JEs: INV-1 balanced (property test) · INV-2 traceability · INV-3 triggers
block mutation + corrections are reversing pairs · INV-4 tie passes/breaks · INV-5 flip USDC
IAS38↔FVTPL via config only · INV-7 no fx on intangible carrying, yes on AR/AP · INV-8 impair +
capped reversal + no pre-disposal upside · INV-9 FIFO & weighted-avg · §7 split · INV-10
quarantine · PENDING_* read from `sl_config`, not hardcoded.
