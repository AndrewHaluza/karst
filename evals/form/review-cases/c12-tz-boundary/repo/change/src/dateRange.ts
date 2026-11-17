export interface DateRange {
  /** First day, as YYYY-MM-DD. */
  start: string;
  /** Last day, as YYYY-MM-DD. The last day is included. */
  end: string;
}

export function isInRange(range: DateRange, when: Date): boolean {
  const start = new Date(range.start);
  const end = new Date(range.end);
  return when >= start && when <= end;
}
