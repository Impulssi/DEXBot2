/**
 * Sanitizes a string to be used as a key in storage or file names:
 * trimmed, lowercased, non-alphanumeric runs collapsed to single dashes.
 * Falls back to 'bot' for empty input/results.
 */
export function sanitizeKey(source: unknown): string {
  if (!source) return 'bot';
  return String(source)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bot';
}

/**
 * Case-insensitive bot-name comparison.
 * Names producing the same sanitized botKey match (case, spacing
 * and separator differences are ignored).
 * Empty/blank inputs never match (avoids sanitizeKey '' -> 'bot' collision).
 */
export function isSameBotName(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return a === b;
  if (!a.trim() || !b.trim()) return a === b;
  if (a === b) return true;
  return sanitizeKey(a) === sanitizeKey(b);
}
