import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

import { MOCK_CHATS, MOCK_APPROVALS } from "../../ui/wallet/data";
import type { Chat } from "../../ui/wallet/types";
import { migrateSubledger, seedConfig } from "./subledger";

export type DB = Database.Database;

const SCHEMA_VERSION = 8;

export function migrate(db: DB): void {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS users (
      npub TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      npub TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signers (
      vault_id TEXT NOT NULL,
      participant_id INTEGER NOT NULL,
      npub TEXT NOT NULL,
      label TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (vault_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      data_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      author_npub TEXT,
      who TEXT NOT NULL,
      handle TEXT,
      initials TEXT,
      color TEXT,
      time TEXT,
      text TEXT NOT NULL,
      signed INTEGER NOT NULL DEFAULT 0,
      zaps TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      vault TEXT NOT NULL,
      kind TEXT NOT NULL,
      data_json TEXT NOT NULL,
      status TEXT NOT NULL,
      is_live INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_signatures (
      approval_id TEXT NOT NULL,
      npub TEXT NOT NULL,
      aggregate_signature TEXT,
      precommit TEXT,
      signed_at INTEGER NOT NULL,
      PRIMARY KEY (approval_id, npub)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      actor_npub TEXT NOT NULL,
      actor_label TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id TEXT NOT NULL,
      npub TEXT NOT NULL,
      PRIMARY KEY (chat_id, npub)
    );

    CREATE TABLE IF NOT EXISTS auth_challenges (
      nonce TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
  const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    | { version: number }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (row.version < SCHEMA_VERSION) {
    if (row.version < 5) {
      // v5: drop the cold/petty seed channels that shipped placeholder receive
      // addresses so seed() re-creates them; real DKG addresses are provisioned
      // lazily. Messages live in their own table, so chat history is preserved.
      // (Skipped for v5+ DBs so their real funded addresses are untouched.)
      db.prepare("DELETE FROM chats WHERE id IN ('cold', 'petty')").run();
    }
    // v6: only true data — drop the mock DMs and the mock role-change approval.
    db.prepare("DELETE FROM chats WHERE id IN ('dm-ana', 'dm-ravi')").run();
    // v7: approvals are user-created and stored in the DB, with no seeded or
    // hardcoded fixtures. Drop the seeded transfers + the old live fixture row.
    db.prepare("DELETE FROM approvals WHERE id IN ('tx1', 'tx2', 'tx3', 'rc2')").run();
    // v8: per-signer pre-commit nonce package for the collapsed two-round flow.
    const sigCols = (db.prepare("PRAGMA table_info(approval_signatures)").all() as { name: string }[]).map((c) => c.name);
    if (!sigCols.includes("precommit")) {
      db.prepare("ALTER TABLE approval_signatures ADD COLUMN precommit TEXT").run();
    }
    db.prepare("UPDATE schema_meta SET version = ?").run(SCHEMA_VERSION);
  }
}

export function seed(db: DB): void {
  const now = Date.now();
  const insertChat = db.prepare(
    "INSERT OR IGNORE INTO chats (id, type, name, data_json) VALUES (?, ?, ?, ?)",
  );
  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, chat_id, author_npub, who, handle, initials, color, time, text, signed, zaps, created_at)
    VALUES (@id, @chat_id, NULL, @who, @handle, @initials, @color, @time, @text, @signed, @zaps, @created_at)
  `);
  const insertApproval = db.prepare(
    "INSERT OR IGNORE INTO approvals (id, vault, kind, data_json, status, is_live, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  const seedTx = db.transaction(() => {
    // Placeholder row for the live treasury vault so its messages + audit can
    // persist; the UI overlays the real DKGKit crypto display on top.
    insertChat.run(
      "treasury",
      "channel",
      "#treasury-ops",
      JSON.stringify({
        id: "treasury",
        type: "channel",
        name: "#treasury-ops",
        desc: "Live DKGKit grouped vault",
        members: 0,
        balanceBtc: "0",
        balanceUsd: "0",
        live: true,
        tiers: [],
      }),
    );
    for (const chat of MOCK_CHATS as Chat[]) {
      const { messages, ...meta } = chat;
      insertChat.run(chat.id, chat.type, chat.name, JSON.stringify(meta));
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        insertMsg.run({
          id: m.id,
          chat_id: chat.id,
          who: m.who,
          handle: m.handle,
          initials: m.initials,
          color: m.color,
          time: m.time,
          text: m.text,
          signed: m.signed ? 1 : 0,
          zaps: m.zaps,
          created_at: now + i,
        });
      }
    }
    for (const a of MOCK_APPROVALS) {
      insertApproval.run(a.id, a.vault, a.kind, JSON.stringify(a), a.status, a.live ? 1 : 0, now);
    }
  });
  seedTx();
}

export function openTestDb(): DB {
  const db = new Database(":memory:");
  migrate(db);
  seed(db);
  return db;
}

declare global {
  // eslint-disable-next-line no-var
  var __btechDb: DB | undefined;
}

export function getDb(): DB {
  if (globalThis.__btechDb) return globalThis.__btechDb;
  const file = process.env.BTECH_DB ?? path.join(process.cwd(), "data", "btech.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  migrate(db);
  seed(db);
  migrateSubledger(db);
  seedConfig(db);
  globalThis.__btechDb = db;
  return db;
}
