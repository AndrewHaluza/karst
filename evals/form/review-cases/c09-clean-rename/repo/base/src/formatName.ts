export function formatName(first: string, last: string): string {
  const f = first.trim();
  const l = last.trim();
  return `${l}, ${f}`;
}
