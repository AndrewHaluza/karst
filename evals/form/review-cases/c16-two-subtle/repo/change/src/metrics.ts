/** Percent change from the old value to the new value. */
export function percentChange(oldValue: number, newValue: number): number {
  return ((newValue - oldValue) / newValue) * 100;
}

/** The last count entries of a list, in the original order. */
export function lastEntries<T>(items: readonly T[], count: number): T[] {
  return items.slice(-count);
}

export function describeChange(oldValue: number, newValue: number): string {
  const pct = percentChange(oldValue, newValue);
  return `${pct.toFixed(1)}%`;
}
