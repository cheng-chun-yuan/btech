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
  filterVisibleChats,
} from "./dm";
import { addMember } from "./audit";

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

describe("filterVisibleChats", () => {
  it("hides channels from non-member non-signers, shows them to signers and explicit members", () => {
    const db = openTestDb();
    // Two signers (rows in `signers`) + one plain observer user.
    syncSigners(db, [
      { participant_id: 1, label: "Maya", role: "CEO" },
      { participant_id: 6, label: "Opie", role: "Operator" },
    ]);
    const [signer] = db.prepare("SELECT npub FROM signers ORDER BY participant_id").all() as { npub: string }[];
    db.prepare("INSERT INTO users (npub, label, role, created_at) VALUES (?,?,?,?)").run("npub-observer", "Obs", "Observer", 0);

    db.prepare("INSERT INTO chats (id, type, name, data_json) VALUES ('ch1','channel','#ops','{}')").run();
    const chats = [{ id: "ch1", type: "channel" }];

    // Signer sees it; unauthenticated sees nothing; observer does not (until added).
    expect(filterVisibleChats(db, signer.npub, chats).map((c) => c.id)).toEqual(["ch1"]);
    expect(filterVisibleChats(db, null, chats)).toEqual([]);
    expect(filterVisibleChats(db, "npub-observer", chats)).toEqual([]);

    addMember(db, "ch1", "npub-observer");
    expect(filterVisibleChats(db, "npub-observer", chats).map((c) => c.id)).toEqual(["ch1"]);
  });

  it("keeps the strict-membership rule for direct chats", () => {
    const db = openTestDb();
    db.prepare("INSERT INTO chats (id, type, name, data_json) VALUES ('dm1','direct','dm','{}')").run();
    db.prepare("INSERT INTO signers (vault_id, participant_id, npub, label, role) VALUES ('treasury',1,'npub-signer','S','CEO')").run();
    const chats = [{ id: "dm1", type: "direct" }];
    // A signer is NOT auto-member of a DM they're not in.
    expect(filterVisibleChats(db, "npub-signer", chats)).toEqual([]);
    addMember(db, "dm1", "npub-signer");
    expect(filterVisibleChats(db, "npub-signer", chats).map((c) => c.id)).toEqual(["dm1"]);
  });
});
