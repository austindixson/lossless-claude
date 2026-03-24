import type Database from "better-sqlite3";

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      title TEXT,
      message_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      token_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(conversation_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv_seq
      ON messages(conversation_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_created
      ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated
      ON conversations(updated_at);
  `);

  // FTS5 — optional, graceful fallback
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(content, tokenize='porter unicode61');
    `);
  } catch {
    // FTS5 not available — search will use LIKE fallback
  }
}
