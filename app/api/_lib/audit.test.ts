import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";
import { recordAudit, isMember, listAudit } from "./audit";
import { syncSigners } from "./identity";

describe("audit", () => {
  it("signers are members; observers are not", () => {
    const db = openTestDb();
    syncSigners(db, [{ participant_id: 1, label: "Alice", role: "Founder" }]);
    const signer = db.prepare("SELECT npub FROM signers LIMIT 1").get() as { npub: string };
    expect(isMember(db, "treasury", signer.npub)).toBe(true);
    expect(isMember(db, "treasury", "npub_outsider")).toBe(false);
  });

  it("records entries and auto-adds the actor as a member", () => {
    const db = openTestDb();
    recordAudit(db, { chatId: "cold", actorNpub: "npub_obs", actorLabel: "Obs", action: "message", detail: "hi" });
    expect(isMember(db, "cold", "npub_obs")).toBe(true);
    const entries = listAudit(db, "cold");
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe("message");
  });
});
