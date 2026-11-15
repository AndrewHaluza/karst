/** Parse a numeric id from a path segment. Returns null when the text is not a positive integer. */
export function parseId(text: string): number | null {
  if (!/^[0-9]+$/.test(text)) return null;
  const id = Number(text);
  return id > 0 ? id : null;
}
