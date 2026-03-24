import type Database from "better-sqlite3";
import { sanitizeFts5Query, hasCjk } from "./db/fts5.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Conversation {
  id: number;
  session_id: string;
  title: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  conversation_id: number;
  seq: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  token_count: number;
  created_at: string;
}

export interface SearchResult {
  id: number;
  conversation_id: number;
  seq: number;
  role: string;
  snippet: string;
  created_at: string;
}

export interface SearchOptions {
  pattern: string;
  mode?: "regex" | "full_text" | "like";
  conversationId?: number;
  since?: string;
  before?: string;
  limit?: number;
}

// ── DB row shapes ────────────────────────────────────────────────────────────

interface ConversationRow {
  id: number;
  session_id: string;
  title: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  seq: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  token_count: number;
  created_at: string;
}

interface FtsRowidRow {
  rowid: number;
}

interface MaxSeqRow {
  max_seq: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate content around a match for snippets. */
function makeSnippet(content: string, pattern?: string, maxLen = 300): string {
  if (content.length <= maxLen) return content;
  if (pattern) {
    try {
      const re = new RegExp(pattern, "i");
      const match = re.exec(content);
      if (match) {
        const start = Math.max(0, match.index - 100);
        const end = Math.min(content.length, match.index + match[0].length + 200);
        return (
          (start > 0 ? "..." : "") +
          content.slice(start, end) +
          (end < content.length ? "..." : "")
        );
      }
    } catch {
      /* invalid regex, fall through */
    }
  }
  return content.slice(0, maxLen) + "...";
}

/** Check whether the FTS5 virtual table exists. */
function isFts5Available(db: Database.Database): boolean {
  try {
    db.prepare("SELECT rowid FROM messages_fts LIMIT 0").run();
    return true;
  } catch {
    return false;
  }
}

// ── Conversation operations ──────────────────────────────────────────────────

/**
 * Upsert a conversation by session_id. If one already exists, return it;
 * otherwise create a new row and return that.
 */
export function getOrCreateConversation(
  db: Database.Database,
  sessionId: string,
  title?: string,
): Conversation {
  const existing = db
    .prepare(
      `SELECT id, session_id, title, message_count, created_at, updated_at
       FROM conversations
       WHERE session_id = ?`,
    )
    .get(sessionId) as ConversationRow | undefined;

  if (existing) {
    return existing;
  }

  const result = db
    .prepare(
      `INSERT INTO conversations (session_id, title)
       VALUES (?, ?)`,
    )
    .run(sessionId, title ?? null);

  const row = db
    .prepare(
      `SELECT id, session_id, title, message_count, created_at, updated_at
       FROM conversations
       WHERE id = ?`,
    )
    .get(result.lastInsertRowid) as ConversationRow;

  return row;
}

// ── Message operations ───────────────────────────────────────────────────────

/**
 * Insert a single message. Auto-increments seq within the conversation,
 * estimates tokens, indexes into FTS5 if available, and updates the
 * conversation's message_count and updated_at.
 */
export function insertMessage(
  db: Database.Database,
  conversationId: number,
  role: Message["role"],
  content: string,
): Message {
  const txn = db.transaction(() => {
    // Determine next seq for this conversation
    const seqRow = db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq
         FROM messages
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as MaxSeqRow;
    const nextSeq = seqRow.max_seq + 1;

    const tokenCount = estimateTokens(content);

    const result = db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(conversationId, nextSeq, role, content, tokenCount);

    const messageId = Number(result.lastInsertRowid);

    // Index into FTS5 (best-effort)
    if (isFts5Available(db)) {
      try {
        db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`).run(
          messageId,
          content,
        );
      } catch {
        /* FTS indexing is optional */
      }
    }

    // Update conversation counters
    db.prepare(
      `UPDATE conversations
       SET message_count = message_count + 1,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).run(conversationId);

    // Retrieve the inserted message
    const row = db
      .prepare(
        `SELECT id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         WHERE id = ?`,
      )
      .get(messageId) as MessageRow;

    return row;
  });

  return txn();
}

/**
 * Batch-insert multiple messages in a single transaction.
 * Each message gets an auto-incremented seq.
 */
export function insertMessages(
  db: Database.Database,
  conversationId: number,
  messages: ReadonlyArray<{ role: Message["role"]; content: string }>,
): Message[] {
  if (messages.length === 0) return [];

  const txn = db.transaction(() => {
    const seqRow = db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq
         FROM messages
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as MaxSeqRow;
    let nextSeq = seqRow.max_seq + 1;

    const fts5 = isFts5Available(db);

    const insertStmt = db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const selectStmt = db.prepare(
      `SELECT id, conversation_id, seq, role, content, token_count, created_at
       FROM messages
       WHERE id = ?`,
    );

    let ftsInsertStmt: Database.Statement | null = null;
    if (fts5) {
      try {
        ftsInsertStmt = db.prepare(
          `INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`,
        );
      } catch {
        /* FTS not usable */
      }
    }

    const results: Message[] = [];

    for (const msg of messages) {
      const tokenCount = estimateTokens(msg.content);
      const result = insertStmt.run(
        conversationId,
        nextSeq,
        msg.role,
        msg.content,
        tokenCount,
      );
      const messageId = Number(result.lastInsertRowid);

      if (ftsInsertStmt) {
        try {
          ftsInsertStmt.run(messageId, msg.content);
        } catch {
          /* FTS indexing is optional */
        }
      }

      const row = selectStmt.get(messageId) as MessageRow;
      results.push(row);
      nextSeq += 1;
    }

    // Update conversation counters in bulk
    db.prepare(
      `UPDATE conversations
       SET message_count = message_count + ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).run(messages.length, conversationId);

    return results;
  });

  return txn();
}

/** Fetch a single message by its primary key. */
export function getMessage(
  db: Database.Database,
  messageId: number,
): Message | null {
  const row = db
    .prepare(
      `SELECT id, conversation_id, seq, role, content, token_count, created_at
       FROM messages
       WHERE id = ?`,
    )
    .get(messageId) as MessageRow | undefined;

  return row ?? null;
}

/** Fetch messages for a conversation, ordered by seq. */
export function getMessagesByConversation(
  db: Database.Database,
  conversationId: number,
  limit?: number,
  offset?: number,
): Message[] {
  const effectiveLimit = limit ?? -1; // -1 means no limit in SQLite
  const effectiveOffset = offset ?? 0;

  const rows = db
    .prepare(
      `SELECT id, conversation_id, seq, role, content, token_count, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY seq
       LIMIT ? OFFSET ?`,
    )
    .all(conversationId, effectiveLimit, effectiveOffset) as MessageRow[];

  return rows;
}

// ── Conversation listing ─────────────────────────────────────────────────────

/** List all conversations, most recently updated first. */
export function listConversations(db: Database.Database): Conversation[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, title, message_count, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC`,
    )
    .all() as ConversationRow[];

  return rows;
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Search messages across conversations.
 *
 * - "regex": fetch candidate rows from SQLite, filter in JS with RegExp.
 * - "full_text": try FTS5 MATCH first, fall back to LIKE for CJK or errors.
 * - "like": simple `WHERE content LIKE '%' || ? || '%'`.
 */
export function searchMessages(
  db: Database.Database,
  opts: SearchOptions,
): SearchResult[] {
  const mode = opts.mode ?? "regex";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  switch (mode) {
    case "full_text":
      return searchFullText(db, opts.pattern, limit, opts);
    case "like":
      return searchLike(db, opts.pattern, limit, opts);
    case "regex":
    default:
      return searchRegex(db, opts.pattern, limit, opts);
  }
}

// ── Private search helpers ───────────────────────────────────────────────────

interface ScopeFilters {
  conversationId?: number;
  since?: string;
  before?: string;
}

function buildScopeClause(
  filters: ScopeFilters,
  tableAlias?: string,
): { clauses: string[]; args: Array<string | number> } {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const clauses: string[] = [];
  const args: Array<string | number> = [];

  if (filters.conversationId != null) {
    clauses.push(`${prefix}conversation_id = ?`);
    args.push(filters.conversationId);
  }
  if (filters.since) {
    clauses.push(`${prefix}created_at >= ?`);
    args.push(filters.since);
  }
  if (filters.before) {
    clauses.push(`${prefix}created_at < ?`);
    args.push(filters.before);
  }

  return { clauses, args };
}

function searchFullText(
  db: Database.Database,
  pattern: string,
  limit: number,
  filters: ScopeFilters,
): SearchResult[] {
  // CJK text doesn't tokenize well in FTS5 unicode61 — go straight to LIKE
  if (hasCjk(pattern)) {
    return searchLike(db, pattern, limit, filters);
  }

  if (!isFts5Available(db)) {
    return searchLike(db, pattern, limit, filters);
  }

  try {
    const sanitized = sanitizeFts5Query(pattern);
    const scope = buildScopeClause(filters, "m");

    const whereParts = ["messages_fts MATCH ?", ...scope.clauses];
    const args: Array<string | number> = [sanitized, ...scope.args, limit];

    const sql = `
      SELECT
        m.id,
        m.conversation_id,
        m.seq,
        m.role,
        snippet(messages_fts, 0, '', '', '...', 32) AS snippet,
        m.created_at
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      WHERE ${whereParts.join(" AND ")}
      ORDER BY rank
      LIMIT ?`;

    const rows = db.prepare(sql).all(...args) as Array<{
      id: number;
      conversation_id: number;
      seq: number;
      role: string;
      snippet: string;
      created_at: string;
    }>;

    if (rows.length > 0) {
      return rows;
    }

    // FTS returned 0 results — fall back to LIKE
    return searchLike(db, pattern, limit, filters);
  } catch {
    // FTS query failed — fall back to LIKE
    return searchLike(db, pattern, limit, filters);
  }
}

function searchLike(
  db: Database.Database,
  pattern: string,
  limit: number,
  filters: ScopeFilters,
): SearchResult[] {
  const scope = buildScopeClause(filters);
  const whereParts = ["content LIKE '%' || ? || '%'", ...scope.clauses];
  const args: Array<string | number> = [pattern, ...scope.args, limit];

  const sql = `
    SELECT id, conversation_id, seq, role, content, created_at
    FROM messages
    WHERE ${whereParts.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?`;

  const rows = db.prepare(sql).all(...args) as Array<
    MessageRow & { content: string }
  >;

  return rows.map((row) => ({
    id: row.id,
    conversation_id: row.conversation_id,
    seq: row.seq,
    role: row.role,
    snippet: makeSnippet(row.content, pattern),
    created_at: row.created_at,
  }));
}

function searchRegex(
  db: Database.Database,
  pattern: string,
  limit: number,
  filters: ScopeFilters,
): SearchResult[] {
  // Guard against ReDoS: reject patterns with nested quantifiers or excessive length
  if (pattern.length > 500 || /(\+|\*|\?)\)(\+|\*|\?|\{\d)/.test(pattern)) {
    return [];
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return [];
  }

  const scope = buildScopeClause(filters);
  const whereClause =
    scope.clauses.length > 0 ? `WHERE ${scope.clauses.join(" AND ")}` : "";

  const sql = `
    SELECT id, conversation_id, seq, role, content, created_at
    FROM messages
    ${whereClause}
    ORDER BY created_at DESC`;

  const rows = db.prepare(sql).all(...scope.args) as MessageRow[];

  const MAX_ROW_SCAN = 10_000;
  const results: SearchResult[] = [];
  let scanned = 0;

  for (const row of rows) {
    if (results.length >= limit || scanned >= MAX_ROW_SCAN) break;
    scanned += 1;

    if (re.test(row.content)) {
      results.push({
        id: row.id,
        conversation_id: row.conversation_id,
        seq: row.seq,
        role: row.role,
        snippet: makeSnippet(row.content, pattern),
        created_at: row.created_at,
      });
    }
  }

  return results;
}
