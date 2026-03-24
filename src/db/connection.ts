import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DB_PATH = resolve(homedir(), ".claude", "recall.db");

let db: Database.Database | null = null;
let currentPath: string | null = null;

export function getDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? process.env.RECALL_DB_PATH ?? DEFAULT_DB_PATH;

  if (db && currentPath === resolvedPath) return db;
  if (db) db.close();

  mkdirSync(dirname(resolvedPath), { recursive: true });

  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  currentPath = resolvedPath;

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    currentPath = null;
  }
}
