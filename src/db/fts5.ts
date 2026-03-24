/**
 * Sanitize a user-provided query for use in an FTS5 MATCH expression.
 *
 * FTS5 treats certain characters as operators (`-`, `+`, `*`, `^`, `:`,
 * `"`, `(`, `)`, `OR`, `AND`, `NOT`, `NEAR`). Wrapping each whitespace-
 * delimited token in double quotes forces FTS5 to treat it as a literal
 * phrase token. Internal double quotes are stripped, empty tokens dropped.
 * Tokens are joined with spaces (implicit AND).
 */
export function sanitizeFts5Query(raw: string): string {
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}

/** Detect CJK characters — FTS5 unicode61 tokenizer can't segment them properly. */
export function hasCjk(text: string): boolean {
  return /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(text);
}
