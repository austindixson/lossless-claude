import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve, normalize, isAbsolute } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DB_PATH = resolve(homedir(), ".claude", "recall.db");

let db: Database.Database | null = null;
let currentPath: string | null = null;

/** Validate that the database path is safe (within home directory). */
function validateDbPath(candidate: string): string {
  const normalized = normalize(candidate);

  // Allow absolute paths only within home directory
  if (isAbsolute(normalized)) {
    const homeDir = homedir();
    if (!normalized.startsWith(homeDir)) {
      throw new Error(`DB path must be within home directory: ${candidate}`);
    }
  }

  // Reject relative paths with parent directory traversal
  if (normalized.includes("..")) {
    throw new Error(`DB path cannot contain parent references: ${candidate}`);
  }

  return normalized;
}

export function getDb(dbPath?: string): Database.Database {
  const rawPath = dbPath ?? process.env.RECALL_DB_PATH ?? DEFAULT_DB_PATH;
  const resolvedPath = validateDbPath(rawPath);

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
