import type Database from "better-sqlite3";
import { searchMessages, type SearchOptions } from "../store.js";

export function handleRecallGrep(db: Database.Database, args: Record<string, unknown>): string {
  const opts: SearchOptions = {
    pattern: String(args.pattern ?? ""),
    mode: (args.mode as SearchOptions["mode"]) ?? "regex",
    conversationId: typeof args.conversation_id === "number" ? args.conversation_id : undefined,
    since: typeof args.since === "string" ? args.since : undefined,
    before: typeof args.before === "string" ? args.before : undefined,
    limit: typeof args.limit === "number" ? Math.min(args.limit, 200) : 50,
  };

  if (!opts.pattern) {
    return JSON.stringify({ error: "pattern is required" });
  }

  const results = searchMessages(db, opts);
  return JSON.stringify({
    count: results.length,
    results,
  });
}
