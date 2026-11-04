---
name: lossless-recall
description: Lossless conversation recall for Claude Code — MCP server that captures every turn to SQLite and provides full-text search across all session history. Use when you need to find specific messages, decisions, errors, or details that Claude Code's auto-compaction may have lost.
version: 0.1.0
source: https://github.com/austindixson/lossless-claude
---

# Lossless Recall

MCP server for Claude Code that captures every conversation turn to SQLite with full-text search. Nothing is ever lost — every message from every session is persisted and searchable, even after Claude Code's auto-compaction compresses your context.

## When to Activate

Use this skill when:

- You need to recall details from earlier in a conversation that may have been compacted
- Searching for specific error messages, decisions, or commands from past sessions
- Setting up, configuring, or troubleshooting the lossless-recall MCP server
- You want to find what was discussed across multiple sessions

## Architecture

```
Claude Code ──▶ Stop Hook ──▶ capture.ts ──▶ SQLite (recall.db)
     │                                           ▲
     └──────▶ MCP Server ──▶ recall_* tools ─────┘
```

- **Capture**: Stop hook fires after every turn, delta-captures new messages to SQLite
- **Store**: SQLite with WAL mode, FTS5 full-text index, busy_timeout for concurrent access
- **Search**: 3 MCP tools exposed to Claude for searching and retrieving history

## Installation

```bash
# Clone and build
git clone https://github.com/austindixson/lossless-claude.git
cd lossless-claude
npm install && npm run build

# Register MCP server with Claude Code
claude mcp add lossless-recall --transport stdio -- node /path/to/lossless-claude/dist/server.js

# Or run the installer
./install.sh
```

### Hook Setup

Add a Stop hook to capture conversations automatically. In your Claude Code settings:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/lossless-claude/dist/capture.js"
          }
        ]
      }
    ]
  }
}
```

## MCP Tools

### recall_grep

Search across all conversation history by regex, full-text, or keyword.

```
recall_grep(pattern: "database migration", mode: "full_text")
recall_grep(pattern: "error.*SQLITE", mode: "regex")
recall_grep(pattern: "deployment", since: "2026-03-20T00:00:00Z")
recall_grep(pattern: "auth fix", conversation_id: 3)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pattern` | string | (required) | Search pattern |
| `mode` | string | `"regex"` | `regex`, `full_text`, or `like` |
| `conversation_id` | number | all | Scope to one conversation |
| `since` | string | - | ISO timestamp lower bound |
| `before` | string | - | ISO timestamp upper bound |
| `limit` | number | 50 | Max results (cap: 200) |

**Search modes:**
- **regex** — JavaScript RegExp against message content (default, most flexible)
- **full_text** — FTS5 full-text search with ranking (fastest for keyword queries)
- **like** — Simple `LIKE '%pattern%'` (fallback, always works)

FTS5 automatically falls back to LIKE for CJK text or when unavailable.

### recall_describe

Fetch full message content by ID or conversation sequence range.

```
recall_describe(message_id: 42)
recall_describe(conversation_id: 1, seq_start: 10, seq_end: 20)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `message_id` | number | Specific message ID |
| `conversation_id` | number | Conversation to retrieve from |
| `seq_start` | number | Starting sequence (inclusive) |
| `seq_end` | number | Ending sequence (inclusive) |

### recall_sessions

List all recorded conversation sessions.

```
recall_sessions()
recall_sessions(limit: 10)
```

Returns: session ID, title, message count, created/updated timestamps.

## Usage Pattern

**Escalation: sessions → grep → describe**

1. `recall_sessions` — See what history exists
2. `recall_grep` — Find relevant messages by pattern
3. `recall_describe` — Get full content of matches

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `RECALL_DB_PATH` | `~/.claude/recall.db` | SQLite database location |

## Database

SQLite with WAL mode, stored at `~/.claude/recall.db`.

**Tables:**
- `conversations` — session_id (unique), title, message_count, timestamps
- `messages` — conversation FK, seq, role, content, token_count, timestamps
- `messages_fts` — FTS5 virtual table for full-text search (optional, graceful fallback)

**Inspect:**
```bash
sqlite3 ~/.claude/recall.db "SELECT id, session_id, message_count FROM conversations;"
sqlite3 ~/.claude/recall.db "SELECT COUNT(*) FROM messages;"
```

**Backup:**
```bash
cp ~/.claude/recall.db ~/.claude/recall.db.backup
```

## How Capture Works

The Stop hook receives the conversation via stdin, then:
1. Parses messages (handles both string and array content blocks)
2. Finds or creates the conversation by session_id
3. Computes delta — only inserts messages after the last known seq
4. Batch-inserts in a single transaction with FTS5 indexing
5. Re-running is idempotent — no duplicates

Content blocks (`tool_use`, `tool_result`, `text`) are normalized to readable text.

## Project Structure

```
src/
  server.ts              # MCP server entry — stdio transport, tool schemas
  store.ts               # CRUD + search (regex/FTS5/LIKE) — all synchronous
  capture.ts             # Stop hook — stdin → delta capture → SQLite
  db/
    connection.ts        # Singleton better-sqlite3, WAL, busy_timeout
    migration.ts         # Schema DDL + FTS5 (graceful fallback)
    fts5.ts              # Query sanitizer + CJK detection
  tools/
    recall-grep.ts       # Search dispatcher
    recall-describe.ts   # Message/range retrieval
    recall-sessions.ts   # Conversation listing
```

## Development

```bash
npm run build          # Compile TypeScript
npm run dev            # Watch mode
npx tsc --noEmit       # Type check only
npm test               # Run tests (vitest)
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Server not connecting | Run `claude /mcp` to check status, verify path in MCP config |
| No messages captured | Verify Stop hook is configured, test with `echo '{"session_id":"test","conversation":[{"role":"user","content":"hi"}]}' \| node dist/capture.js` |
| FTS5 not available | Falls back to LIKE automatically. Build Node with `SQLITE_ENABLE_FTS5` for full FTS |
| SQLITE_BUSY | Plugin sets `busy_timeout=5000`. Check for external concurrent writes |
| Duplicate messages | Should not happen — capture is idempotent via delta detection |
