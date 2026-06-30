import type { Chat } from "./types";

/** Append chats present in `fresh` but missing from `prev` (matched by id),
 * leaving every existing chat object untouched. Used by the /api/chats poll so a
 * DM (or channel) a peer just created surfaces live and the relay subscription
 * (keyed on the chat-id set) picks it up — without clobbering the live-vault
 * treasury merge or fetched balances on chats we already hold. Returns `prev`
 * unchanged when there is nothing new, so React skips a needless re-render. */
export function mergeNewChats(prev: Chat[], fresh: Chat[]): Chat[] {
  const known = new Set(prev.map((c) => c.id));
  const added = fresh.filter((c) => !known.has(c.id));
  return added.length === 0 ? prev : [...prev, ...added];
}
