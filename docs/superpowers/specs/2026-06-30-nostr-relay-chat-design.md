# Nostr relay chat: reusable E2E transport for DMs + channels (Phase 2)

Status: approved design · 2026-06-30

## Context

Phase 1 (`docs/superpowers/specs/2026-06-30-click-to-dm-nostr-encrypted-design.md`,
shipped on `feat/nostr-dm`) gave DMs client-side NIP-44 encryption with the
ciphertext **stored in SQLite** and delivered via the existing
`POST /api/messages` → `GET /api/chats` pipeline. It deliberately deferred the
**live Nostr relay** transport.

The reference implementation already exists in the repo: `src/bin/relaychat.rs`
runs **real group + p2p encrypted chat over a live Nostr relay**. Its scheme:

- Event **kind `23333`**, content = **NIP-44 v2 ciphertext**, sender-signed
  (Schnorr, inherent to Nostr events).
- Tags: `["t", <hashtag>]` (scopes the conversation), `["p", <recipient pubkey>]`,
  `["chat", <scope>]` where scope is `"group"` or `"dm"`.
- **GROUP** = fan-out: a separate NIP-44-encrypted copy to every member.
- **DM** = a single 1:1 NIP-44 copy.
- Receive = filter by kind + hashtag, keep events whose `p` tag addresses me,
  whose author is a known member (directory), NIP-44-decrypt; **dedup by event id**.

Phase 2 brings this scheme into the web app as the **single transport for all
chat**, replacing the SQLite message path.

## Goal

One reusable client module delivers **both** DMs and channels as real,
E2E-encrypted, relay-delivered Nostr chat — interoperable with `relaychat.rs`
(identical event format). The server leaves the message path entirely; SQLite
keeps identity, membership, vault, and audit only.

## Decisions (approved)

- **Channels are E2E encrypted group chat** (relaychat.rs "group"): group scope
  fans out one NIP-44 copy per member. DM scope is 1:1. One module, scope chosen
  by `chat.type`.
- **Relay-native history.** The Nostr relay stores and backfills events; the
  browser fetches recent history on connect. SQLite no longer stores chat
  content. This unifies DM + channel and matches relaychat.rs.
- **Phase-1 DM transport is refactored onto the relay** (Consequence 2). The DM
  UX/spec stays; the SQLite persistence + `POST /api/messages`-for-chat path is
  replaced.
- **Message audit becomes metadata-only** (Consequence 1). The server can't see
  messages, so it can't record content. The client posts a metadata-only audit
  ping (`action: "message"`, actor + time, **no content**) so the audit panel
  still shows activity. Vault actions (propose/sign) stay fully audited.
- **Relay is a runtime dependency** (Consequence 3). No SQLite fallback in this
  phase; if the relay is down there is no chat delivery/history. A ciphertext
  cache for durability is explicitly deferred.
- **Fan-out includes self.** Each publish encrypts a copy addressed to every
  member *including the sender*, so the sender backfills its own history through
  the normal "addressed-to-me" path (no special author-side query).

## Components

### 1. `app/ui/wallet/nostr-chat.ts` — the one reusable module

- `connect(relayUrl: string, signer: NostrSigner): Promise<NostrChatClient>` —
  opens a browser WebSocket relay connection via `nostr-tools`.
- `client.publish(chat: Chat, members: Member[], text: string): Promise<void>` —
  `scope = chat.type === "direct" ? "dm" : "group"`. For **each member including
  self**: encrypt `text` via **`signer.encrypt(member.npub, text)`** (the
  Phase-1 abstraction — `LocalKeySigner` uses the NIP-44 conversation key,
  `Nip07Signer` uses `window.nostr.nip44`), build a signed kind-`23333` event
  tagged `[["t", chat.id], ["p", memberPubkeyHex], ["chat", scope]]` via
  `signer.signEvent`, publish.
- `client.subscribe(chatIds: string[], onMessage: (m: DecryptedMessage) => void):
  Subscription` — one `Filter({ kinds: [23333], "#t": chatIds, since/limit })`
  for backfill + live tail (e.g. `limit: 500` or `since:` last N days; the plan
  pins values). Per event: `p`-tag addresses me **and** author is a known member
  → decrypt via **`signer.decrypt(authorNpub, content)`** → `onMessage`. **Dedup
  by event id** (a `Set`).
- `DecryptedMessage = { id, chatId, authorNpub, text, createdAt }` (id = event
  id; chatId from the `t` tag).

Mirrors relaychat.rs `send_msg` / `collect` / `addressed_to` exactly, in TS.

### 2. `app/ui/wallet/nostr-signer.ts` — extended to sign events

The `NostrSigner` already provides `encrypt`/`decrypt` for all three login paths
(Phase 1). Phase 2 adds **one** method — `signEvent(template): Promise<Event>`:
- persona / nsec (in-memory secret) → `finalizeEvent(template, secret)`.
- NIP-07 → `window.nostr.signEvent(template)`.
Publish/subscribe call `signer.encrypt`/`signer.decrypt`/`signer.signEvent` —
they never touch raw keys, so the NIP-07 path (no exposed secret) works uniformly.

### 3. Event format — verbatim relaychat.rs

Kind `23333`; content = NIP-44 v2 ciphertext; tags `["t", chatId]`,
`["p", recipientHex]`, `["chat", "dm"|"group"]`. The `t` hashtag is the chat id,
so members of a chat subscribe to that one tag.

### 4. Membership / key resolution

Fan-out needs every member's pubkey. Source = the existing
`GET /api/chats/[id]/members` (`{ npub, label, role, initials, color }[]`,
built in Phase 1). The client decodes each `npub` to a hex pubkey for
`getConversationKey` and the `p` tag. Author-is-known-member check uses the same
roster as the directory.

### 5. Relay config

Browser relay URL = **`NEXT_PUBLIC_DKGKIT_RELAY`** (default
`ws://127.0.0.1:7777`, the relay `relaychat.rs` uses). Running the relay is a
runtime prerequisite for chat. A connection-status indicator surfaces relay
down/connecting/connected.

### 6. `wallet.tsx` wiring (both chat types, same calls)

- On login + chat list load: `connect(NEXT_PUBLIC_DKGKIT_RELAY, signer)` then
  `subscribe(allMyChatIds, onMessage)`; `onMessage` appends to the right chat's
  message list (keyed by chatId), deduped by event id.
- `sendMsg` → `client.publish(chat, members, text)` (was `POST /api/messages`).
  Optimistic local echo of the sender's own plaintext by event id.
- Render is unchanged from Phase 1 (decrypted text per message); the source is
  now the relay stream, not SQLite. The Phase-1 SQLite decrypt-on-view path and
  the chat branch of `POST /api/messages` are removed.
- Metadata-only audit ping: after a successful publish, the client may
  `POST` a contentless audit entry (existing audit pipeline) so the panel shows
  "sent a message" without content.

## Data flow

```
login → resolve signer → connect(relay) → subscribe(#t in my chat ids)
  ← relay backfills recent kind-23333 events + live tail
  → keep events where p == me & author ∈ members → NIP-44 decrypt → render (dedup by event id)

compose → publish(chat, members, text):
  for each member m (incl. self):
    ev = signer.signEvent(kind 23333, content = signer.encrypt(m.npub, text),
                          tags [t:chatId, p:m, chat:scope])
    relay.publish(ev)
  (optimistic local echo; metadata-only audit ping)
```

## Edge cases / errors

- **Relay down / connecting** — show status; sends fail with a clear error (no
  SQLite fallback this phase).
- **NIP-07 without `nip44` or `signEvent`** — chat disabled with a clear message
  (same gate as Phase 1).
- **Member without a resolvable pubkey** — skipped from fan-out (cannot encrypt
  to an unknown key); logged.
- **Self-copy decryption** — sender decrypts its own copy via
  `convKey(me, self)`; if that derivation is unavailable, fall back to decrypting
  any fan-out copy authored by self.
- **Dedup** — backfill + live tail can overlap; a per-session `Set<eventId>`
  prevents double-render.

## Testing

- **Relay harness** (node, against a real relay like the docker self-hosted one,
  mirroring relaychat.rs's assertions): a group message reaches **all** members;
  a DM stays **private** (a non-member never decrypts it); NIP-44 round-trip;
  event-id dedup.
- **Unit** — `nostr-chat` event-building (correct kind/tags/scope), the
  addressed-to-me + known-author filter, dedup; signer `signEvent` for each login
  path; reuse of the Phase-1 NIP-44 round-trip tests.
- **Integration** — publish to a relay, subscribe from a second client, assert
  decrypt + sender identity; assert plaintext never appears in any server store.

## Out of scope

- SQLite ciphertext cache / offline durability (relay is the source of truth this
  phase).
- Migrating Phase-1 SQLite DM history onto the relay (old demo DMs are
  disposable; new chat is relay-native from here).
- NIP-17 gift-wrap metadata hiding (the `p`/author metadata stays visible, as in
  relaychat.rs).
- Group membership changes re-keying / forward secrecy.
```
