/** Small shared helpers. */

/** Parse a JSON column from the server defensively — one malformed field
 *  must not blank the whole view (pattern from store's grad()/parseApps). */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
