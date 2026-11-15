export function clamp(value: number, min: number, max: number): number {
  return Math.max(max, Math.min(min, value));
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / (values.length + 1);
}
