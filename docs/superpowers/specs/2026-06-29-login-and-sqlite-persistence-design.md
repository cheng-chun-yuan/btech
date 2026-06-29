# Login + SQLite Persistence — Design

- **Date:** 2026-06-29
- **Status:** Approved (design); implementation plan pending
- **Scope:** Hackathon only. Not production custody.
- **Author:** Claude + project owner

## 1. Context & problem

BTech is a Next.js 16 (App Router) wallet console backed by a Rust DKGKit
crate that produces real HTSS DKG state and BIP340-verified Schnorr signatures.

Two gaps today:

1. **No login.** `app/page.tsx` renders `<Wallet />` directly — anyone hitting
   `/` is "in." There is no identity, so the UI cannot show role-based views or
   "you signed / you must sign."
2. **No persistence.** App data is either static client constants
   (`app/ui/wallet/data.ts` → `MOCK_CHATS`, `MOCK_APPROVALS`, messages) or live
   crypto recomputed per request. The Rust side is a **stateless CLI** re-run on
   every API call (`InMemoryRepository` is a `BTreeMap` that dies with the
   process). New approvals, who-signed-what, and chat messages vanish on refresh.

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Login model | **Nostr key + demo personas** | App is Nostr-native (signers are `npub…`); no user table of passwords needed; npub maps cleanly to a vault signer. |
| Storage | **Local SQLite file** (`better-sqlite3`) | Zero infra, survives restart, works offline (demo-safe on flaky wifi). |
| Crypto state | **Stays computed by Rust, not persisted** | Deterministic for demo; isolates the change; no risk to the hardest-to-debug layer. |
| Mock data | **Seeded into SQLite** | Keeps rich on-brand demo content, now mutable. |
| Rust crate | **Untouched** | All persistence is Next-side. |

## 3. Identity & login

A user is identified by their Nostr public key (`npub` bech32 / 32-byte x-only
hex). Three entry paths, all converging on one session:

1. **NIP-07 extension** — `window.nostr.getPublicKey()` (Alby, nos2x).
2. **Paste `nsec`** — derive npub client-side with `nostr-tools`; the secret
   **never leaves the browser**. Only the resulting npub is sent to the server.
3. **Demo personas** — one-tap "log in as Maya / Dana / Ravi / Ana", each backed
   by a fixed seeded keypair so role views work out of the box.

The logged-in npub is matched to a `participant_id` in the live vault policy
(via the `signers` table) → determines which rows render as "you" and which
approvals the user can sign.

**Optional nice-to-have (flag-gated, skippable for demo):** challenge-response
where the client signs a server nonce via NIP-07 `signEvent` to *prove* key
ownership. Default off for hackathon speed.

### Login UI

- New route `app/login/page.tsx` + components under `app/ui/login/`.
- Reuses the existing operator-console palette (the `C` tokens in `wallet.tsx`)
  and `PRODUCT.md` brand: precise, restrained, technical. No marketing hero.
- Three clearly separated affordances: **Connect Nostr**, **Paste nsec**,
  **Demo personas**. Verification/identity status must not rely on color alone
  (WCAG AA, per `PRODUCT.md`).

## 4. Session

- `POST /api/auth/login` — body `{ npub }` (+ optional signed challenge). Upserts
  a `users` row, creates a `sessions` row, sets an **httpOnly, SameSite=Lax**
  cookie holding the session token.
- `POST /api/auth/logout` — deletes the session row, clears the cookie.
- `GET /api/auth/me` — returns the current user + mapped signer, or 401.
- `middleware.ts` — guards all routes except `/login` and `/api/auth/*`.
  Unauthenticated → redirect to `/login` (pages) or 401 JSON (API routes).

## 5. Storage — SQLite (`better-sqlite3`)

- Single file `./data/btech.db` (**gitignored**).
- `app/api/_lib/db.ts` opens a process-singleton connection and runs **idempotent
  migrations + seed** on first import. Routes already use `runtime = "nodejs"`,
  so `better-sqlite3` (synchronous) works in handlers.

### Schema

```sql
users(
  npub        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  role        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
)

sessions(
  token       TEXT PRIMARY KEY,
  npub        TEXT NOT NULL REFERENCES users(npub),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
)

signers(                       -- maps live vault policy participants to identities
  participant_id INTEGER NOT NULL,
  vault_id       TEXT NOT NULL,
  npub           TEXT NOT NULL REFERENCES users(npub),
  label          TEXT NOT NULL,
  role           TEXT NOT NULL,
  PRIMARY KEY (vault_id, participant_id)
)

chats(                         -- seeded from MOCK_CHATS
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,    -- 'channel' | 'direct'
  name       TEXT NOT NULL,
  data_json  TEXT NOT NULL     -- full Chat shape (tiers, balances, etc.) as JSON
)

messages(
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id),
  author_npub TEXT,            -- null for system/seed messages
  who        TEXT NOT NULL,
  handle     TEXT,
  text       TEXT NOT NULL,
  signed     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)

approvals(                     -- seeded from MOCK_APPROVALS + new ones
  id         TEXT PRIMARY KEY,
  vault      TEXT NOT NULL,
  kind       TEXT NOT NULL,    -- 'send' | 'role'
  data_json  TEXT NOT NULL,    -- full Approval shape as JSON
  status     TEXT NOT NULL,    -- 'pending' | 'ready' | 'signed'
  is_live    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)

approval_signatures(
  approval_id          TEXT NOT NULL REFERENCES approvals(id),
  npub                 TEXT NOT NULL,
  aggregate_signature  TEXT,   -- real BIP340 sig from Rust, for the live vault
  signed_at            INTEGER NOT NULL,
  PRIMARY KEY (approval_id, npub)
)
```

> `data_json` columns keep the existing `Chat`/`Approval` TS shapes intact, so the
> UI keeps its types and we avoid a wide column-by-column remodel during a
> hackathon. We can normalize later if needed.

## 6. Data flow (the key boundary)

- **Live crypto stays in Rust.** Group key, receive address, verified aggregate
  signature still come from `/api/wallet/state` (`runDemo` + `runSessionProof`)
  and are **not** persisted — recomputed deterministically each load.
- **App state persists in SQLite.** When a user signs the **live** approval, the
  route calls the Rust binary (`runDemo`) for the *real* aggregate signature,
  then writes a row to `approval_signatures` with the signer's npub. Signatures
  now **accumulate across refreshes and across signers** — the core demo upgrade.
- **Mock vaults** (cold-reserve, ops-petty-cash, DMs) become real rows: messages
  POST and persist; approvals can be created and signed (no Rust call — these are
  explicitly non-live).

### New API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/login` `/logout` `/me` | POST/POST/GET | session lifecycle |
| `/api/chats` | GET | list chats (from SQLite) |
| `/api/messages` | GET, POST | list/post messages for a chat |
| `/api/approvals` | GET, POST | list/create approvals |
| `/api/approvals/[id]/sign` | POST | record a signature; live vault → calls Rust for the real aggregate sig |

The wallet UI swaps static `MOCK_CHATS` / `MOCK_APPROVALS` imports for fetches
that return the **same shapes** → minimal component churn. `buildLiveVault`,
`buildLiveApproval`, `livePolicyString` (in `data.ts`) stay; they just consume
fetched data instead of constants.

## 6a. Audit log & per-chat visibility (added 2026-06-29)

Each chat/vault keeps a **full audit log** of security-relevant actions —
`propose` (approval created), `sign` (who signed, + signature ref), and
`message` — recorded with actor npub, actor label, and timestamp.

**Visibility is enforced server-side**, not just hidden in the UI: a user may
read a chat's audit log only if they are a **member** of that chat. Membership =
the npub is a **signer of that vault** *or* has **participated** in the chat
(posted / proposed / signed). Non-members ("outside") receive **403**. An
`Observer` (logged in with a non-signer key, no participation) is outside every
vault → cannot read any audit log.

- New tables: `audit_log(id, chat_id, actor_npub, actor_label, action, detail,
  created_at)` and `chat_members(chat_id, npub, PRIMARY KEY(chat_id, npub))`.
- Membership is computed as `isMember = signer(npub) OR chat_members(chat_id, npub)`
  — so all signers are members of every vault, and any actor is auto-added to the
  chat they act in. No per-chat member seeding required.
- New route: `GET /api/chats/[id]/audit` → 401 if unauthenticated, 403 if not a
  member, else `{ entries: AuditEntry[] }` newest-first.
- Recording hooks: `POST /api/messages` (message), `POST /api/approvals`
  (propose), `POST /api/approvals/[id]/sign` (sign).
- UI: an **Audit** panel inside each chat, visible to members; for non-members
  the panel shows a "restricted to vault members" notice instead of entries.

## 7. File layout (new / changed)

```
middleware.ts                   NEW  auth guard (PROJECT ROOT, sibling of app/ —
                                     not under app/; src/ holds Rust, not Next)
app/
  login/page.tsx                NEW  login route
  ui/login/*                    NEW  login form, persona buttons
  api/
    _lib/db.ts                  NEW  sqlite singleton + migrations + seed
    _lib/auth.ts                NEW  session/cookie/npub helpers
    auth/login/route.ts         NEW
    auth/logout/route.ts        NEW
    auth/me/route.ts            NEW
    chats/route.ts              NEW
    messages/route.ts           NEW
    approvals/route.ts          NEW
    approvals/[id]/sign/route.ts NEW
  ui/wallet/data.ts             EDIT  source content from API; keep builders
  ui/wallet/wallet.tsx          EDIT  fetch chats/approvals; post messages/sign
.gitignore                      EDIT  add data/*.db
package.json                    EDIT  add better-sqlite3, nostr-tools
```

## 8. Hackathon demo flow

1. Visit `/` → redirected to `/login`.
2. One-tap **"Log in as Maya (CEO)"** → lands in the live treasury vault as a
   recognized signer.
3. Post a message in `#treasury-ops` → persists (refresh proves it).
4. Open the live approval, **Approve & sign** → Rust returns a real verified
   BIP340 aggregate signature, recorded under Maya's npub.
5. Log out, **"Log in as Dana (CFO)"**, sign the same approval → signature count
   increments; both signers now recorded. (Threshold story.)
6. Optionally connect a real Nostr extension to show non-demo identity.

## 9. Non-goals (YAGNI)

- No passwords / email / OAuth.
- No realtime / multi-device sync (that was the Supabase path, not chosen).
- nsec signature *verification* optional (default off).
- Rust `InMemoryRepository` and the crate are not modified.
- No production custody, relay networking, PSBT, broadcast, or recovery.

## 10. Risks & mitigations

- **`better-sqlite3` native build under Bun/Node mismatch.** Mitigation: verify
  install + a trivial read/write at the start of implementation; fall back to
  `@libsql/client` (pure-JS-friendly) if the native module misbehaves.
- **Next.js dev recompiles re-import `db.ts`.** Mitigation: cache the connection
  on `globalThis` to survive HMR.
- **Seed runs twice → duplicates.** Mitigation: `INSERT OR IGNORE` + a
  `schema_meta` version row so seed only runs once.
- **npub↔signer mismatch** if a real Nostr key isn't in the policy. Mitigation:
  unknown npubs log in as a read-only observer (can view, cannot sign).

## 11. Testing (hackathon-light)

- `vitest` unit tests for `auth.ts` (npub validation, session create/lookup) and
  `db.ts` seed idempotency.
- `curl` smoke checks for each route via the existing `run` flow.
- Manual walkthrough of the §8 demo flow end-to-end before judging.
