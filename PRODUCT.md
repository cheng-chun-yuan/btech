# Product

## Register

product

## Users

Bitcoin vault operators, technical founders, and custody engineers who need to
create a threshold-controlled vault, inspect the DKG state, derive a receive
address, and verify that an approval was signed by a valid grouped signer set.
They use the app in a focused operational context where correctness and audit
clarity matter more than decoration.

## Product Purpose

BTech is a local wallet-service MVP that integrates DKGKit. It demonstrates the
full local path from vault creation through HTSS DKG, Taproot address derivation,
approval digest creation, threshold signing, and aggregate signature
verification. Success means a user can run the flow, see each cryptographic
stage, and understand what is demo-only before production custody work begins.

## Brand Personality

Precise, restrained, technical. The product should feel like an operator
console for serious cryptographic workflows: calm, inspectable, and direct.

## Anti-references

Avoid crypto casino aesthetics, oversized landing-page claims, dark neon
trading dashboards, generic SaaS hero sections, and decorative card grids that
hide the actual protocol state.

## Design Principles

- Make cryptographic state inspectable without making the user read raw logs.
- Put verification outcomes near the inputs that produced them.
- Separate demo-only local transport from production custody requirements.
- Favor compact operational density over marketing composition.
- Show concrete identifiers, paths, digests, and signer sets in stable layouts.

## Accessibility & Inclusion

Target WCAG AA contrast. The UI should work with keyboard navigation, reduced
motion preferences, and color-blind users. Verification status must not rely on
color alone.
