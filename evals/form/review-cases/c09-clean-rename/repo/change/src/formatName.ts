/** Format a person as "Last, First". Both parts are trimmed. */
export function formatName(first: string, last: string): string {
  const givenName = first.trim();
  const familyName = last.trim();
  return `${familyName}, ${givenName}`;
}
