/**
 * The closed list of gh output texts that mean "GitHub itself failed", so the
 * same request can succeed a little later. Nothing else is a server error: an
 * auth, validation, or "already exists" refusal fails the same way on retry,
 * and a wait would only hide it. A text that gh rewords is a miss, and a miss
 * only restores the loud failure that ship had before.
 */
export const GITHUB_SERVER_ERROR_PATTERNS: readonly RegExp[] = [
  /\bHTTP 5\d\d\b/,
  /Something went wrong while executing your query/i,
  /\b502 Bad Gateway\b/i,
  /\b503 Service Unavailable\b/i,
  /\b504 Gateway Time-?out\b/i,
];

/** True when `text` (gh's stderr, or an error message that holds it) matches the closed list. */
export function isGitHubServerError(text: string): boolean {
  return GITHUB_SERVER_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}
