import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import { syncSigners } from "./identity";
import {
  isChatMember,
  resolveIdentity,
  listChatMembers,
  findDirectChat,
  directCounterparty,
  createOrFindDirectChat,
} from "./dm";

function npubsFor(db: ReturnType<typeof openTestDb>) {
  syncSigners(db, [
    { participant_id: 1, label: "Maya Ksiazek", role: "CEO" },
    { participant_id: 2, label: "Ravi Bose", role: "CFO" },
  ]);
  const rows = db.prepare("SELECT npub, label FROM signers ORDER BY participant_id").all() as
    { npub: string; label: string }[];
  return { maya: rows[0], ravi: rows[1] };
}

describe("dm", () => {
  it("resolveIdentity prefers users/signers, falls back to truncated npub", () => {
    const db = openTestDb();
    const { maya } = npubsFor(db);
    expect(resolveIdentity(db, maya.npub).label).toBe("Maya Ksiazek");
    const unknown = resolveIdentity(db, "npub1unknownunknownunknown");
    expect(unknown.label).toBe("npub1unknow…");
    expect(unknown.role).toBe("Observer");
  });

  it("createOrFindDirectChat creates a 2-member direct chat, then is idempotent", () => {
    const db = openTestDb();
    const { maya, ravi } = npubsFor(db);
    const first = createOrFindDirectChat(db, { npub: maya.npub, label: maya.label }, ravi.npub);
    expect(first.created).toBe(true);
    const again = createOrFindDirectChat(db, { npub: ravi.npub, label: ravi.label }, maya.npub);
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id); // unordered-pair idempotent

    const chat = db.prepare("SELECT type FROM chats WHERE id = ?").get(first.id) as { type: string };
    expect(chat.type).toBe("direct");
    expect(isChatMember(db, first.id, maya.npub)).toBe(true);
    expect(isChatMember(db, first.id, ravi.npub)).toBe(true);
    expect(isChatMember(db, first.id, "npub1stranger")).toBe(false);
  });

  it("findDirectChat / directCounterparty resolve the pair", () => {
    const db = openTestDb();
    const { maya, ravi } = npubsFor(db);
    const { id } = createOrFindDirectChat(db, { npub: maya.npub, label: maya.label }, ravi.npub);
    expect(findDirectChat(db, maya.npub, ravi.npub)).toBe(id);
    expect(findDirectChat(db, maya.npub, "npub1nobody")).toBeNull();
    expect(directCounterparty(db, id, maya.npub)).toBe(ravi.npub);
    expect(directCounterparty(db, id, ravi.npub)).toBe(maya.npub);
  });

  it("listChatMembers returns resolved identities with initials + color", () => {
    const db = openTestDb();
    const { maya, ravi } = npubsFor(db);
    const { id } = createOrFindDirectChat(db, { npub: maya.npub, label: maya.label }, ravi.npub);
    const members = listChatMembers(db, id);
    expect(members.map((m) => m.label).sort()).toEqual(["Maya Ksiazek", "Ravi Bose"]);
    const m = members.find((x) => x.label === "Maya Ksiazek")!;
    expect(m.initials).toBe("MK");
    expect(m.color).toMatch(/^#[0-9A-F]{6}$/i);
  });
});
