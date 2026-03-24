import type Database from "better-sqlite3";
import { listConversations } from "../store.js";

export function handleRecallSessions(db: Database.Database, args: Record<string, unknown>): string {
  const conversations = listConversations(db);
  const limit = typeof args.limit === "number" ? Math.min(args.limit, 100) : 20;
  const limited = conversations.slice(0, limit);

  return JSON.stringify({
    count: limited.length,
    total: conversations.length,
    sessions: limited.map((c) => ({
      id: c.id,
      session_id: c.session_id,
      title: c.title,
      message_count: c.message_count,
      created_at: c.created_at,
      updated_at: c.updated_at,
    })),
  });
}
