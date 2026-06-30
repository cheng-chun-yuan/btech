# Stealth receiving — 1-minute demo

One published **BIP-352 address** that receives silent payments on **both** Bitcoin L1
(on-chain) and Arkade (off-chain VTXOs), detected with a **view key** alone. Each
payment is unlinkable; an explorer only ever sees a normal taproot output.

---

## Setup (once, before the clock starts)

```bash
# 1. arkd regtest stack already running (arkd on :7070). Operator funded.
# 2. Start the btech web app on a free port (:3000 may be taken):
cd ~/project/btech && PORT=3030 bun run dev
# 3. Open the screen:
open http://localhost:3030/stealth
```

Keep a second terminal in the SDK repo:

```bash
cd ~/project/hackathon/arkade-ts-sdk
```

> **No-infra fallback:** if arkd isn't up, skip the commands and just click
> **"Simulate inbound payment"** 2–3 times — it derives + detects real BIP-352
> payments in-browser. Same story, no setup.

---

## The 60 seconds

**0:00–0:15 — One address, both rails.**
Point at the `STATIC META-ADDRESS` (`tsp1…`).
> "One BIP-352 address, published once. Real spec — validated against the official
> test vectors. Any silent-payment wallet can pay it, on Bitcoin L1 or on Arkade."

**0:15–0:35 — Arkade off-chain payment.** Run, then refresh the page:

```bash
BTECH_URL=http://localhost:3030 bun run examples/node/silent-payment-send.ts
```

> "A payer just spent a VTXO **off-chain** on Arkade and funded a one-time output P.
> No on-chain transaction. The treasury detected it with the **view key only** —
> there's **+10,000 sats**. It never learned P in advance."

**0:35–0:55 — Bitcoin L1 payment.** Run, then refresh:

```bash
BTECH_URL=http://localhost:3030 bun run examples/node/silent-payment-l1.ts
```

> "Now a **Bitcoin L1** payer broadcast a real taproot output to the **same address**.
> The same view key detects it — **+99,000 sats**. Two rails, one address."

**0:55–1:00 — The point.**
> "**2 payments · 109,000 sats**, one published address. Every P is unlinkable; the
> treasury detects with a **detect-only** view key — it can see, never spend. On an
> explorer these are just ordinary taproot outputs."

---

## What each piece is

| On screen | What it proves |
|---|---|
| `tsp1…` static address | real BIP-352, one address for L1 + Arkade |
| `silent-payment-send.ts` → +10,000 | Arkade **off-chain** VTXO, no on-chain tx |
| `silent-payment-l1.ts` → +99,000 | Bitcoin **L1** on-chain taproot, same address |
| the inbound feed | **view-key** detection — detect-only, unlinkable |

**Under the hood:** `lib/silentpayment/` (BIP-352 crypto + view-key scanner),
`/api/stealth` (publish address, ingest a detected payment), `dkgkit`
`silent_payment_leaf_tweak` (the FROST quorum spends a detected VTXO).
