# Handoff: incremental relay resubscribe (perf optimization)

**Project:** btech (Next.js 16 / React 19 + nostr-tools@2.23.8). **Branch:** `feat/nostr-dm` (check it out first; do NOT work on `main`).
**Status of feature:** Nostr relay chat (Phase 2) is complete and merged to `main`. This is a deferred *performance* follow-up — NOT a bug. The current behavior is correct (a deep review confirmed it); your job is to make it more efficient WITHOUT regressing correctness.

## The problem
`app/ui/wallet/wallet.tsx` has a SINGLE `useEffect` that both (a) creates a `NostrChatClient` and (b) subscribes to all the user's chats. Its dependency array includes the joined chat-id string (e.g. `chats.map((c) => c.id).join(",")`). So **any chat-set change** (e.g. opening a new DM) tears down the entire `SimplePool` + client and rebuilds it, reconnecting the relay and replaying backfill (`limit: 500`) for *all* chats.

`app/ui/wallet/nostr-chat.ts` `NostrChatClient`: `subscribe(chatIds, knownAuthors, onMessage)` returns `{ close() }`; `close()` tears down the pool. The pool connection is the expensive part.

## The goal
Split the one effect into **two**, so the relay connection persists across chat-set changes and only the *subscription* refreshes:

1. **Client-lifecycle effect** — deps `[signer, me?.npub]` only. Creates the `NostrChatClient` once per signer/me, stores it (see below), and sets `relayConnected` via `client.ensureConnected()`. Cleanup: `client.close()` + clear it.
2. **Subscription effect** — deps `[<client-ready>, <chat-id-set>, <knownAuthors-key>]`. When a client exists, closes the previous `SubCloser` and opens a fresh `subscribe(chatIds, knownAuthors, onMessage)` on the EXISTING client (pool stays connected). Cleanup: close the sub.

To let effect 2 depend on the client, store the client in React **state** (e.g. `const [chatClient, setChatClient] = useState<NostrChatClient | null>(null)`) in addition to / instead of the existing `chatClientRef` (keep the ref too if `sendMsg`/`submitSend` read `chatClientRef.current` imperatively — update both on create, clear both on cleanup). Build `knownAuthors = new Set([me.npub, ...chats.flatMap((c) => c.memberNpubs ?? [])])` in effect 2 (or pass a stable key for deps).

**Preserve exactly:** the `onMessage` body (dedup by event id + sort by `createdAt` via the functional `setRelayMsgs` updater), the `knownAuthors` gating, the `relayConnected` status, and the `cancelled`-guard cleanup pattern. Do NOT change `nostr-chat.ts`'s subscribe/publish/dedup/wire-format. Locate code by landmark (the file has unrelated parallel work — `showMembers`, `provisioningId`, gov/vault types — leave it untouched; line numbers drift).

**Honest note:** re-subscribing still replays relay backfill (the relay resends matching events), but the wallet-level dedup absorbs that; the real win is NOT reconnecting the relay/pool on every chat switch. That's sufficient — don't over-engineer incremental per-chat filter diffing.

## Guardrails (important)
- This touches a lifecycle effect that a deep review certified as correct (no infinite loop, no stale closure, dedup composes across rebuilds). If the two-effect split introduces ANY risk you can't cleanly verify — an effect ordering issue, a subscription leak, a double-subscribe, a stale `knownAuthors` — **STOP and keep the current single-effect behavior**, and report why. Bad work is worse than no work.
- Use the project's subagent-driven-development discipline if helpful, or a careful manual implementation + self-review against: no infinite re-subscribe loop; old sub always closed before a new one opens; client created/closed exactly once per signer/me; `sendMsg`/`submitSend` still reach a live client.

## Verify
- `bun run typecheck` → clean.
- `bun run test` → full suite green (was 122).
- Optional, if a relay is reachable: `NEXT_PUBLIC_NOSTR_RELAY=ws://127.0.0.1:7777 bun .superpowers/sdd/verify-relay-chat.ts` should still print `✅ RELAY CHAT VERIFIED`.

## Deliverable
- Commit on `feat/nostr-dm` only. Commit message:
  ```
  perf(dm): persist relay pool across chat switches; refresh only the subscription

  Claude-Session: https://claude.ai/code/session_01LXtp4DWET3JMMCi8jBHTWb
  ```
- **Do NOT merge to `main`** — leave that for the user to review and merge.
- Report what you changed, the before/after of the effect split, and the typecheck + test results. If you stopped without changing (per the guardrail), say so and why.
