/** First letter of the first two words, uppercased. Mirrors the inline idiom
 * used in messages/route.ts, chats/route.ts and data.ts. */
export function initialsFor(label: string): string {
  return label
    .split(" ")
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

const PALETTE = ["#6FB1FF", "#C99A5B", "#5FD08A", "#F7931A", "#B98AFF", "#FF8A8A", "#5FD0C8"];

/** Deterministic avatar color from an npub. Stable across server + UI. */
export function colorForNpub(npub: string): string {
  let h = 0;
  for (let i = 0; i < npub.length; i++) h = (h * 31 + npub.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
