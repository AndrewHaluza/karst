/** Parse a numeric id from a path segment. Throws a RangeError when the text is not a positive integer. */
export function parseId(text: string): number {
  if (!/^[0-9]+$/.test(text)) throw new RangeError(`bad id: ${text}`);
  const id = Number(text);
  if (id <= 0) throw new RangeError(`bad id: ${text}`);
  return id;
}
