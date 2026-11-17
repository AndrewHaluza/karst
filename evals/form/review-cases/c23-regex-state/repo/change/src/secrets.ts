const SECRET_PATTERN = /(api[_-]?key|token|password)\s*[:=]/gi;

/** True when the line looks like it assigns a secret. */
export function looksLikeSecret(line: string): boolean {
  return SECRET_PATTERN.test(line);
}

/** The 1-based numbers of the lines that look like they assign a secret. */
export function findSecretLines(text: string): number[] {
  return text.split('\n').flatMap((line, i) => (looksLikeSecret(line) ? [i + 1] : []));
}
