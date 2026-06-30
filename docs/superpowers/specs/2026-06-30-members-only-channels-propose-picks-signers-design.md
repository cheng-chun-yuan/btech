# Members-only channels + propose-picks-signers signing (sub-project C)

Status: approved design · 2026-06-30

## Context

This is **sub-project C** from the trustless-relay-signing decomposition
(`2026-06-30-trustless-relay-signing-design.md`): *bind chat ↔ signing +
governance (RBAC, propose-picks-signers)*. Two concrete asks:

1. **Only group members can see a channel.** Today channel chats are visible to
   everyone.
2. **Propose picks the signers, and those signers sign.** Today a proposal sets
   only a numeric threshold; any registered signer can vote, and the server runs
   the whole HTSS round one-shot at the end. The new flow lets the proposer
   choose the exact signer set, and each chosen signer contributes a real
   pre-committed nonce (round 1) at approve-time; round 2 (sign + aggregate)
   fires directly once the set is complete.

The real two-round HTSS already exists in `src/bin/relaysign.rs` (`htss_nonce`
round 1 → `htss_sign_share[_for_output]` round 2 → aggregate + BIP340 verify).
`btech-vaultd` currently exposes only the one-shot `/vault/sign`. This spec
adds a server-coordinated two-round path to vaultd and the governance gates in
the web app. Full browser-P2P per-signer signing is **sub-project D**, out of
scope here.

## Decisions (locked)

- **Channel visibility:** members **OR** registered signers — reuse the existing
  `isMember(db, chatId, npub)` helper.
- **Signing depth:** *collapsed two-round* — each chosen signer submits their
  pre-commit nonce when they approve; round 2 runs directly once all chosen
  signers have submitted. No separate round-1 barrier.
- **Quorum:** the chosen signer set **is** the quorum — `threshold =
  signerSet.length`, and **all** chosen signers must sign.
- **Signer picker:** auto-default a policy-valid minimal set; the proposer can
  adjust; the server (vaultd / Rust) rejects any policy-invalid set.

## Part 1 — Channel visibility

### Change

`GET /api/chats` (`app/api/chats/route.ts:58`) currently gates only `direct`
chats. Extend the filter so channels are gated too:

```ts
const visible = chats.filter((c) =>
  viewer != null &&
  (c.type === "direct"
    ? isChatMember(db, c.id, viewer.npub)   // strict membership (unchanged)
    : isMember(db, c.id, viewer.npub)),     // channel: members OR signers
);
```

`isMember` (`app/api/_lib/audit.ts:21`) already means *explicit `chat_member`
**or** registered signer*. Channel creation (`POST /api/chats`) already calls
`addMember` for the creator; audit actions add actors as members; the roster
"add member" path writes `chat_members`. So explicit membership keeps working
with no new plumbing.

### Consequences (intended)

- **Unauthenticated viewers see no channels** (today they see all).
- **Any registered signer sees every channel** — `isMember`'s signer check is
  not scoped to the channel's vault. Non-signer *observers* see only channels
  they were explicitly added to. This is the literal "members + signers" rule.
- Seed channels (`treasury`/`cold`/`petty`) remain visible because their
  audience are signers.

### Known limitation / follow-up (not built now)

Per-channel signer scoping would require per-vault rows in the `signers` table;
today channels embed keys only in `tiers` JSON, and `signers` is effectively a
single global roster. If tighter scoping is wanted later, that is a separate
change.

### Tests

- Non-signer, non-member: `GET /api/chats` omits the channel.
- Explicit member (non-signer): channel present.
- Registered signer: all channels present.
- DM gate unchanged (strict `isChatMember`).
- Unauthenticated: no channels.

## Part 2 — Propose-picks-signers + collapsed two-round signing

### Data model

`Approval` (`app/ui/wallet/types.ts`) gains:

```ts
/** The exact signers the proposer assembled. Its length is the threshold;
 *  all of them must sign. participantId aligns with the Rust signer_set and
 *  the `signers` table; npub/label are for display + the sign-gate. */
signerSet: { participantId: number; npub: string; label: string }[];
```

`threshold` is derived as `signerSet.length` at propose time (the chosen count
*is* the threshold).

`approval_signatures` gains one column:

```sql
ALTER TABLE approval_signatures ADD COLUMN precommit TEXT;  -- public nonce package hex
```

Holds each signer's **public** pre-commit (round-1) nonce package, for
audit/display. **Secret nonce material never touches the web DB** — it lives
only in vaultd, which already holds the shares.

DB migration: bump `schema_meta` version and add the column if absent (the app
owns the SQLite schema in `app/api/_lib/db.ts`).

### Propose flow

**Send dialog** (`app/ui/wallet/wallet.tsx` `submitSend`): add a signer picker
populated from the vault roster (`GET /api/chats/[id]/members`, falling back to
the channel's `tiers[].keys`). The picker auto-selects a policy-valid minimal
set; the proposer may adjust. The selected signers become `signerSet`;
`threshold = signerSet.length`.

**`POST /api/approvals`**: validate the caller is a member, that each selected
npub maps to a real signer (`signers` table), and persist `signerSet`. Policy
validity of the set is enforced downstream by vaultd/Rust (a bad set fails at
finalize and surfaces as an error) — the API does not re-implement policy math.

### Sign flow — the collapsed two-round

`POST /api/approvals/[id]/sign`:

1. **Gate (propose-picks-signers):** caller must be a registered signer **and**
   appear in this approval's `signerSet`. Otherwise `403 "not a selected signer
   for this approval"` and an audit `sign/failed` entry. (Replaces today's
   "any registered signer" check.)
2. **Round 1, on approve:** call vaultd
   `POST /vault/sign/precommit { session: approvalId, participant_id }`.
   vaultd computes `htss_nonce` from that signer's share, stores the secret
   local nonce in a session keyed by `approvalId`, and returns the **public**
   package. The web writes the package to `approval_signatures.precommit` and
   records the vote (`INSERT OR IGNORE`, one per npub — re-signing is a no-op).
3. **Count** distinct chosen-set members who have submitted.
4. **Round 2, when the set is complete:** once every `signerSet` member has
   submitted, call vaultd
   `POST /vault/sign/finalize { session: approvalId, signer_set, recipient,
   amount_sats, nonce, memo }`. vaultd runs `htss_sign_share[_for_output]` per
   chosen signer from the stored nonces + full nonce set + message, aggregates,
   BIP340-verifies, and returns a `DemoReport`. The web stamps the proof
   (`digest`/`signature`/`groupKey`/`signers`/`verified`), sets `status:
   "ready"`, and records `sign/success`.
5. **Single-use nonces:** vaultd consumes and discards the session's local
   nonces on finalize; a re-sign requires a fresh session. The spec's
   "pre-committed nonce safety (critical)" is honored — reuse is structurally
   impossible because the session is dropped.

`ready = allChosenSigned && (!live || proof.verified)`.

### New Rust surface

`src/bin/vaultd.rs` + `src/app.rs`, wrapping the **same** primitives
`relaysign.rs` already uses:

- `POST /vault/sign/precommit?id=<vault>` body `{ session, participant_id }`
  → `{ participant_id, nonce_package: <hex> }`. Maintains an in-process
  `HashMap<session_id, SignSession>` where `SignSession` holds
  `BTreeMap<ParticipantId, HtssLocalNonce>` (secret) and the collected public
  packages. Idempotent per `(session, participant_id)`.
- `POST /vault/sign/finalize?id=<vault>` body `{ session, signer_set,
  recipient, amount_sats, nonce, memo }` → builds the same authorization digest
  `sign_payment` builds today (Stage 1; Stage 2 will point at the Taproot
  output sighash), runs round 2 per chosen signer, aggregates, verifies,
  returns `DemoReport`. Drops the session (single-use). Rejects a
  policy-invalid `signer_set` with an error.

**Naming:** the existing `sign_payment(nonce: String)` argument is the
*approval-binding id*, **not** the cryptographic nonce. Keep them distinct in
code and comments (`binding_nonce` / approval id vs. `htss_nonce`).

### Fallback (no vaultd)

If `BTECH_VAULTD_URL` is unset, the stateful two-round cannot run, so signing
falls back to today's one-shot CLI `runSignApproval`. The **propose-picks-signers
governance gate still applies** — so the access-control half works with or
without vaultd. The collapsed two-round is exercised only when vaultd is
configured.

### UI

- **Send dialog:** signer multi-select from the roster, defaulting to a
  policy-valid minimal set; shows derived `threshold = count`.
- **Approval card** (`app/ui/wallet/approval-card.tsx`): show the chosen signer
  set and each signer's state — `Selected → Pre-committed → Signed` — plus the
  final verified aggregate when ready.
- **Approvals list:** an approval counts as "needs you" only if the viewer is in
  its `signerSet`.

## Components & boundaries

- `app/api/chats/route.ts` — channel visibility gate (Part 1).
- `app/api/approvals/route.ts` — persist + validate `signerSet` on propose.
- `app/api/approvals/[id]/sign/route.ts` — selected-signer gate + collapsed
  two-round orchestration (precommit on approve, finalize on completion).
- `app/api/_lib/btech.ts` — `runPrecommit` / `runFinalize` vaultd clients +
  one-shot fallback.
- `app/api/_lib/db.ts` — `precommit` column + schema bump.
- `app/ui/wallet/*` — signer picker, approval-card states, types.
- `src/bin/vaultd.rs` + `src/app.rs` — `/vault/sign/precommit` and
  `/vault/sign/finalize`, reusing existing HTSS primitives.

## Testing

- **API — governance:** propose stores `signerSet` and derives `threshold`;
  non-selected signer → 403 on sign; each selected signer pre-commits; the last
  one triggers finalize → verified proof; re-sign is a no-op.
- **API — channel gate:** see Part 1 tests.
- **Rust — two-round:** precommit stores a nonce; finalize aggregates + BIP340
  verifies; invalid `signer_set` rejected; **nonce single-use** — a second
  finalize on the same session fails.
- **Fallback:** with `BTECH_VAULTD_URL` unset, a complete chosen set still
  produces a one-shot aggregate, and the selected-signer gate still rejects
  non-selected signers.

## Out of scope

- Browser-P2P per-signer signing (each signer holds their own share client-side)
  — sub-project D.
- Per-channel signer scoping (per-vault `signers` rows).
- Stage 2 on-chain Taproot sighash in finalize (reuses the existing settle path
  later; this spec keeps the Stage 1 authorization digest).
