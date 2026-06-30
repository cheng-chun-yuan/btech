# Governed vault-policy changes via native resharing (sub-project E)

Status: approved design · 2026-06-30

## Context

Today a vault's policy is fixed at provisioning. The signing tiers
(`tiers: Tier[]`, a grouped threshold like `1/2 + 2/3 + 3/5` — a quorum from
**each** tier) come from the Rust seed config (`grouped_config_123_of_235`) and
the chat object's `tiers` JSON. The only edit surface is the demo-level
`proposeKey` in `app/ui/wallet/wallet.tsx`, which mutates local React state and
spawns a `kind:"role"` approval that never touches key material.

The ask: let the current administrators **edit the policy** — add signers (from
their nostr connections), change each tier's threshold, add/remove whole tiers —
and have the change **ratified by a quorum** before it takes effect, then
**re-key the vault to the new policy without changing the group key or the
Bitcoin receive address**.

The re-keying mechanism is **resharing**: reconstruct the secret from a
policy-valid set of current shares, then re-deal a fresh polynomial with the
*same* `f(0)` over the new participant set. Same secret → same group key → same
address. This is wired into the native crypto (`dkgkit-frost`) as a new
primitive and exposed through `btech-vaultd`.

This builds directly on **sub-project C**
(`2026-06-30-members-only-channels-propose-picks-signers-design.md`): a policy
change reuses the *same* collapsed two-round HTSS signing as a payment — only
the authorization digest and the post-finalize action differ.

## Decisions (locked)

- **Who ratifies:** the **current** policy's quorum. The existing signers must
  authorize a change before the rule changes — you cannot weaken a policy
  without the people the old policy trusted. The proposer picks a
  current-policy-valid `signerSet` (propose-picks-signers, reused from C).
- **Re-keying mechanism:** **reconstruct-then-redeal resharing** (Approach A).
  vaultd already holds every share centrally (the demo trust model; trustless
  browser-P2P is sub-project D), so it reconstructs `f(0)` and re-deals locally.
  The native primitive and vaultd endpoint are structured so a trustless
  distributed reshare (PSS, Approach B) can replace the reconstruction step
  later without touching the governance or editor layers.
- **Continuity:** the group public key and the Taproot receive address **must
  not change** across a reshare. A reshare that would change the group key is a
  bug and must error before any state swap.
- **Edit scope:** **full structural edits** — add/remove signers, change each
  tier's threshold, add/remove whole tiers. Reconstruct-then-redeal supports any
  new config at no extra crypto cost.
- **Signing path:** a policy change rides the **same** collapsed two-round HTSS
  as a payment (precommit on approve → finalize at quorum), with a reshare
  authorization digest and a reshare action instead of a broadcast.
- **Secret safety:** no secret or share material ever enters the web DB — same
  rule as sub-project C. Reconstruction happens only inside vaultd.

## End-to-end flow

```
1. Edit    → Vault panel edits a WORKING COPY of the policy: add/remove signers
             (from nostr connections), change each tier's threshold, add/remove
             tiers.
2. Diff    → The editor diffs the draft against the current policy. Equal ⇒ no
             button. Different ⇒ a "Propose policy change" button appears with a
             human-readable diff ("+ operator-f → Managers · Treasury 2/3 → 3/3").
3. Propose → Creates a kind:"role" approval. Ratifiers = the CURRENT policy's
             quorum (proposer picks a current-policy-valid signerSet). The
             approval carries the full proposedPolicy + a policyVersion stamp.
             Lands in "Manage admin".
4. Ratify  → Each selected current signer signs via the SAME two-round HTSS as a
             payment, but the authorization digest binds the NEW policy
             (hash of vault_id ‖ "reshare" ‖ serialized new config ‖ approvalId).
             Their aggregate signature attests "we, the current quorum, authorize
             this exact new policy."
5. Apply   → On quorum, vaultd verifies the aggregate, then calls the native
             reshare → new shares for the new config, SAME group key, SAME
             address. Persist the new policy, bump policyVersion, audit-log; the
             card flips to "Change applied to the vault policy."
```

## Data model

`Approval` (`app/ui/wallet/types.ts`), for `kind:"role"`, gains:

```ts
/** The full policy the proposer wants to reshare into. The new signer set,
 *  tiers, and thresholds live here. */
proposedPolicy: PolicyConfig;
/** Precomputed, for display only. */
policyDiff: PolicyDiffItem[];
/** The current policy version this proposal was authored against. Apply
 *  rejects if the live policy has moved since (lost-update guard). */
basePolicyVersion: number;
```

It **reuses** `signerSet` from sub-project C, but here `signerSet` holds the
**current-policy ratifiers** (the people who must sign), *not* the new signers —
new signers live inside `proposedPolicy`.

`PolicyConfig` mirrors the existing tier shape (tiers, each with id/name, a
threshold, and signer entries `{ participantId, npub, label, rank }`), i.e. a
serializable form of `tiers: Tier[]` that round-trips to the Rust
grouped/hierarchical config.

**Persisted current policy:** the vault's canonical policy must live server-side
and update on apply. The `chats`/vault row owns the `tiers` JSON; reshare apply
rewrites it and bumps an integer `policyVersion`. (Today the live config is only
the Rust seed + client `tiers`; this spec makes the web DB the source of truth
for the *current* policy, with vaultd holding the matching shares.)

DB migration: bump `schema_meta`; add `policy_version` and persisted policy
columns if absent (the app owns the SQLite schema in `app/api/_lib/db.ts`).

## Native crypto — `dkgkit-frost`

A new primitive, mirroring `run_local_htss_keygen` but seeded with the
*reconstructed* secret instead of a random one:

```rust
pub fn reshare_htss(
    old: &HtssLocalKeySet,
    old_config: &HierarchicalThresholdConfig,
    reconstruct_set: &[ParticipantId],   // a policy-valid subset of the OLD config
    new_config: &HierarchicalThresholdConfig,
) -> Result<HtssLocalKeySet> {
    // 1. Birkhoff points from reconstruct_set over old_config → coefficients
    //    (birkhoff_interpolation_coefficients — already in the crate).
    // 2. secret = Σ cᵢ · share_value(idᵢ)              == f(0)
    // 3. fresh polynomial f' of degree new_config.threshold-1, f'(0) = secret,
    //    random higher coefficients.
    // 4. new share_value = f'^(rank)(id) for each participant in new_config
    //    (polynomial_derivative_value — already in the crate).
    // 5. INVARIANT: assert g^secret == old.group_key. A reshare that changes the
    //    group key returns Err and performs no swap upstream.
}
```

Reuses `birkhoff_interpolation_coefficients` and `polynomial_derivative_value`,
both already in `dkgkit-frost`. The grouped→hierarchical config lowering reuses
whatever path the vault was originally keyed with (confirmed at plan time, by
reading how `vault.rs` constructs the `HierarchicalThresholdConfig` from the
grouped seed).

**Forward path (Approach B):** a trustless PSS reshare replaces steps 1–2 (no
single-point reconstruction) with each current shareholder resharing their own
share. The `reshare_htss` signature and the vaultd endpoint shape are chosen so
that swap is local to `dkgkit-frost` + vaultd internals; governance/editor code
is untouched.

## vaultd — `POST /vault/reshare?id=<vault>`

Body `{ session: approvalId, signer_set, new_config }`:

1. Rebuild the same reshare authorization digest the web bound at propose time.
2. Run round-2 finalize over the ratifying `signer_set` (reusing the
   precommit/finalize machinery from sub-project C), aggregate, BIP340-verify.
3. On verify, call `reshare_htss` using the shares vaultd holds, with
   `reconstruct_set = signer_set` (the ratifying quorum *is* a policy-valid set).
4. Check the group-key invariant; **atomically** swap the stored
   `HtssLocalKeySet` to the new one only if every prior step succeeded.
5. Discard old shares; drop the session (single-use, same nonce-safety as C);
   drain/abort any open signing sessions for this vault (their shares are now
   stale).
6. Return the unchanged group key + receive address as confirmation.

**Fallback (no `BTECH_VAULTD_URL`):** the diff/propose/ratify governance UX still
works; the reshare step no-ops and the approval surfaces a clear "reshare
requires vaultd" status. The access-control half ships regardless.

**Naming:** keep the approval-binding id distinct from the cryptographic nonce
(`binding_nonce`/approval id vs. `htss_nonce`), consistent with C.

## Web governance layer

- `POST /api/approvals` — validate the caller is a member; validate
  `proposedPolicy` is structurally well-formed (every tier non-empty, threshold
  ≤ tier size, ≥ 1); validate each ratifier npub maps to a real **current**
  signer; stamp `basePolicyVersion = vault.policyVersion`; persist
  `proposedPolicy`, `policyDiff`, `signerSet`. Policy validity of the *new*
  config and of the *ratifier* set is enforced downstream by vaultd/Rust.
- `POST /api/approvals/[id]/sign` — the selected-signer gate from C, plus: at
  quorum, if `basePolicyVersion != vault.policyVersion` → reject
  ("policy changed since proposed; re-propose"); else call vaultd `runReshare`.
  On success, rewrite the vault's persisted policy, bump `policyVersion`, set
  `status:"ready"`, audit `policy/applied`.

## UI

- **Policy editor** (vault panel — where `setThreshold`/`removeKey`/`proposeKey`
  live today). Edits a **working copy**, not live state. Add signer opens a
  picker sourced from **nostr connections/roster** (member roster + contacts);
  picking someone allocates a `participantId` and assigns a tier/rank. Remove
  signer, ± tier threshold, add/remove tier.
- **Diff + Propose:** a live diff strip; the "Propose policy change" button is
  hidden while the draft equals current, appears when they differ, and is
  disabled while the draft is structurally invalid.
- **Ratifier picker:** reuses C's component, populated from the **current**
  policy's signers, auto-defaulting to a current-policy-valid minimal set.
- **Manage admin card:** shows the diff and ratifier states
  `Selected → Pre-committed → Signed`; on apply, "Change applied · group key
  unchanged · address unchanged." The read-only policy summary panel then
  reflects the new policy + bumped `policyVersion`.

## Edge cases & errors

- **Stale proposal (lost-update guard):** `basePolicyVersion` mismatch at apply
  → reject; proposer must re-propose against the new base. Prevents two reshares
  racing from the same base.
- **Invalid new config** (threshold > tier size, empty tier, 0-threshold):
  editor blocks Propose; vaultd rejects too (defense in depth).
- **Invalid ratifier set** (not current-policy-valid): cannot reconstruct →
  rejected; the auto-default avoids this.
- **Group-key invariant:** if `reshare_htss` would change the group key, vaultd
  aborts *before* swapping — no partial apply.
- **In-flight signing during reshare:** reshare invalidates old shares; vaultd
  drains/aborts open signing sessions for the vault; pending *payment* approvals
  must re-collect under the new shares.
- **Lock-out / weakening warnings:** the editor warns (but allows, if the quorum
  ratifies) when a proposer removes themselves, drops to 1-of-1, or otherwise
  weakens safety.
- **Non-member proposer:** 403 via the existing membership gate; audit
  `policy/failed`.

## Components & boundaries

- `dkgkit-frost` — `reshare_htss` primitive (+ group-key invariant).
- `src/bin/vaultd.rs` + `src/app.rs` — `/vault/reshare` (verify → reshare →
  atomic swap), reusing C's precommit/finalize.
- `app/api/approvals/route.ts` — persist + validate `proposedPolicy`,
  `basePolicyVersion`, current-quorum `signerSet`.
- `app/api/approvals/[id]/sign/route.ts` — quorum → stale-version check →
  vaultd reshare → persist new policy + bump version.
- `app/api/_lib/db.ts` — persisted policy + `policy_version` + columns + schema
  bump.
- `app/api/_lib/btech.ts` — `runReshare` vaultd client + no-vaultd fallback.
- `app/ui/wallet/*` — policy editor, connections picker, diff/Propose button,
  admin-card states, `PolicyConfig`/`PolicyDiffItem` types.

## Testing

- **Rust unit (`reshare_htss`):** reconstruct+redeal round-trips; group-key
  invariant holds; new shares produce a valid aggregate under the new config; an
  added participant's new share validates; an invalid `reconstruct_set` is
  rejected; a reshare that would change the group key errors.
- **Rust integration (vaultd):** `/vault/reshare` verifies the aggregate
  *before* resharing; address unchanged; stale/invalid `signer_set` rejected;
  session single-use.
- **API / governance:** propose persists `proposedPolicy` + `policyDiff` +
  current-quorum `signerSet` + `basePolicyVersion`; non-selected current signer
  → 403; last ratifier triggers reshare; stale `policyVersion` rejected; audit
  `policy/propose` + `policy/applied`.
- **Web / UI:** diff appears only when changed; Propose disabled on invalid
  config; admin-card states; post-apply summary reflects the new policy.
- **Fallback (no vaultd):** governance gate + diff/propose work; reshare no-ops
  with a clear "requires vaultd" status, and the selected-signer gate still
  rejects non-selected signers.

## Out of scope

- Trustless distributed reshare / PSS (Approach B) — each shareholder reshares
  their own share without reconstruction. This is the sub-project D-aligned
  upgrade; the primitive and endpoint here are shaped to accept it later.
- Per-channel signer scoping (per-vault `signers` rows) — inherited limitation
  from sub-project C.
- Rotating the group key / receive address on purpose (key rotation is a
  different operation; this spec guarantees continuity).
- On-chain implications of changing signers for an already-funded vault beyond
  share redistribution (funds stay at the same address by construction).
