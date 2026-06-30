import { describe, it, expect } from "vitest";
import { openTestDb } from "./db";

describe("reshare schema", () => {
  it("schema version is at least 9", () => {
    const db = openTestDb();
    const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(9);
  });
});
