import type Database from "better-sqlite3";
import { getMessage, getMessagesByConversation } from "../store.js";

export function handleRecallDescribe(db: Database.Database, args: Record<string, unknown>): string {
  // Mode 1: fetch a single message by ID
  if (typeof args.message_id === "number") {
    const msg = getMessage(db, args.message_id);
    if (!msg) return JSON.stringify({ error: `Message ${args.message_id} not found` });
    return JSON.stringify(msg);
  }

  // Mode 2: fetch a range of messages from a conversation
  if (typeof args.conversation_id === "number") {
    const convId = args.conversation_id;
    const seqStart = typeof args.seq_start === "number" ? args.seq_start : undefined;
    const seqEnd = typeof args.seq_end === "number" ? args.seq_end : undefined;

    let messages = getMessagesByConversation(db, convId);

    if (seqStart !== undefined) {
      messages = messages.filter((m) => m.seq >= seqStart);
    }
    if (seqEnd !== undefined) {
      messages = messages.filter((m) => m.seq <= seqEnd);
    }

    return JSON.stringify({
      conversation_id: convId,
      count: messages.length,
      messages,
    });
  }

  return JSON.stringify({ error: "Provide message_id or conversation_id" });
}
