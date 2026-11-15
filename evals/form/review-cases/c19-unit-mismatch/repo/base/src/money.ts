/** Prices are stored as integer cents. */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
