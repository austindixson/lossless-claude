#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getDb, closeDb } from "./db/connection.js";
import { runMigrations } from "./db/migration.js";
import { handleRecallGrep } from "./tools/recall-grep.js";
import { handleRecallDescribe } from "./tools/recall-describe.js";
import { handleRecallSessions } from "./tools/recall-sessions.js";

// Initialize DB on startup
const db = getDb();
runMigrations(db);

const server = new Server(
  { name: "lossless-recall", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Tool definitions — will be filled in by tool modules
// For now, define the schemas inline. Tools will be implemented in src/tools/

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "recall_grep",
      description: "Search across all conversation history by regex, full-text, or keyword. Use this to find specific messages, decisions, errors, or any detail from past conversations that Claude Code's compaction may have lost.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pattern: { type: "string", description: "Search pattern (regex by default, or keywords for full_text mode)" },
          mode: { type: "string", enum: ["regex", "full_text", "like"], description: "Search mode (default: regex)" },
          conversation_id: { type: "number", description: "Scope search to a specific conversation ID" },
          since: { type: "string", description: "ISO timestamp lower bound (e.g., 2026-03-20T00:00:00Z)" },
          before: { type: "string", description: "ISO timestamp upper bound" },
          limit: { type: "number", description: "Max results (default 50, max 200)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "recall_describe",
      description: "Fetch the full content of a specific message by ID, or all messages in a conversation within a sequence range. Use when recall_grep found a relevant snippet and you need the complete context.",
      inputSchema: {
        type: "object" as const,
        properties: {
          message_id: { type: "number", description: "Specific message ID to retrieve" },
          conversation_id: { type: "number", description: "Conversation to retrieve messages from" },
          seq_start: { type: "number", description: "Starting sequence number (inclusive)" },
          seq_end: { type: "number", description: "Ending sequence number (inclusive)" },
        },
      },
    },
    {
      name: "recall_sessions",
      description: "List all recorded conversation sessions with message counts, date ranges, and titles. Use to discover what conversation history is available for search.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Max sessions to return (default 20)" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Tool dispatch — implementations will be imported from src/tools/
  // For now, stub responses so the server starts
  try {
    switch (name) {
      case "recall_grep": {
        const result = handleRecallGrep(db, args ?? {});
        return { content: [{ type: "text", text: result }] };
      }
      case "recall_describe": {
        const result = handleRecallDescribe(db, args ?? {});
        return { content: [{ type: "text", text: result }] };
      }
      case "recall_sessions": {
        const result = handleRecallSessions(db, args ?? {});
        return { content: [{ type: "text", text: result }] };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    // Log detailed error for debugging
    console.error("[lossless-recall] Tool error:", error);
    // Return generic message to client
    return {
      content: [{ type: "text", text: "An internal error occurred. Check server logs for details." }],
      isError: true,
    };
  }
});

// Graceful shutdown
process.on("SIGINT", () => { closeDb(); process.exit(0); });
process.on("SIGTERM", () => { closeDb(); process.exit(0); });

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
