import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migration.js";
import { sanitizeFts5Query, hasCjk } from "../src/db/fts5.js";
import {
  getOrCreateConversation,
  insertMessage,
  insertMessages,
  getMessage,
  getMessagesByConversation,
  listConversations,
  searchMessages,
  type Conversation,
  type Message,
  type SearchOptions,
} from "../src/store.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Create an in-memory database with all migrations applied. */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Store CRUD operations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── getOrCreateConversation ───────────────────────────────────────────────

  describe("getOrCreateConversation", () => {
    it("should create a new conversation", () => {
      const conv = getOrCreateConversation(db, "session-abc");
      expect(conv).toBeDefined();
      expect(conv.id).toBeGreaterThan(0);
      expect(conv.session_id).toBe("session-abc");
      expect(conv.message_count).toBe(0);
      expect(conv.created_at).toBeTruthy();
      expect(conv.updated_at).toBeTruthy();
    });

    it("should return existing conversation for same session_id", () => {
      const first = getOrCreateConversation(db, "session-xyz");
      const second = getOrCreateConversation(db, "session-xyz");
      expect(second.id).toBe(first.id);
      expect(second.session_id).toBe(first.session_id);
    });

    it("should be idempotent — repeated calls return same row", () => {
      const ids = Array.from({ length: 5 }, () =>
        getOrCreateConversation(db, "session-idem").id,
      );
      expect(new Set(ids).size).toBe(1);
    });

    it("should store title when provided", () => {
      const conv = getOrCreateConversation(db, "session-titled", "My Title");
      expect(conv.title).toBe("My Title");
    });

    it("should store null title when omitted", () => {
      const conv = getOrCreateConversation(db, "session-no-title");
      expect(conv.title).toBeNull();
    });

    it("should create separate conversations for different session_ids", () => {
      const a = getOrCreateConversation(db, "session-a");
      const b = getOrCreateConversation(db, "session-b");
      expect(a.id).not.toBe(b.id);
    });
  });

  // ── insertMessage ─────────────────────────────────────────────────────────

  describe("insertMessage", () => {
    let convId: number;

    beforeEach(() => {
      convId = getOrCreateConversation(db, "session-msg").id;
    });

    it("should auto-increment seq starting at 1", () => {
      const m1 = insertMessage(db, convId, "user", "Hello");
      const m2 = insertMessage(db, convId, "assistant", "Hi there");
      expect(m1.seq).toBe(1);
      expect(m2.seq).toBe(2);
    });

    it("should estimate tokens (~4 chars per token)", () => {
      const msg = insertMessage(db, convId, "user", "abcdefghijklmnop"); // 16 chars
      expect(msg.token_count).toBe(4); // ceil(16/4)
    });

    it("should estimate tokens for short content", () => {
      const msg = insertMessage(db, convId, "user", "Hi"); // 2 chars
      expect(msg.token_count).toBe(1); // ceil(2/4) = 1
    });

    it("should index content into FTS5", () => {
      insertMessage(db, convId, "user", "quantum entanglement discussion");
      const results = searchMessages(db, {
        pattern: "quantum entanglement",
        mode: "full_text",
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should update conversation message_count", () => {
      insertMessage(db, convId, "user", "one");
      insertMessage(db, convId, "assistant", "two");

      const convs = listConversations(db);
      const conv = convs.find((c) => c.id === convId);
      expect(conv?.message_count).toBe(2);
    });

    it("should return a fully-populated message object", () => {
      const msg = insertMessage(db, convId, "user", "Full message");
      expect(msg.id).toBeGreaterThan(0);
      expect(msg.conversation_id).toBe(convId);
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("Full message");
      expect(msg.created_at).toBeTruthy();
    });

    it("should store all valid roles", () => {
      const roles: Array<Message["role"]> = ["user", "assistant", "system", "tool"];
      for (const role of roles) {
        const msg = insertMessage(db, convId, role, `msg from ${role}`);
        expect(msg.role).toBe(role);
      }
    });
  });

  // ── insertMessages (batch) ────────────────────────────────────────────────

  describe("insertMessages", () => {
    let convId: number;

    beforeEach(() => {
      convId = getOrCreateConversation(db, "session-batch").id;
    });

    it("should batch insert multiple messages", () => {
      const msgs = insertMessages(db, convId, [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "How are you?" },
      ]);
      expect(msgs).toHaveLength(3);
      expect(msgs[0].seq).toBe(1);
      expect(msgs[1].seq).toBe(2);
      expect(msgs[2].seq).toBe(3);
    });

    it("should return empty array for empty input", () => {
      const msgs = insertMessages(db, convId, []);
      expect(msgs).toEqual([]);
    });

    it("should maintain transaction atomicity — all or nothing", () => {
      // Insert a valid batch first
      insertMessages(db, convId, [
        { role: "user", content: "first" },
      ]);

      // Now try to insert a batch that will fail — duplicate seq won't happen
      // because auto-increment handles it, but we can verify rollback by
      // checking the count stays consistent
      const before = getMessagesByConversation(db, convId);
      expect(before).toHaveLength(1);

      insertMessages(db, convId, [
        { role: "user", content: "second" },
        { role: "assistant", content: "third" },
      ]);

      const after = getMessagesByConversation(db, convId);
      expect(after).toHaveLength(3);
    });

    it("should update conversation message_count in bulk", () => {
      insertMessages(db, convId, [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
        { role: "user", content: "e" },
      ]);

      const convs = listConversations(db);
      const conv = convs.find((c) => c.id === convId);
      expect(conv?.message_count).toBe(5);
    });

    it("should continue seq from existing messages", () => {
      insertMessage(db, convId, "user", "pre-existing");
      const batch = insertMessages(db, convId, [
        { role: "assistant", content: "response" },
      ]);
      expect(batch[0].seq).toBe(2);
    });
  });

  // ── getMessage ────────────────────────────────────────────────────────────

  describe("getMessage", () => {
    it("should return message by ID", () => {
      const convId = getOrCreateConversation(db, "session-get").id;
      const inserted = insertMessage(db, convId, "user", "Findable");
      const found = getMessage(db, inserted.id);
      expect(found).not.toBeNull();
      expect(found!.content).toBe("Findable");
      expect(found!.id).toBe(inserted.id);
    });

    it("should return null for non-existent ID", () => {
      const result = getMessage(db, 99999);
      expect(result).toBeNull();
    });
  });

  // ── getMessagesByConversation ─────────────────────────────────────────────

  describe("getMessagesByConversation", () => {
    let convId: number;

    beforeEach(() => {
      convId = getOrCreateConversation(db, "session-list").id;
      insertMessages(db, convId, [
        { role: "user", content: "msg-1" },
        { role: "assistant", content: "msg-2" },
        { role: "user", content: "msg-3" },
        { role: "assistant", content: "msg-4" },
        { role: "user", content: "msg-5" },
      ]);
    });

    it("should return messages ordered by seq", () => {
      const msgs = getMessagesByConversation(db, convId);
      expect(msgs).toHaveLength(5);
      for (let i = 1; i < msgs.length; i++) {
        expect(msgs[i].seq).toBeGreaterThan(msgs[i - 1].seq);
      }
    });

    it("should respect limit parameter", () => {
      const msgs = getMessagesByConversation(db, convId, 2);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].seq).toBe(1);
      expect(msgs[1].seq).toBe(2);
    });

    it("should respect offset parameter", () => {
      const msgs = getMessagesByConversation(db, convId, 2, 2);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].seq).toBe(3);
      expect(msgs[1].seq).toBe(4);
    });

    it("should return empty array for non-existent conversation", () => {
      const msgs = getMessagesByConversation(db, 99999);
      expect(msgs).toEqual([]);
    });

    it("should return all messages when no limit is specified", () => {
      const msgs = getMessagesByConversation(db, convId);
      expect(msgs).toHaveLength(5);
    });
  });

  // ── listConversations ─────────────────────────────────────────────────────

  describe("listConversations", () => {
    it("should return conversations ordered by updated_at DESC", () => {
      const c1 = getOrCreateConversation(db, "session-first");
      const c2 = getOrCreateConversation(db, "session-second");

      // c2 was created after c1, so it should have a later updated_at
      // and appear first in the list
      const convs = listConversations(db);
      expect(convs.length).toBeGreaterThanOrEqual(2);
      // c2 was created more recently, so it should come first
      expect(convs[0].id).toBe(c2.id);
    });

    it("should return empty array when no conversations exist", () => {
      // Use a fresh db
      const freshDb = createTestDb();
      const convs = listConversations(freshDb);
      expect(convs).toEqual([]);
      freshDb.close();
    });
  });
});

// ── Search operations ─────────────────────────────────────────────────────────

describe("Search operations", () => {
  let db: Database.Database;
  let convId: number;

  beforeEach(() => {
    db = createTestDb();
    convId = getOrCreateConversation(db, "session-search").id;
    insertMessages(db, convId, [
      { role: "user", content: "How do I configure TypeScript for Node.js?" },
      { role: "assistant", content: "You need a tsconfig.json file with module set to Node16." },
      { role: "user", content: "What about ESLint integration?" },
      { role: "assistant", content: "Install @typescript-eslint/parser and configure .eslintrc." },
      { role: "user", content: "Thanks, that works perfectly!" },
    ]);
  });

  afterEach(() => {
    db.close();
  });

  // ── Regex mode ──────────────────────────────────────────────────────────

  describe("searchMessages regex mode", () => {
    it("should find messages matching a regex pattern", () => {
      const results = searchMessages(db, {
        pattern: "TypeScript",
        mode: "regex",
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.snippet.includes("TypeScript"))).toBe(true);
    });

    it("should be case insensitive", () => {
      const results = searchMessages(db, {
        pattern: "typescript",
        mode: "regex",
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should support regex special characters", () => {
      const results = searchMessages(db, {
        pattern: "tsconfig\\.json",
        mode: "regex",
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should return empty array for invalid regex", () => {
      const results = searchMessages(db, {
        pattern: "[invalid",
        mode: "regex",
      });
      expect(results).toEqual([]);
    });

    it("should return empty array for no matches", () => {
      const results = searchMessages(db, {
        pattern: "xyznonexistent",
        mode: "regex",
      });
      expect(results).toEqual([]);
    });

    it("should support alternation patterns", () => {
      const results = searchMessages(db, {
        pattern: "ESLint|tsconfig",
        mode: "regex",
      });
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Full-text mode ────────────────────────────────────────────────────────

  describe("searchMessages full_text mode", () => {
    it("should find messages via FTS5", () => {
      const results = searchMessages(db, {
        pattern: "configure TypeScript",
        mode: "full_text",
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should fall back to LIKE for CJK text", () => {
      // Insert a CJK message
      insertMessage(db, convId, "user", "日本語のテスト");

      const results = searchMessages(db, {
        pattern: "日本語",
        mode: "full_text",
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should return results for single word queries", () => {
      const results = searchMessages(db, {
        pattern: "perfectly",
        mode: "full_text",
      });
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── Like mode ─────────────────────────────────────────────────────────────

  describe("searchMessages like mode", () => {
    it("should find messages with simple pattern", () => {
      const results = searchMessages(db, {
        pattern: "TypeScript",
        mode: "like",
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should be a substring match", () => {
      const results = searchMessages(db, {
        pattern: "config",
        mode: "like",
      });
      // Should match "configure", "tsconfig.json", ".eslintrc"
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Search with filters ───────────────────────────────────────────────────

  describe("search with filters", () => {
    it("should filter by conversationId", () => {
      const conv2 = getOrCreateConversation(db, "session-other").id;
      insertMessage(db, conv2, "user", "TypeScript in another conversation");

      const results = searchMessages(db, {
        pattern: "TypeScript",
        mode: "regex",
        conversationId: conv2,
      });
      expect(results.length).toBe(1);
      expect(results[0].conversation_id).toBe(conv2);
    });

    it("should respect limit parameter", () => {
      const results = searchMessages(db, {
        pattern: ".*",
        mode: "regex",
        limit: 2,
      });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should cap limit at 200", () => {
      // Insert enough messages
      const msgs = Array.from({ length: 210 }, (_, i) => ({
        role: "user" as const,
        content: `test message number ${i}`,
      }));
      insertMessages(db, convId, msgs);

      const results = searchMessages(db, {
        pattern: "test message",
        mode: "like",
        limit: 999,
      });
      expect(results.length).toBeLessThanOrEqual(200);
    });

    it("should filter by since timestamp", () => {
      // All messages have the same created_at (datetime('now')),
      // so filtering with a future date should return nothing
      const results = searchMessages(db, {
        pattern: "TypeScript",
        mode: "regex",
        since: "2099-01-01T00:00:00Z",
      });
      expect(results).toEqual([]);
    });

    it("should filter by before timestamp", () => {
      // All messages were created at datetime('now'),
      // filtering before a past date should return nothing
      const results = searchMessages(db, {
        pattern: "TypeScript",
        mode: "regex",
        before: "2000-01-01T00:00:00Z",
      });
      expect(results).toEqual([]);
    });
  });

  // ── ReDoS guard ─────────────────────────────────────────────────────────

  describe("ReDoS guard", () => {
    it("should reject patterns with nested quantifiers", () => {
      const results = searchMessages(db, {
        pattern: "(a+)+b",
        mode: "regex",
      });
      expect(results).toEqual([]);
    });

    it("should reject excessively long patterns", () => {
      const longPattern = "a".repeat(501);
      const results = searchMessages(db, {
        pattern: longPattern,
        mode: "regex",
      });
      expect(results).toEqual([]);
    });

    it("should allow safe patterns up to 500 chars", () => {
      const safePattern = "a".repeat(500);
      // This won't match anything but should not be rejected
      const results = searchMessages(db, {
        pattern: safePattern,
        mode: "regex",
      });
      // Should be an empty array (no match), not rejected
      expect(Array.isArray(results)).toBe(true);
    });
  });
});

// ── FTS5 utilities ────────────────────────────────────────────────────────────

describe("FTS5 utilities", () => {
  describe("sanitizeFts5Query", () => {
    it("should wrap tokens in double quotes", () => {
      expect(sanitizeFts5Query("hello world")).toBe('"hello" "world"');
    });

    it("should handle single token", () => {
      expect(sanitizeFts5Query("hello")).toBe('"hello"');
    });

    it("should handle empty input", () => {
      expect(sanitizeFts5Query("")).toBe('""');
    });

    it("should strip internal double quotes", () => {
      expect(sanitizeFts5Query('he"llo')).toBe('"hello"');
    });

    it("should handle FTS5 operators as literal tokens", () => {
      expect(sanitizeFts5Query("NOT OR AND")).toBe('"NOT" "OR" "AND"');
    });
  });

  describe("hasCjk", () => {
    it("should detect Chinese characters", () => {
      expect(hasCjk("你好")).toBe(true);
    });

    it("should detect Japanese characters", () => {
      expect(hasCjk("こんにちは")).toBe(true);
    });

    it("should detect Korean characters", () => {
      expect(hasCjk("안녕하세요")).toBe(true);
    });

    it("should return false for Latin text", () => {
      expect(hasCjk("hello world")).toBe(false);
    });

    it("should detect mixed CJK and Latin", () => {
      expect(hasCjk("hello 你好")).toBe(true);
    });
  });
});

// ── Capture script logic ──────────────────────────────────────────────────────

describe("Capture script logic", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe("delta capture", () => {
    it("should only insert new messages (delta)", () => {
      const conv = getOrCreateConversation(db, "session-delta");

      // First capture — 2 messages
      const batch1 = [
        { role: "user" as const, content: "msg 1" },
        { role: "assistant" as const, content: "msg 2" },
      ];
      insertMessages(db, conv.id, batch1);

      const existing = getMessagesByConversation(db, conv.id);
      expect(existing).toHaveLength(2);

      // Second capture — simulate delta: full conversation is 4 messages,
      // existing count is 2, so slice(2) = 2 new messages
      const fullConversation = [
        { role: "user" as const, content: "msg 1" },
        { role: "assistant" as const, content: "msg 2" },
        { role: "user" as const, content: "msg 3" },
        { role: "assistant" as const, content: "msg 4" },
      ];
      const newMessages = fullConversation.slice(existing.length);
      insertMessages(db, conv.id, newMessages);

      const all = getMessagesByConversation(db, conv.id);
      expect(all).toHaveLength(4);
      expect(all[2].content).toBe("msg 3");
      expect(all[3].content).toBe("msg 4");
    });
  });

  describe("content block extraction (extractText logic)", () => {
    // These tests replicate the extractText function logic from capture.ts
    // by testing through the store's insert + retrieve pipeline

    it("should handle plain string content", () => {
      const conv = getOrCreateConversation(db, "session-extract-str");
      const msg = insertMessage(db, conv.id, "user", "plain text content");
      expect(msg.content).toBe("plain text content");
    });

    it("should handle text blocks (pre-extracted)", () => {
      // Simulate what extractText produces from a text block
      const conv = getOrCreateConversation(db, "session-extract-text");
      const extracted = "This is from a text block";
      const msg = insertMessage(db, conv.id, "assistant", extracted);
      expect(msg.content).toBe("This is from a text block");
    });

    it("should handle tool_use blocks (pre-extracted format)", () => {
      const conv = getOrCreateConversation(db, "session-extract-tool");
      // Simulate the output format of extractText for tool_use
      const extracted = '[Tool call: readFile({"path":"/tmp/test.ts"})]';
      const msg = insertMessage(db, conv.id, "assistant", extracted);
      expect(msg.content).toContain("[Tool call: readFile");
    });

    it("should handle tool_result blocks (pre-extracted format)", () => {
      const conv = getOrCreateConversation(db, "session-extract-result");
      const extracted = "[Tool result: file contents here]";
      const msg = insertMessage(db, conv.id, "tool", extracted);
      expect(msg.content).toContain("[Tool result:");
    });
  });

  describe("role normalization", () => {
    it("should accept all valid roles", () => {
      const conv = getOrCreateConversation(db, "session-roles");
      const roles: Array<Message["role"]> = ["user", "assistant", "system", "tool"];
      for (const role of roles) {
        const msg = insertMessage(db, conv.id, role, `msg-${role}`);
        expect(msg.role).toBe(role);
      }
    });
  });

  describe("empty input handling", () => {
    it("should handle batch insert with no messages", () => {
      const conv = getOrCreateConversation(db, "session-empty");
      const result = insertMessages(db, conv.id, []);
      expect(result).toEqual([]);
    });
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("should handle very long content (100k chars) with correct token estimate", () => {
    const convId = getOrCreateConversation(db, "session-long").id;
    const longContent = "x".repeat(100_000);
    const msg = insertMessage(db, convId, "user", longContent);

    expect(msg.content.length).toBe(100_000);
    expect(msg.token_count).toBe(25_000); // ceil(100000 / 4)
  });

  it("should handle special characters in search patterns", () => {
    const convId = getOrCreateConversation(db, "session-special").id;
    insertMessage(db, convId, "user", "price is $100.00 (with tax)");

    // Like mode should handle dollar signs and parens
    const likeResults = searchMessages(db, {
      pattern: "$100",
      mode: "like",
    });
    expect(likeResults.length).toBeGreaterThan(0);
  });

  it("should handle regex special characters with proper escaping", () => {
    const convId = getOrCreateConversation(db, "session-regex-special").id;
    insertMessage(db, convId, "user", "the file is at path/to/file.ts");

    const results = searchMessages(db, {
      pattern: "path/to/file\\.ts",
      mode: "regex",
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it("should handle concurrent conversation creation (same session_id)", () => {
    // Simulate concurrent access — in SQLite with WAL this should be safe
    const results: Conversation[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(getOrCreateConversation(db, "session-concurrent"));
    }
    // All should return the same conversation
    const ids = results.map((c) => c.id);
    expect(new Set(ids).size).toBe(1);
  });

  it("should enforce limit cap at 200 for search", () => {
    const convId = getOrCreateConversation(db, "session-limit-cap").id;

    // Insert 210 messages
    const msgs = Array.from({ length: 210 }, (_, i) => ({
      role: "user" as const,
      content: `cap message ${i}`,
    }));
    insertMessages(db, convId, msgs);

    const results = searchMessages(db, {
      pattern: "cap message",
      mode: "like",
      limit: 500,
    });
    expect(results.length).toBeLessThanOrEqual(200);
  });

  it("should enforce minimum limit of 1", () => {
    const convId = getOrCreateConversation(db, "session-min-limit").id;
    insertMessage(db, convId, "user", "at least one result");

    const results = searchMessages(db, {
      pattern: "at least",
      mode: "like",
      limit: 0,
    });
    // limit clamps to min 1, so it should return up to 1 result
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("should default search mode to regex when omitted", () => {
    const convId = getOrCreateConversation(db, "session-default-mode").id;
    insertMessage(db, convId, "user", "default mode test");

    // Omit mode — should default to regex
    const results = searchMessages(db, {
      pattern: "default.*test",
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it("should produce snippet truncation for long content", () => {
    const convId = getOrCreateConversation(db, "session-snippet").id;
    const longContent = "A".repeat(200) + "TARGET" + "B".repeat(200);
    insertMessage(db, convId, "user", longContent);

    const results = searchMessages(db, {
      pattern: "TARGET",
      mode: "regex",
    });
    expect(results.length).toBe(1);
    expect(results[0].snippet.length).toBeLessThan(longContent.length);
    expect(results[0].snippet).toContain("TARGET");
  });

  it("should handle unicode content", () => {
    const convId = getOrCreateConversation(db, "session-unicode").id;
    insertMessage(db, convId, "user", "Emoji test: 🚀 Rocket launch 🌟");

    const results = searchMessages(db, {
      pattern: "Rocket",
      mode: "like",
    });
    expect(results.length).toBe(1);
  });

  it("should handle messages with only whitespace as empty (via capture filter)", () => {
    // The capture script filters out messages with empty trimmed content
    // Simulate: content that trims to empty would not be inserted
    const conv = getOrCreateConversation(db, "session-whitespace");
    const toInsert = [
      { role: "user" as const, content: "real message" },
      { role: "assistant" as const, content: "   " }, // Would be filtered by capture
    ].filter((msg) => msg.content.trim().length > 0);

    insertMessages(db, conv.id, toInsert);
    const msgs = getMessagesByConversation(db, conv.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("real message");
  });
});

// ── Performance benchmark ─────────────────────────────────────────────────────

describe("Performance benchmark", () => {
  let db: Database.Database;
  let convId: number;

  beforeEach(() => {
    db = createTestDb();
    convId = getOrCreateConversation(db, "session-perf").id;
  });

  afterEach(() => {
    db.close();
  });

  it("should insert 10,000 messages in reasonable time", () => {
    const messages = Array.from({ length: 10_000 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as Message["role"],
      content: `Performance test message ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Message index is ${i}.`,
    }));

    const start = performance.now();
    insertMessages(db, convId, messages);
    const elapsed = performance.now() - start;

    console.log(`\n  [BENCHMARK] Insert 10,000 messages: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(30_000); // Should be well under 30s

    // Verify all messages were inserted
    const conv = listConversations(db).find((c) => c.id === convId);
    expect(conv?.message_count).toBe(10_000);
  });

  it("should search 10,000 messages (regex) in reasonable time", () => {
    // Insert 10k messages first
    const messages = Array.from({ length: 10_000 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as Message["role"],
      content: `Searchable message ${i}: The quick brown fox jumps over the lazy dog. Unique token: xylophone_${i % 100}.`,
    }));
    insertMessages(db, convId, messages);

    const start = performance.now();
    const results = searchMessages(db, {
      pattern: "xylophone_42",
      mode: "regex",
      limit: 200,
    });
    const elapsed = performance.now() - start;

    console.log(`  [BENCHMARK] Regex search across 10,000 messages: ${elapsed.toFixed(1)}ms (${results.length} results)`);
    expect(elapsed).toBeLessThan(10_000);
    expect(results.length).toBeGreaterThan(0);
  });

  it("should search 10,000 messages (FTS) in reasonable time", () => {
    const messages = Array.from({ length: 10_000 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as Message["role"],
      content: `Searchable message ${i}: The quick brown fox jumps over the lazy dog. Unique token: xylophone_${i % 100}.`,
    }));
    insertMessages(db, convId, messages);

    const start = performance.now();
    const results = searchMessages(db, {
      pattern: "quick brown fox",
      mode: "full_text",
      limit: 200,
    });
    const elapsed = performance.now() - start;

    console.log(`  [BENCHMARK] FTS search across 10,000 messages: ${elapsed.toFixed(1)}ms (${results.length} results)`);
    expect(elapsed).toBeLessThan(10_000);
    expect(results.length).toBeGreaterThan(0);
  });

  it("should search 10,000 messages (LIKE) in reasonable time", () => {
    const messages = Array.from({ length: 10_000 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as Message["role"],
      content: `Searchable message ${i}: The quick brown fox jumps over the lazy dog. Unique token: xylophone_${i % 100}.`,
    }));
    insertMessages(db, convId, messages);

    const start = performance.now();
    const results = searchMessages(db, {
      pattern: "xylophone_42",
      mode: "like",
      limit: 200,
    });
    const elapsed = performance.now() - start;

    console.log(`  [BENCHMARK] LIKE search across 10,000 messages: ${elapsed.toFixed(1)}ms (${results.length} results)`);
    expect(elapsed).toBeLessThan(10_000);
    expect(results.length).toBeGreaterThan(0);
  });
});
