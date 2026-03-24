#!/usr/bin/env node

/**
 * Capture hook for lossless-recall.
 * Runs as a Claude Code Stop hook to persist conversation turns to SQLite.
 *
 * Usage: echo '{"session_id":"...","conversation":[...]}' | tsx src/capture.ts
 * Or as a hook: the hook runner pipes stdin.
 */

import { getDb, closeDb } from "./db/connection.js";
import { runMigrations } from "./db/migration.js";
import {
  getOrCreateConversation,
  insertMessages,
  getMessagesByConversation,
} from "./store.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  content?: string;
  // tool_use blocks
  name?: string;
  input?: unknown;
  // tool_result blocks
  tool_use_id?: string;
  output?: string;
}

interface HookMessage {
  role: string;
  content: string | ContentBlock[];
}

interface HookInput {
  session_id: string;
  conversation?: HookMessage[];
}

// ── Content extraction ───────────────────────────────────────────────────────

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push(`[Tool call: ${block.name}(${JSON.stringify(block.input)})]`);
    } else if (block.type === "tool_result") {
      const output = block.output ?? block.content ?? block.text ?? "";
      parts.push(`[Tool result: ${output}]`);
    } else if (block.text) {
      parts.push(block.text);
    } else if (block.content) {
      parts.push(
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content),
      );
    }
  }
  return parts.join("\n");
}

function normalizeRole(
  role: string,
): "user" | "assistant" | "system" | "tool" {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return "system";
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Read stdin with size limit to prevent OOM
  const MAX_STDIN_SIZE = 10 * 1024 * 1024; // 10MB
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of process.stdin) {
    totalSize += chunk.length;
    if (totalSize > MAX_STDIN_SIZE) {
      console.error("[lossless-recall] Stdin exceeds 10MB limit");
      process.exit(1);
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();

  if (!raw) {
    process.exit(0); // No input, nothing to do
  }

  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    console.error("[lossless-recall] Failed to parse stdin as JSON");
    process.exit(1);
  }

  if (!input.session_id || !input.conversation?.length) {
    process.exit(0); // Nothing to store
  }

  const db = getDb();
  runMigrations(db);

  try {
    const conv = getOrCreateConversation(db, input.session_id);

    // Get existing message count to determine delta offset
    const existing = getMessagesByConversation(db, conv.id);
    const existingCount = existing.length;

    // Only insert NEW messages (delta since last capture)
    const newMessages = input.conversation.slice(existingCount);

    if (newMessages.length === 0) {
      return; // Already up to date
    }

    const toInsert = newMessages
      .map((msg) => ({
        role: normalizeRole(msg.role),
        content: extractText(msg.content),
      }))
      .filter((msg) => msg.content.trim().length > 0);

    if (toInsert.length > 0) {
      insertMessages(db, conv.id, toInsert);
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error("[lossless-recall] Capture error:", err);
  process.exit(1);
});
