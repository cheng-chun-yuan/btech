# Click-to-DM: NIP-44 encrypted direct messages from the channel UI

Status: approved design · 2026-06-30

## Context

Today the web chat is **plaintext rows in SQLite** (`better-sqlite3`), with no
Nostr involved in transport. Nostr keys are used only for **login, identity, and
signing** — the NIP-44-encrypted relay chat (`src/bin/relaychat.rs`, custom kind
`23333`) is a separate Rust demo that is **not wired into the web app**.

The data model already half-anticipates DMs:

- `ChatType = "channel" | "direct"` exists (`app/ui/wallet/types.ts:36`).
- The sidebar renders a **DIRECT** section (`wallet.tsx:758-768`) and `ChatView`
  branches on `isDirect` (header, hides the proposals/vault column, composer
  hint). DMs are explicitly modeled as **chat-only, no shared vault**
  (`types.ts:51-56`).
- Membership exists server-side in `chat_members(chat_id, npub)`
  (`app/api/_lib/db.ts:92-96`) and identity in `users(npub, label, role)` and
  `signers(vault_id, participant_id, npub, label, role)`.

Two gaps block the feature:

1. **No sender identity reaches the client.** `messages` stores `author_npub`,
   but `GET /api/chats` omits it from the SELECT (`app/api/chats/route.ts:18`),
   and `ChatMessage` (`types.ts:24-34`) has no npub field. The visible "member"
   panel is the *vault signer* list (`SignerKey`, `types.ts:6-14`) which also
   carries no npub.
2. **No DM-creation path.** `POST /api/chats` hardcodes `type:"channel"` and
   always provisions a vault (`chats/route.ts:80,70`).

## Goal

Click a person in a channel → a profile popover (avatar, display name, full npub
+ copy, role) with a **Direct message** button → open or create a 1:1
`type:"direct"` chat whose **content is NIP-44 encrypted client-side**. The
server stores and sees only ciphertext. Channels stay plaintext and unchanged.

Two click sources, both opening the same popover:

- **Message authors** — avatar/name on any rendered message.
- **Member roster** — a new "Members" list in the channel showing *everyone*,
  including people who have not posted (so you can DM a lurker).

## Decisions

- **Transport (hybrid, phased).** Encrypt client-side with NIP-44; persist
  ciphertext through the existing `/api/messages` → SQLite pipeline (Phase 1).
  Phase 2 adds live Nostr relay publish/subscribe using the **identical wire
  format**, so Phase 1 is not throwaway. Relay-only was rejected — it loses DM
  history on reload, wrong for a wallet/audit app. Because the server only ever
  handles ciphertext, caching in SQLite stays zero-knowledge.
- **Encryption is client-side, always.** NIP-07 logins mean the server never
  holds the user's private key and physically cannot encrypt for them. The
  browser is the only place keys live.
- **Runtime keys (Decision 1, approved).** For nsec / demo-persona logins the
  browser holds the secret key in memory for the session, cleared on logout.
  NIP-07 users never expose a key (use `window.nostr.nip44`).
- **Metadata (Decision 2, approved).** Phase 1 encrypts **content only**. The
  author display name (`who`) and membership stay visible server-side — *who
  talks to whom* is not hidden (membership reveals it anyway). Hiding metadata
  needs NIP-17 gift-wrap; noted as future hardening, not built now.
- **Click source (approved).** Both message authors and the member roster.

## Components

### 1. Identity plumbing

- Add `authorNpub: string` to `ChatMessage` (`types.ts:24-34`).
- Add `author_npub` (aliased `authorNpub`) to the message SELECT in
  `GET /api/chats` (`chats/route.ts:18`).
- New endpoint **`GET /api/chats/[id]/members`** → `{ npub, label, role,
  initials, color }[]`, built from `chat_members` joined with `users`/`signers`
  for names and roles. Member-gated, same pattern as
  `app/api/chats/[id]/audit/route.ts`.

### 2. Profile popover (`<ProfilePopover>`)

Avatar (initials + color) · display name · full npub with copy-to-clipboard ·
role chip (if resolvable) · **Direct message** button. Opened from a message
author or a roster row. The current user's own entry shows **no** DM button.

### 3. Member roster UI

A "Members" list rendered in the channel (within the existing right-hand panel
area), populated from `GET /api/chats/[id]/members`. Each row is clickable and
opens `<ProfilePopover>`. This is the path to DM someone who has not posted.

### 4. Find-or-create DM — `POST /api/dms`

Body `{ targetNpub }`. Finds the existing `type:"direct"` chat whose
`chat_members` is exactly `{me, target}`; otherwise creates one (chat-only, **no
vault**), adds both members, writes an audit row. **Idempotent on the unordered
npub pair.** Returns the chat id; the client opens it. `targetNpub` is always
available — authors have posted, roster rows carry the npub.

A direct chat's payload carries **`counterpartyNpub`** — the member npub that is
not the current user — resolved server-side in `GET /api/chats`. This gives the
client the recipient pubkey it needs to derive the NIP-44 conversation key for
both sending and decrypting history, without an extra round trip.

### 5. Client crypto — `NostrSigner`

One client module exposing:

- `nip44Encrypt(recipientPubkey, plaintext) -> ciphertext`
- `nip44Decrypt(counterpartyPubkey, ciphertext) -> plaintext`

backed by the active login method:

- **NIP-07** → `window.nostr.nip44.encrypt/decrypt`.
- **nsec / demo persona** → in-memory secret key + `nostr-tools` `nip44`
  (session-scoped, cleared on logout).

The NIP-44 v2 conversation key is symmetric (derive(myPriv, theirPub)), so both
parties decrypt the same history with their own key + the counterparty pubkey.

### 6. Send / store

Compose in a DM → client NIP-44-encrypts the plaintext for `counterpartyNpub` →
`POST /api/messages` with `text = ciphertext`. The server stores it verbatim —
**no server-side crypto, no schema change.** No per-message `encrypted` field is
needed: whether a message is ciphertext is **derived from the parent chat's
`type`** (`"direct"` ⇒ encrypted). DMs are new (the v6 migration removed all mock
DMs — `db.ts:119`), so every message in a direct chat is ciphertext by
construction; there is no mixed plaintext/ciphertext history to disambiguate.

### 7. Render / decrypt

On opening a DM, `GET /api/chats` returns ciphertext messages; the client
decrypts each via `NostrSigner` using `counterpartyNpub`. The client decrypts
messages **iff** the parent chat is `type:"direct"`; plaintext channel messages
render as-is. Decryption failure (e.g. a NIP-07 extension without `nip44`, or a
key mismatch) renders a graceful **"🔒 can't decrypt"** placeholder rather than
throwing.

## Phase 2 — live relay (specified, not built now)

Wrap the same NIP-44 ciphertext as a Nostr event (kind `23333`, `p` tag =
recipient pubkey, `["chat","dm"]` tag — exactly as `relaychat.rs`). The browser
connects to `DKGKIT_RELAY` via `nostr-tools`, publishes on send, subscribes for
the conversation, and **dedups against SQLite by event id**. SQLite remains the
history/backfill store. No UX change; the wire format is identical to Phase 1.

## Data flow

```
author/roster click → ProfilePopover → "Direct message"
  → POST /api/dms { targetNpub }  (find-or-create type:"direct")
  → open DM chat
compose → NostrSigner.nip44Encrypt(counterpartyNpub, text)
  → POST /api/messages { text: ciphertext }   (encryption derived from chat.type)
  → SQLite (ciphertext at rest)
open DM → GET /api/chats (ciphertext + counterpartyNpub on the direct chat)
  → if chat.type === "direct": NostrSigner.nip44Decrypt(counterpartyNpub, ct)
  → render (or 🔒 placeholder on failure)
[Phase 2] same ciphertext event → relay publish/subscribe, dedup by event id
```

## Edge cases

- **Self-DM** — own entry shows no DM button; `POST /api/dms` rejects
  `targetNpub == me`.
- **NIP-07 without `nip44`** — DM disabled with a clear message; cannot encrypt
  until a compatible signer is present.
- **Long npub** — truncate in the popover with copy-to-clipboard for the full
  value.
- **Channels unaffected** — only `type:"direct"` messages are encrypted;
  decryption is gated on the parent chat's `type`, so existing plaintext channel
  chat is untouched.

## Testing

- **Unit** — NIP-44 round-trip per signer type (NIP-07 mock, nsec, demo), with
  `ciphertext != plaintext`; `POST /api/dms` idempotency on the npub pair.
- **Integration** — post a DM → assert **plaintext is absent** from the DB row →
  fetch → decrypt → matches the original.
- **UI** — author click and roster-row click both open `<ProfilePopover>`; the
  DM button routes to the created/found DM; the current user's own entry shows
  no DM button.

## Out of scope

- NIP-17 metadata hiding (future hardening).
- Phase 2 live relay delivery (specified above; separate implementation).
- Encrypting existing channel chat.
- Group (>2 party) encrypted DMs.
