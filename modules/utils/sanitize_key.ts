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
